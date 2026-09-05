import { Column } from './column';
import { NULL_ENTITY, entityId, type Entity } from './entity';
import type { EntityIndex } from './entity-index';
import { createMask, maskKey, maskWith, maskWithout, type Mask } from './mask';
import { isRelation, pairsOf } from './relation';
import type { Field } from './schema';
import { $fields, $id, $index, $options, $targetField, $trait } from './symbols';
import { setTracked, type Trait } from './trait';
import type { TraitRegistry } from './registry';

/** A sorted or ordered view: told when the rows it covers were inserted, removed or moved (SPEC §6.7, §6.8). */
export interface DirtyView {
  structuralDirty: boolean;
}

/** Permute scratch: cycle membership, and the cycles packed as `[len, rows…]`. Never nested. */
let visited = new Uint8Array(0);
let cycles = new Uint32Array(0);

/**
 * The entities holding exactly one trait set. Owns the columns for that set,
 * paged so growth appends and never invalidates a page (SPEC §10.1, §10.2).
 */
export class Archetype {
  readonly id: number;
  readonly mask: Mask;

  readonly add = new Map<number, Archetype>();
  readonly remove = new Map<number, Archetype>();

  /** Every column, flat — the order growth and swap-remove walk. */
  readonly columns: Column[] = [];
  /** Global trait id → that trait's columns, indexed by field index. */
  readonly columnsOf = new Map<number, Column[]>();
  /** `traitIds[i]` owns `traitColumns[i]`; iterated on row moves without allocating. */
  readonly traitIds: number[] = [];
  readonly traitColumns: Column[][] = [];

  /** Pages of packed handles, one entry per row. */
  readonly entities: Float64Array[] = [];
  public rows = 0;

  /** Views over this archetype; empty for nearly all, so a row change costs one load (SPEC §6.7). */
  readonly sortedViews: DirtyView[] = [];

  readonly pageSize: number;
  readonly pageShift: number;
  readonly pageMask: number;

  private capacity = 0;

  public constructor(id: number, mask: Mask, pageSize: number) {
    this.id = id;
    this.mask = mask;
    this.pageSize = pageSize;
    this.pageShift = 31 - Math.clz32(pageSize);
    this.pageMask = pageSize - 1;
  }

  public entityAt(row: number): Entity {
    return this.entities[row >>> this.pageShift][row & this.pageMask] as Entity;
  }

  public column(field: Field): Column | undefined {
    const columns = this.columnsOf.get(field[$trait][$id]);
    return columns === undefined ? undefined : columns[field[$index]];
  }

  /**
   * Tags allocate nothing; every other trait contributes one column per field.
   * An exclusive relation adds its target column after the data; a
   * non-exclusive one adds nothing, its pairs carry the data (SPEC §7.4).
   */
  public addColumns(trait: Trait): Column[] | null {
    const fields = trait[$fields];
    let target: Field | null = null;
    if (isRelation(trait)) {
      if (!trait[$options].exclusive) {
        return null;
      }
      target = trait[$targetField];
    }
    const width = target === null ? fields.length : fields.length + 1;
    if (width === 0) {
      return null;
    }
    const columns: Column[] = new Array(width);
    for (let i = 0; i < width; i++) {
      const column = new Column(i < fields.length ? fields[i] : target!, this.pageSize);
      columns[i] = column;
      this.columns.push(column);
    }
    this.columnsOf.set(trait[$id], columns);
    this.traitIds.push(trait[$id]);
    this.traitColumns.push(columns);
    return columns;
  }

  public appendRow(entity: Entity): number {
    const row = this.rows++;
    if (this.rows > this.capacity) {
      this.reserve(this.rows);
    }
    this.entities[row >>> this.pageShift][row & this.pageMask] = entity;
    this.invalidateViews();
    return row;
  }

  /** Reserves `n` consecutive rows and returns the first; the caller fills them in. */
  public appendRows(n: number): number {
    const first = this.rows;
    this.rows += n;
    if (this.rows > this.capacity) {
      this.reserve(this.rows);
    }
    this.invalidateViews();
    return first;
  }

  public setEntity(row: number, entity: Entity): void {
    this.entities[row >>> this.pageShift][row & this.pageMask] = entity;
  }

  /** Swap-removes `row`; returns the entity relocated into it, or `NULL_ENTITY`. */
  public removeRow(row: number): Entity {
    const last = --this.rows;
    const columns = this.columns;
    for (let i = 0; i < columns.length; i++) {
      columns[i].swapRemove(row, last);
    }
    this.invalidateViews();
    if (row === last) {
      return NULL_ENTITY;
    }
    const moved = this.entityAt(last);
    this.setEntity(row, moved);
    return moved;
  }

  /**
   * Reorders the rows so that row `i` holds what row `order[i]` held: every
   * column with its ticks, the entity pages, and the index entries of the
   * rows that moved. The identity touches nothing and returns false. Cycles
   * are found once and each column follows them, so a nearly-sorted
   * archetype costs its moved rows, not its size (SPEC §6.8).
   */
  public permute(order: readonly number[], index: EntityIndex): boolean {
    const rows = this.rows;
    if (visited.length < rows) {
      visited = new Uint8Array(rows);
      // Every cycle has two members or more, so at most 3n/2 entries.
      cycles = new Uint32Array(rows + (rows >>> 1) + 1);
    }
    visited.fill(0, 0, rows);
    let n = 0;
    for (let i = 0; i < rows; i++) {
      if (visited[i] !== 0 || order[i] === i) {
        continue;
      }
      const lengthAt = n++;
      for (let j = i; visited[j] === 0; j = order[j]) {
        visited[j] = 1;
        cycles[n++] = j;
      }
      cycles[lengthAt] = n - lengthAt - 1;
    }
    if (n === 0) {
      return false;
    }

    const columns = this.columns;
    for (let c = 0; c < columns.length; c++) {
      columns[c].permute(cycles, n);
    }

    const { entities, pageShift, pageMask } = this;
    const at = index.rows;
    for (let k = 0; k < n;) {
      const end = k + 1 + cycles[k];
      let row = cycles[k + 1];
      const held = entities[row >>> pageShift][row & pageMask];
      for (k += 2; k < end; k++) {
        const next = cycles[k];
        const moved = entities[next >>> pageShift][next & pageMask];
        entities[row >>> pageShift][row & pageMask] = moved;
        at[entityId(moved)] = row;
        row = next;
      }
      entities[row >>> pageShift][row & pageMask] = held;
      at[entityId(held)] = row;
    }
    this.invalidateViews();
    return true;
  }

