import type { Archetype, DirtyView } from './archetype';
import type { Chunks } from './chunk';
import type { Column } from './column';
import { ApecsError, callSite, warnOnce } from './debug';
import type { Entity } from './entity';
import type { EntityIndex } from './entity-index';
import type { Iteration } from './iteration';
import type { View } from './materialized';
import type { QueryCache, QueryPlan, QueryResult } from './query';
import type { Field } from './schema';
import { sortByKey } from './sort';
import type { DirtyLevel } from './sorted';
import { $archetypes, $plan, $terms, $view } from './symbols';
import type { Ticks } from './ticks';
import type { Term } from './terms';
import type { EachFn } from './types';

/**
 * The order behind `orderBy`: not a side array but the archetype rows
 * themselves, permuted into key order on access. Dirty tracking is the
 * `SortedView` pair — the structural flag flipped by the archetypes and the
 * key columns' `lastWriteTick` — and a clean frame costs only that check.
 * The permutation is not kept: the data is left in order, so the next sort
 * starts from the identity over rows that are already sorted (SPEC §6.8).
 */
export class OrderedView implements DirtyView {
  readonly archetypes: readonly Archetype[];
  /** Flipped by the archetypes on any row change, and by a permute of another view. */
  public structuralDirty = true;
  /** `structural` counts rebuilds; `value` is the tick of the last sort. */
  readonly stamp = { structural: 0, value: -1 };
  /** Archetypes whose rows a permute actually moved; an identity costs none. */
  public permutes = 0;

  readonly field: Field;
  readonly descending: boolean;

  /** The key column of each matching archetype, parallel to `archetypes`. */
  readonly #columns: Column[] = [];
  /**
   * Ascending by `sign * key` in row order puts the first key in the last
   * row, which is where the back-to-front walk begins (SPEC §6.8, §9).
   */
  readonly #sign: number;
  /** Scratch for one archetype at a time: extracted keys and the permutation. */
  #keys = new Float64Array(0);
  readonly #order: number[] = [];
  readonly #entities: EntityIndex;
  readonly #ticks: Ticks;
  readonly #iteration: Iteration;
  /** Dev: where `orderBy` was called, for the once-per-site warnings. */
  readonly #site: string;

  public constructor(
    archetypes: readonly Archetype[],
    field: Field,
    descending: boolean,
    cache: QueryCache,
    site: string,
  ) {
    this.archetypes = archetypes;
    this.field = field;
    this.descending = descending;
    this.#sign = descending ? 1 : -1;
    this.#entities = cache.entities;
    this.#ticks = cache.ticks;
    this.#iteration = cache.iteration;
    this.#site = site;
    for (let i = 0; i < archetypes.length; i++) {
      this.watch(archetypes[i]);
    }
  }

  /** Registers on an archetype that joined the matching list; it joins empty. */
  public watch(archetype: Archetype): void {
    const views = archetype.sortedViews;
    if (__DEV__) {
      for (let i = 0; i < views.length; i++) {
        const other = views[i];
        if (
          other instanceof OrderedView &&
          (other.field !== this.field || other.descending !== this.descending)
        ) {
          warnOnce(
            this.#site,
            `orderBy(${this.field.key}${this.descending ? ", 'desc'" : ''}) and ` +
              `orderBy(${other.field.key}${other.descending ? ", 'desc'" : ''}) share an ` +
              'archetype — each access reorders its rows for itself, so they thrash (SPEC §6.8)',
          );
          break;
        }
      }
    }
    views.push(this);
    this.#columns.push(archetype.column(this.field)!);
  }

  public unwatch(): void {
    const archetypes = this.archetypes;
    for (let i = 0; i < archetypes.length; i++) {
      const views = archetypes[i].sortedViews;
      const at = views.indexOf(this);
      if (at >= 0) {
        views.splice(at, 1);
      }
    }
    this.#columns.length = 0;
  }

  /** Conservative at tick granularity, exactly as for `SortedView` (SPEC §6.7). */
  public get valueDirty(): boolean {
    const stamp = this.stamp.value;
    const columns = this.#columns;
    for (let i = 0; i < columns.length; i++) {
      if (columns[i].lastWriteTick >= stamp) {
        return true;
      }
    }
    return false;
  }

  public get level(): DirtyLevel {
    return this.structuralDirty ? 'rebuild' : this.valueDirty ? 'resort' : 'clean';
  }

