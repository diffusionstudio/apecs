import { Column } from './column'
import { NULL_ENTITY, type Entity } from './entity'
import { createMask, maskKey, maskWith, maskWithout, type Mask } from './mask'
import type { Field } from './schema'
import type { SortedView } from './sorted'
import { $fields, $id, $index, $trait } from './symbols'
import { setTracked, type Trait } from './trait'
import type { TraitRegistry } from './registry'

/**
 * The entities holding exactly one trait set. Owns the columns for that set,
 * paged so growth appends and never invalidates a page (SPEC §10.1, §10.2).
 */
export class Archetype {
  readonly id: number
  readonly mask: Mask

  readonly add = new Map<number, Archetype>()
  readonly remove = new Map<number, Archetype>()

  /** Every column, flat — the order growth and swap-remove walk. */
  readonly columns: Column[] = []
  /** Global trait id → that trait's columns, indexed by field index. */
  readonly columnsOf = new Map<number, Column[]>()
  /** `traitIds[i]` owns `traitColumns[i]`; iterated on row moves without allocating. */
  readonly traitIds: number[] = []
  readonly traitColumns: Column[][] = []

  /** Pages of packed handles, one entry per row. */
  readonly entities: Float64Array[] = []
  public rows = 0

  /** Sorted views over this archetype; empty for nearly all, so a row change costs one load (SPEC §6.7). */
  readonly sortedViews: SortedView[] = []

  readonly pageSize: number
  readonly pageShift: number
  readonly pageMask: number

  private capacity = 0

  public constructor(id: number, mask: Mask, pageSize: number) {
    this.id = id
    this.mask = mask
    this.pageSize = pageSize
    this.pageShift = 31 - Math.clz32(pageSize)
    this.pageMask = pageSize - 1
  }

  public entityAt(row: number): Entity {
    return this.entities[row >>> this.pageShift][row & this.pageMask] as Entity
  }

  public column(field: Field): Column | undefined {
    const columns = this.columnsOf.get(field[$trait][$id])
    return columns === undefined ? undefined : columns[field[$index]]
  }

  /** Tags allocate nothing; every other trait contributes one column per field. */
  public addColumns(trait: Trait): void {
    const fields = trait[$fields]
    if (fields.length === 0) return
    const columns: Column[] = new Array(fields.length)
    for (let i = 0; i < fields.length; i++) {
      const column = new Column(fields[i], this.pageSize)
      columns[i] = column
      this.columns.push(column)
    }
    this.columnsOf.set(trait[$id], columns)
    this.traitIds.push(trait[$id])
    this.traitColumns.push(columns)
  }

  public appendRow(entity: Entity): number {
    const row = this.rows++
    if (this.rows > this.capacity) this.reserve(this.rows)
    this.entities[row >>> this.pageShift][row & this.pageMask] = entity
    this.invalidateViews()
    return row
  }

  /** Reserves `n` consecutive rows and returns the first; the caller fills them in. */
  public appendRows(n: number): number {
    const first = this.rows
    this.rows += n
    if (this.rows > this.capacity) this.reserve(this.rows)
    this.invalidateViews()
    return first
  }

  public setEntity(row: number, entity: Entity): void {
    this.entities[row >>> this.pageShift][row & this.pageMask] = entity
  }

  /** Swap-removes `row`; returns the entity relocated into it, or `NULL_ENTITY`. */
  public removeRow(row: number): Entity {
    const last = --this.rows
    const columns = this.columns
    for (let i = 0; i < columns.length; i++) columns[i].swapRemove(row, last)
    this.invalidateViews()
    if (row === last) return NULL_ENTITY
    const moved = this.entityAt(last)
    this.setEntity(row, moved)
    return moved
  }

  /** Releases the tail pages no live row reaches (SPEC §10.2). */
  public compact(): void {
    const pages = Math.ceil(this.rows / this.pageSize)
    this.entities.length = pages
    this.capacity = pages * this.pageSize
    const columns = this.columns
    for (let i = 0; i < columns.length; i++) columns[i].compact(this.rows)
  }

  private invalidateViews(): void {
    const views = this.sortedViews
    for (let i = 0; i < views.length; i++) views[i].structuralDirty = true
  }

  private reserve(rows: number): void {
    while (this.capacity < rows) {
      this.entities.push(new Float64Array(this.pageSize))
      this.capacity += this.pageSize
    }
    const columns = this.columns
    for (let i = 0; i < columns.length; i++) columns[i].ensure(rows)
  }
}

/**
 * `caps[i] = archetypes[i].rows` as of now, reusing `caps` unless the list has
 * outgrown it. A walk bounded by these counts never reaches a row appended
 * after it started, however the appends interleave with it (SPEC §9).
 */
export function snapshotRows(archetypes: readonly Archetype[], caps: Uint32Array): Uint32Array {
  const n = archetypes.length
  if (caps.length < n) caps = new Uint32Array(n)
  for (let i = 0; i < n; i++) caps[i] = archetypes[i].rows
  return caps
}

/**
 * Archetypes plus the lazily-built edges between them. A structural change is
 * one cached `Map` lookup per trait, then a row move (SPEC §10.1).
 */
export class ArchetypeGraph {
  readonly list: Archetype[] = []
  readonly root: Archetype

  /** Set by the query cache; every new archetype is offered to the live queries once. */
  public onCreate: ((archetype: Archetype) => void) | null = null

  private readonly byKey = new Map<string, Archetype>()

  public constructor(
    private readonly traits: TraitRegistry,
    private readonly pageSize: number,
  ) {
    this.root = this.create(createMask(0))
  }

  /**
   * Promotes a trait to tracked: columns created from here on are born with
   * tick storage, and the ones this world already holds are backfilled
   * (SPEC §8.3).
   */
  public track(trait: Trait): void {
    setTracked(trait)
    const list = this.list
    for (let i = 0; i < list.length; i++) {
      const columns = list[i].columnsOf.get(trait[$id])
      if (columns === undefined) continue
      for (let c = 0; c < columns.length; c++) columns[c].track()
    }
  }

  /** Drops every archetype so its columns can be collected; the graph is not reusable. */
  public dispose(): void {
    this.list.length = 0
    this.byKey.clear()
    this.onCreate = null
  }

  public edgeAdd(from: Archetype, local: number): Archetype {
    let to = from.add.get(local)
    if (to === undefined) {
      to = this.intern(maskWith(from.mask, local))
      from.add.set(local, to)
      to.remove.set(local, from)
    }
    return to
  }

  public edgeRemove(from: Archetype, local: number): Archetype {
    let to = from.remove.get(local)
    if (to === undefined) {
      to = this.intern(maskWithout(from.mask, local))
      from.remove.set(local, to)
      to.add.set(local, from)
    }
    return to
  }

  private intern(mask: Mask): Archetype {
    return this.byKey.get(maskKey(mask)) ?? this.create(mask)
  }

  private create(mask: Mask): Archetype {
    const archetype = new Archetype(this.list.length, mask, this.pageSize)
    for (let block = 0; block < mask.length; block++) {
      let bits = mask[block]
      while (bits !== 0) {
        const lowest = bits & -bits
        archetype.addColumns(this.traits.list[(block << 5) + (31 - Math.clz32(lowest))])
        bits ^= lowest
      }
    }
    this.list.push(archetype)
    this.byKey.set(maskKey(mask), archetype)
    this.onCreate?.(archetype)
    return archetype
  }
}