  /** Releases the tail pages no live row reaches (SPEC §10.2). */
  public compact(): void {
    const pages = Math.ceil(this.rows / this.pageSize);
    this.entities.length = pages;
    this.capacity = pages * this.pageSize;
    const columns = this.columns;
    for (let i = 0; i < columns.length; i++) {
      columns[i].compact(this.rows);
    }
  }

  private invalidateViews(): void {
    const views = this.sortedViews;
    for (let i = 0; i < views.length; i++) {
      views[i].structuralDirty = true;
    }
  }

  private reserve(rows: number): void {
    while (this.capacity < rows) {
      this.entities.push(new Float64Array(this.pageSize));
      this.capacity += this.pageSize;
    }
    const columns = this.columns;
    for (let i = 0; i < columns.length; i++) {
      columns[i].ensure(rows);
    }
  }
}

/**
 * `caps[i] = archetypes[i].rows` as of now, reusing `caps` unless the list has
 * outgrown it. A walk bounded by these counts never reaches a row appended
 * after it started, however the appends interleave with it (SPEC §9).
 */
export function snapshotRows(archetypes: readonly Archetype[], caps: Uint32Array): Uint32Array {
  const n = archetypes.length;
  if (caps.length < n) {
    caps = new Uint32Array(n);
  }
  for (let i = 0; i < n; i++) {
    caps[i] = archetypes[i].rows;
  }
  return caps;
}

/**
 * Archetypes plus the lazily-built edges between them. A structural change is
 * one cached `Map` lookup per trait, then a row move (SPEC §10.1).
 */
export class ArchetypeGraph {
  readonly list: Archetype[] = [];
  readonly root: Archetype;

  /** Set by the query cache; every new archetype is offered to the live queries once. */
  public onCreate: ((archetype: Archetype) => void) | null = null;
  /** Every `eid` column of the world, patched when the entity it names dies (SPEC §8.5). */
  readonly refs: Column[] = [];

  private readonly byKey = new Map<string, Archetype>();

  public constructor(
    private readonly traits: TraitRegistry,
    private readonly pageSize: number,
  ) {
    this.root = this.create(createMask(0));
  }

  /**
   * Promotes a trait to tracked: columns created from here on are born with
   * tick storage, and the ones this world already holds are backfilled
   * (SPEC §8.3).
   */
  public track(trait: Trait): void {
    setTracked(trait);
    if (isRelation(trait) && !trait[$options].exclusive) {
      const pairs = pairsOf(trait);
      if (pairs !== undefined) {
        for (const pair of pairs) {
          this.trackColumns(pair[$id]);
        }
      }
    } else {
      this.trackColumns(trait[$id]);
    }
  }

  /** Drops every archetype so its columns can be collected; the graph is not reusable. */
  public dispose(): void {
    this.list.length = 0;
    this.refs.length = 0;
    this.byKey.clear();
    this.onCreate = null;
  }

  public edgeAdd(from: Archetype, local: number): Archetype {
    let to = from.add.get(local);
    if (to === undefined) {
      to = this.intern(maskWith(from.mask, local));
      from.add.set(local, to);
      to.remove.set(local, from);
    }
    return to;
  }

  public edgeRemove(from: Archetype, local: number): Archetype {
    let to = from.remove.get(local);
    if (to === undefined) {
      to = this.intern(maskWithout(from.mask, local));
      from.remove.set(local, to);
      to.add.set(local, from);
    }
    return to;
  }

  private trackColumns(traitId: number): void {
    const list = this.list;
    for (let i = 0; i < list.length; i++) {
      const columns = list[i].columnsOf.get(traitId);
      if (columns === undefined) {
        continue;
      }
      for (let c = 0; c < columns.length; c++) {
        columns[c].track();
      }
    }
  }

  private intern(mask: Mask): Archetype {
    return this.byKey.get(maskKey(mask)) ?? this.create(mask);
  }

  private create(mask: Mask): Archetype {
    const archetype = new Archetype(this.list.length, mask, this.pageSize);
    for (let block = 0; block < mask.length; block++) {
      let bits = mask[block];
      while (bits !== 0) {
        const lowest = bits & -bits;
        bits ^= lowest;
        const trait = this.traits.list[(block << 5) + (31 - Math.clz32(lowest))];
        const columns = archetype.addColumns(trait);
        if (columns === null) {
          continue;
        }
        const fields = trait[$fields];
        for (let i = 0; i < fields.length; i++) {
          if (fields[i].kind === 'eid') {
            this.refs.push(columns[i]);
          }
        }
      }
    }
    this.list.push(archetype);
    this.byKey.set(maskKey(mask), archetype);
    this.onCreate?.(archetype);
    return archetype;
  }
}
