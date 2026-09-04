import type { Archetype } from './archetype';
import type { Column } from './column';
import { ApecsError } from './debug';
import type { Entity } from './entity';
import { ListWalk, type View } from './materialized';
import type { QueryCache, QueryPlan, QueryResult } from './query';
import type { Field } from './schema';
import { sortByKey } from './sort';
import { $archetypes, $plan, $terms, $view } from './symbols';
import { TargetIndex } from './targets';
import type { Term } from './terms';
import type { Ticks } from './ticks';
import type { Trait } from './trait';
import type { EachFn } from './types';

export type Comparator = (a: Entity, b: Entity) => number;
export type DirtyLevel = 'clean' | 'resort' | 'rebuild';
/** A numeric field, a comparator, or a relation's depth table for `Cascade` (SPEC §6.7, §7.6). */
export type SortKey = Field | Comparator | TargetIndex;

/**
 * The memoised order behind a sorted query. Every matching archetype holds it
 * in `sortedViews` and flips `structuralDirty` on a row insert or removal;
 * value changes are read off the key columns' `lastWriteTick` on access.
 * Between the two, a frame in which nothing moved costs a handful of compares
 * (SPEC §6.7).
 */
export class SortedView {
  readonly archetypes: readonly Archetype[];
  /** Flipped by the archetypes; a rebuild is the only thing that clears it. */
  public structuralDirty = true;
  /** `structural` counts rebuilds; `value` is the tick of the last sort. */
  readonly stamp = { structural: 0, value: -1 };
  /** Live entries in `list`, `keys` and `entities`; the arrays keep spare capacity. */
  public length = 0;
  /** The matched entities in walk order, and the key extracted for each. */
  public list = new Float64Array(0);
  public keys = new Float64Array(0);
  /** The permutation of `list` being sorted; kept across frames so a resort is adaptive. */
  readonly order: number[] = [];
  /** `list` through `order`: the ordered result a walk reads. */
  public entities = new Float64Array(0);
  /** Walks in progress; a rebuild under one would reorder the array it is reading. */
  public walks = 0;

  readonly #field: Field | null;
  readonly #depths: TargetIndex | null;
  readonly #sign: number;
  /** The key column of each matching archetype, parallel to `archetypes`. */
  readonly #columns: Column[] = [];
  readonly #compare: ((a: number, b: number) => number) | null;
  readonly #ticks: Ticks;

  public constructor(
    archetypes: readonly Archetype[],
    key: SortKey,
    descending: boolean,
    ticks: Ticks,
  ) {
    this.archetypes = archetypes;
    this.#field = typeof key === 'function' || key instanceof TargetIndex ? null : key;
    this.#depths = key instanceof TargetIndex ? key : null;
    this.#sign = descending ? -1 : 1;
    this.#compare =
      typeof key !== 'function'
        ? null
        : (a, b) => key(this.list[a] as Entity, this.list[b] as Entity);
    this.#ticks = ticks;
    for (let i = 0; i < archetypes.length; i++) {
      this.watch(archetypes[i]);
    }
  }