  /**
   * Brings the rows into key order. Called by every access of the result, so
   * the frame it is called from is the one the warning names. A permute is
   * structural for every row at once, so under an open walk it does not
   * happen: dev throws, production serves the stale order (SPEC §6.8, §9).
   */
  public ensure(): void {
    if (__DEV__ && this.archetypes.length > 1) {
      warnOnce(
        callSite(2),
        `orderBy(${this.field.key}) matches ${this.archetypes.length} archetypes — rows are in ` +
          'key order within each archetype, not across them; use sortBy() for a total order (SPEC §6.8)',
      );
    }
    if (!this.structuralDirty && !this.valueDirty) {
      return;
    }
    if (this.#iteration.depth !== 0) {
      if (__DEV__) {
        throw new ApecsError(
          'an ordered query cannot reorder storage inside a walk — ' +
            'access it before the walk begins, or world.defer() it (SPEC §6.8, §9)',
        );
      }
      return;
    }
    this.#apply();
  }

  public invalidate(): void {
    this.stamp.value = -1;
  }

  #apply(): void {
    const structural = this.structuralDirty;
    const { archetypes } = this;
    const columns = this.#columns;
    const order = this.#order;
    for (let a = 0; a < archetypes.length; a++) {
      const archetype = archetypes[a];
      const rows = archetype.rows;
      if (rows < 2) {
        continue;
      }
      const keys = this.#extract(columns[a], archetype, rows);
      identity(order, rows);
      sortByKey(order, keys);
      if (archetype.permute(order, this.#entities)) {
        this.permutes++;
      }
    }
    // A permute flags every view on the archetype, this one included.
    this.structuralDirty = false;
    if (structural) {
      this.stamp.structural++;
    }
    this.stamp.value = this.#ticks.tick;
  }

  /** One linear pass over the key column, in row order. */
  #extract(column: Column, archetype: Archetype, rows: number): Float64Array {
    let keys = this.#keys;
    if (keys.length < rows) {
      keys = this.#keys = new Float64Array(Math.max(rows, keys.length * 2));
    }
    const { pageSize } = archetype;
    const pages = column.pages;
    const sign = this.#sign;
    for (let page = 0, at = 0; at < rows; page++) {
      const data = pages[page] as ArrayLike<number>;
      const n = Math.min(pageSize, rows - at);
      for (let i = 0; i < n; i++) {
        keys[at++] = sign * data[i];
      }
    }
    return keys;
  }
}

/** `order = [0 … n)`, shrinking or growing in place so the array stays packed. */
function identity(order: number[], n: number): void {
  if (order.length > n) {
    order.length = n;
  }
  for (let i = 0; i < order.length; i++) {
    order[i] = i;
  }
  for (let i = order.length; i < n; i++) {
    order.push(i);
  }
}

/**
 * The base query with its rows in key order: `ensure()` then delegate, so
 * `chunks` is the base's chunk walk with nothing added to the chunk path
 * (SPEC §6.8).
 */
export class OrderedQueryResult<T extends readonly Term[] = readonly Term[]> implements View {
  declare readonly [$view]: OrderedView;
  declare readonly [$plan]: QueryPlan;
  declare readonly [$terms]: readonly Term[];

  readonly #base: QueryResult<T>;
  readonly #forget: () => void;

  /**
   * `base` owns the archetype list — the query narrowed to entities that carry
   * the key trait, or the query itself. `forget` drops the memo entry on dispose.
   */
  public constructor(
    base: QueryResult<T>,
    field: Field,
    descending: boolean,
    cache: QueryCache,
    site: string,
    forget: () => void,
  ) {
    this[$view] = new OrderedView(base[$archetypes], field, descending, cache, site);
    this[$plan] = base[$plan];
    this[$terms] = base[$terms];
    this.#base = base;
    this.#forget = forget;
    base.attach(this);
  }

  public get count(): number {
    return this.#base.count;
  }

  public get isEmpty(): boolean {
    return this.#base.isEmpty;
  }

  public get first(): Entity | undefined {
    this[$view].ensure();
    return this.#base.first;
  }

  /** The work the next access pays (SPEC §6.7, §6.8). Reading it does none of it. */
  public get isDirty(): DirtyLevel {
    return this[$view].level;
  }

  /** Forces a resort on the next access — for keys apecs cannot see change. */
  public invalidate(): void {
    this[$view].invalidate();
  }

  /** Forces a full rebuild on the next access. */
  public rebuild(): void {
    this[$view].structuralDirty = true;
  }

  public [Symbol.iterator](): Iterator<Entity> {
    this[$view].ensure();
    return this.#base[Symbol.iterator]();
  }

  /** An ordered copy, safe to drive structural change with (SPEC §9). */
  public entities(): Float64Array {
    this[$view].ensure();
    return this.#base.entities();
  }

  public each(fn: EachFn<T>): void {
    this[$view].ensure();
    this.#base.each(fn);
  }

  public chunks(): Chunks {
    this[$view].ensure();
    return this.#base.chunks();
  }

  public dispose(): void {
    this[$view].unwatch();
    this.#base.detach(this);
    this.#forget();
  }

  /** @internal */
  public admit(archetype: Archetype): void {
    this[$view].watch(archetype);
  }

  /** @internal The base owns the cursors; nothing here to re-slot. */
  public retrack(): void {}
}