  /**
   * Registers on an archetype that joined the matching list. It joins empty,
   * so its first row is what flips the structural flag.
   */
  public watch(archetype: Archetype): void {
    archetype.sortedViews.push(this);
    if (this.#field !== null) {
      this.#columns.push(archetype.column(this.#field)!);
    }
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

  /**
   * Conservative at tick granularity: a key written in the tick of the last
   * sort counts, because the scalar cannot tell a write before the sort from
   * one after it. A comparator has no column to watch and is always dirty.
   */
  public get valueDirty(): boolean {
    if (this.#compare !== null) {
      return true;
    }
    const stamp = this.stamp.value;
    if (this.#depths !== null) {
      return this.#depths.depthTick >= stamp;
    }
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

  /** Brings the order up to date and returns it; `length` bounds the live prefix. */
  public ensure(): Float64Array {
    if (this.walks === 0) {
      if (this.structuralDirty) {
        this.#rebuild();
      } else if (this.valueDirty) {
        this.#sort();
      }
    }
    return this.entities;
  }

  public invalidate(): void {
    this.stamp.value = -1;
  }

  #rebuild(): void {
    const archetypes = this.archetypes;
    let n = 0;
    for (let a = 0; a < archetypes.length; a++) {
      n += archetypes[a].rows;
    }
    if (n > this.list.length) {
      this.#grow(n);
    }

    const list = this.list;
    let at = 0;
    for (let a = archetypes.length - 1; a >= 0; a--) {
      const archetype = archetypes[a];
      for (let row = archetype.rows - 1; row >= 0; row--) {
        list[at++] = archetype.entityAt(row);
      }
    }

    // The previous permutation survives as far as it can, so a set that barely
    // changed sorts in nearly linear time and keeps its tie order.
    const order = this.order;
    const previous = order.length;
    if (n < previous) {
      let w = 0;
      for (let r = 0; r < previous; r++) {
        if (order[r] < n) {
          order[w++] = order[r];
        }
      }
      order.length = n;
    } else {
      for (let i = previous; i < n; i++) {
        order.push(i);
      }
    }

    this.length = n;
    this.structuralDirty = false;
    this.stamp.structural++;
    this.#sort();
  }

  #sort(): void {
    const order = this.order;
    if (this.#compare !== null) {
      order.sort(this.#compare);
    } else {
      if (this.#depths !== null) {
        this.#extractDepths();
      } else {
        this.#extract();
      }
      sortByKey(order, this.keys);
    }
    const { list, entities, length } = this;
    for (let i = 0; i < length; i++) {
      entities[i] = list[order[i]];
    }
    this.stamp.value = this.#ticks.tick;
  }

  /** One linear pass over the key column of each archetype, in `list` order. */
  #extract(): void {
    const { archetypes, keys } = this;
    const columns = this.#columns;
    const sign = this.#sign;
    let at = 0;
    for (let a = archetypes.length - 1; a >= 0; a--) {
      const archetype = archetypes[a];
      const rows = archetype.rows;
      if (rows === 0) {
        continue;
      }
      const { pageShift, pageMask } = archetype;
      const pages = columns[a].pages;
      for (let page = (rows - 1) >>> pageShift, i = (rows - 1) & pageMask; page >= 0; page--) {
        const data = pages[page] as ArrayLike<number>;
        for (; i >= 0; i--) {
          keys[at++] = sign * data[i];
        }
        i = pageMask;
      }
    }
  }

  /** Depth is entity-indexed, and an entity the table never reached is a root (SPEC §7.6). */
  #extractDepths(): void {
    const { list, keys, length } = this;
    const depths = this.#depths!.depths!;
    const bound = depths.length;
    for (let i = 0; i < length; i++) {
      const id = list[i] >>> 0;
      keys[i] = id < bound ? depths[id] : 0;
    }
  }

  #grow(n: number): void {
    const capacity = Math.max(n, this.list.length * 2);
    this.list = new Float64Array(capacity);
    this.entities = new Float64Array(capacity);
    if (this.#compare === null) {
      this.keys = new Float64Array(capacity);
    }
  }
}

/**
 * Tier 1 and `each` over a materialised order: a `sortBy`, or a `Cascade`
 * keyed on hierarchy depth. Like every materialised result it has no chunks
 * (SPEC §6.7, §7.6).
 */
export class SortedQueryResult<T extends readonly Term[] = readonly Term[]> implements View {
  declare readonly [$view]: SortedView;
  declare readonly [$plan]: QueryPlan;
  declare readonly [$terms]: readonly Term[];

  readonly #base: QueryResult;
  readonly #walk: ListWalk;
  readonly #forget: () => void;

  /**
   * `base` owns the archetype list — the query narrowed to entities that carry
   * the key trait, or the query itself; `terms` are the query's own, which
   * decide what `each` hands out. `forget` drops the memo entry on dispose.
   */
  public constructor(
    base: QueryResult,
    terms: readonly Term[],
    key: SortKey,
    descending: boolean,
    cache: QueryCache,
    forget: () => void,
  ) {
    this[$view] = new SortedView(base[$archetypes], key, descending, cache.ticks);
    this[$plan] = base[$plan];
    this[$terms] = terms;
    this.#base = base;
    this.#walk = new ListWalk(terms, null, cache);
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
    const view = this[$view];
    const entities = view.ensure();
    return view.length === 0 ? undefined : (entities[0] as Entity);
  }

  /** The work the next access pays (SPEC §6.7). Reading it does none of it. */
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
    const view = this[$view];
    return this.#walk.iterator(view.ensure(), view.length, 1);
  }

  /** An ordered copy, safe to drive structural change with (SPEC §9). */
  public entities(): Float64Array {
    const view = this[$view];
    return view.ensure().slice(0, view.length);
  }

  /**
   * Materialised results have no chunks (SPEC §6.7). It is not public, so the
   * type surface does not offer it, and it still throws for callers with no
   * types to stop them.
   */
  protected chunks(): never {
    throw new ApecsError(
      'a sorted query is materialised and has no chunks — use each() (SPEC §6.7)',
    );
  }

  public each(fn: EachFn<T>): void {
    const view = this[$view];
    const entities = view.ensure();
    view.walks++;
    try {
      this.#walk.each(fn, entities, view.length, 1);
    } finally {
      view.walks--;
    }
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

  /** @internal */
  public retrack(trait: Trait): void {
    this.#walk.retrack(trait);
  }
}
