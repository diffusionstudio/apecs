import type { Archetype } from './archetype'
import type { Column } from './column'
import { ApecsError } from './debug'
import { entityGeneration, entityId, type Entity } from './entity'
import type { EntityIndex } from './entity-index'
import type { Iteration } from './iteration'
import type { QueryCache, QueryResult } from './query'
import type { Field } from './schema'
import { sortByKey } from './sort'
import { $archetypes, $bind, $row, $terms, $view } from './symbols'
import type { Ticks } from './ticks'
import type { Trait } from './trait'
import { Binding, RowFilter, invoke } from './walk'

export type Comparator = (a: Entity, b: Entity) => number
export type DirtyLevel = 'clean' | 'resort' | 'rebuild'

/**
 * The memoised order behind a sorted query. Every matching archetype holds it
 * in `sortedViews` and flips `structuralDirty` on a row insert or removal;
 * value changes are read off the key columns' `lastWriteTick` on access.
 * Between the two, a frame in which nothing moved costs a handful of compares
 * (SPEC §6.7).
 */
export class SortedView {
  readonly archetypes: readonly Archetype[]
  /** Flipped by the archetypes; a rebuild is the only thing that clears it. */
  public structuralDirty = true
  /** `structural` counts rebuilds; `value` is the tick of the last sort. */
  readonly stamp = { structural: 0, value: -1 }
  /** Live entries in `list`, `keys` and `entities`; the arrays keep spare capacity. */
  public length = 0
  /** The matched entities in walk order, and the key extracted for each. */
  public list = new Float64Array(0)
  public keys = new Float64Array(0)
  /** The permutation of `list` being sorted; kept across frames so a resort is adaptive. */
  readonly order: number[] = []
  /** `list` through `order`: the ordered result a walk reads. */
  public entities = new Float64Array(0)
  /** Walks in progress; a rebuild under one would reorder the array it is reading. */
  public walks = 0

  readonly #field: Field | null
  readonly #sign: number
  /** The key column of each matching archetype, parallel to `archetypes`. */
  readonly #columns: Column[] = []
  readonly #compare: ((a: number, b: number) => number) | null
  readonly #ticks: Ticks

  public constructor(
    archetypes: readonly Archetype[],
    field: Field | null,
    descending: boolean,
    compare: Comparator | null,
    ticks: Ticks,
  ) {
    this.archetypes = archetypes
    this.#field = field
    this.#sign = descending ? -1 : 1
    this.#compare =
      compare === null ? null : (a, b) => compare(this.list[a] as Entity, this.list[b] as Entity)
    this.#ticks = ticks
    for (let i = 0; i < archetypes.length; i++) this.watch(archetypes[i])
  }

  /**
   * Registers on an archetype that joined the matching list. It joins empty,
   * so its first row is what flips the structural flag.
   */
  public watch(archetype: Archetype): void {
    archetype.sortedViews.push(this)
    if (this.#field !== null) this.#columns.push(archetype.column(this.#field)!)
  }

  public unwatch(): void {
    const archetypes = this.archetypes
    for (let i = 0; i < archetypes.length; i++) {
      const views = archetypes[i].sortedViews
      const at = views.indexOf(this)
      if (at >= 0) views.splice(at, 1)
    }
    this.#columns.length = 0
  }

  /**
   * Conservative at tick granularity: a key written in the tick of the last
   * sort counts, because the scalar cannot tell a write before the sort from
   * one after it. A comparator has no column to watch and is always dirty.
   */
  public get valueDirty(): boolean {
    if (this.#compare !== null) return true
    const columns = this.#columns
    const stamp = this.stamp.value
    for (let i = 0; i < columns.length; i++) if (columns[i].lastWriteTick >= stamp) return true
    return false
  }

  public get level(): DirtyLevel {
    return this.structuralDirty ? 'rebuild' : this.valueDirty ? 'resort' : 'clean'
  }

  /** Brings the order up to date and returns it; `length` bounds the live prefix. */
  public ensure(): Float64Array {
    if (this.walks === 0) {
      if (this.structuralDirty) this.#rebuild()
      else if (this.valueDirty) this.#sort()
    }
    return this.entities
  }

  public invalidate(): void {
    this.stamp.value = -1
  }

  #rebuild(): void {
    const archetypes = this.archetypes
    let n = 0
    for (let a = 0; a < archetypes.length; a++) n += archetypes[a].rows
    if (n > this.list.length) this.#grow(n)

    const list = this.list
    let at = 0
    for (let a = archetypes.length - 1; a >= 0; a--) {
      const archetype = archetypes[a]
      for (let row = archetype.rows - 1; row >= 0; row--) list[at++] = archetype.entityAt(row)
    }

    // The previous permutation survives as far as it can, so a set that barely
    // changed sorts in nearly linear time and keeps its tie order.
    const order = this.order
    const previous = order.length
    if (n < previous) {
      let w = 0
      for (let r = 0; r < previous; r++) if (order[r] < n) order[w++] = order[r]
      order.length = n
    } else {
      for (let i = previous; i < n; i++) order.push(i)
    }

    this.length = n
    this.structuralDirty = false
    this.stamp.structural++
    this.#sort()
  }

  #sort(): void {
    const order = this.order
    if (this.#compare === null) {
      this.#extract()
      sortByKey(order, this.keys)
    } else {
      order.sort(this.#compare)
    }
    const { list, entities, length } = this
    for (let i = 0; i < length; i++) entities[i] = list[order[i]]
    this.stamp.value = this.#ticks.tick
  }

  /** One linear pass over the key column of each archetype, in `list` order. */
  #extract(): void {
    const { archetypes, keys } = this
    const columns = this.#columns
    const sign = this.#sign
    let at = 0
    for (let a = archetypes.length - 1; a >= 0; a--) {
      const archetype = archetypes[a]
      const rows = archetype.rows
      if (rows === 0) continue
      const { pageShift, pageMask } = archetype
      const pages = columns[a].pages
      for (let page = (rows - 1) >>> pageShift, i = (rows - 1) & pageMask; page >= 0; page--) {
        const data = pages[page] as ArrayLike<number>
        for (; i >= 0; i--) keys[at++] = sign * data[i]
        i = pageMask
      }
    }
  }

  #grow(n: number): void {
    const capacity = Math.max(n, this.list.length * 2)
    this.list = new Float64Array(capacity)
    this.entities = new Float64Array(capacity)
    if (this.#compare === null) this.keys = new Float64Array(capacity)
  }
}

/**
 * Tier 1 and `each` over a materialised order. Every entity is located through
 * the entity index as it is reached, so the walk is indifferent to where rows
 * move meanwhile; the trade is that `chunks` has nothing to hand out (SPEC §6.7).
 */
export class SortedQueryResult {
  declare readonly [$view]: SortedView

  readonly #parent: QueryResult
  readonly #base: QueryResult
  readonly #by: Field | Comparator
  readonly #descending: boolean
  readonly #binding: Binding
  readonly #filter: RowFilter | null
  readonly #entities: EntityIndex
  readonly #archetypes: readonly Archetype[]
  readonly #ticks: Ticks
  readonly #iteration: Iteration

  /**
   * `parent` owns the memo entry; `base` owns the archetype list — the parent
   * narrowed to entities that carry the key trait, or the parent itself.
   */
  public constructor(
    parent: QueryResult,
    base: QueryResult,
    by: Field | Comparator,
    descending: boolean,
    cache: QueryCache,
  ) {
    const compare = typeof by === 'function' ? by : null
    this[$view] = new SortedView(
      base[$archetypes],
      compare === null ? (by as Field) : null,
      descending,
      compare,
      cache.ticks,
    )
    this.#parent = parent
    this.#base = base
    this.#by = by
    this.#descending = descending
    this.#binding = new Binding(parent[$terms])
    this.#filter = RowFilter.of(parent[$terms])
    this.#entities = cache.entities
    this.#archetypes = cache.graph.list
    this.#ticks = cache.ticks
    this.#iteration = cache.iteration
    base.attach(this)
  }

  public get count(): number {
    return this.#base.count
  }

  public get isEmpty(): boolean {
    return this.#base.isEmpty
  }

  public get first(): Entity | undefined {
    const view = this[$view]
    const entities = view.ensure()
    return view.length === 0 ? undefined : (entities[0] as Entity)
  }

  /** The work the next access pays (SPEC §6.7). Reading it does none of it. */
  public get isDirty(): DirtyLevel {
    return this[$view].level
  }

  /** Forces a resort on the next access — for keys apecs cannot see change. */
  public invalidate(): void {
    this[$view].invalidate()
  }

  /** Forces a full rebuild on the next access. */
  public rebuild(): void {
    this[$view].structuralDirty = true
  }

  public [Symbol.iterator](): Iterator<Entity> {
    const view = this[$view]
    return new SortedIterator(view.ensure(), view.length, this.#entities)
  }

  /** An ordered copy, safe to drive structural change with (SPEC §9). */
  public entities(): Float64Array {
    const view = this[$view]
    return view.ensure().slice(0, view.length)
  }

  public chunks(): never {
    throw new ApecsError(
      'a sorted query is materialised and has no chunks — use each() (SPEC §6.7)',
    )
  }

  public each(fn: (...args: any[]) => void): void {
    const view = this[$view]
    const entities = view.ensure()
    const iteration = this.#iteration
    const frame = iteration.enter()
    // A materialised walk has no unvisited row a swap-remove could disturb (SPEC §9).
    if (__DEV__) frame.archetype = null
    view.walks++
    try {
      this.#walk(fn, entities, view.length)
    } finally {
      view.walks--
      if (__DEV__) this.#binding.poison()
      iteration.exit()
    }
  }

  public dispose(): void {
    this[$view].unwatch()
    this.#base.detach(this)
    this.#parent.forget(this.#by, this.#descending)
  }

  /** @internal */
  public retrack(trait: Trait): void {
    this.#binding.retrack(trait)
  }

  #walk(fn: (...args: any[]) => void, entities: Float64Array, n: number): void {
    const filter = this.#filter
    const ticks = this.#ticks
    if (filter !== null && !filter.begin(ticks)) return
    const tick = ticks.tick

    const index = this.#entities
    const { generations, archetypes: archetypeIds, rows } = index
    const archetypes = this.#archetypes
    const binding = this.#binding
    const { args, cursors, cursorColumns, boxedArg, boxedColumn, boxedPage } = binding
    const arity = args.length - 1

    let bound: Archetype | null = null
    let bindable = false
    let boundPage = -1
    let pageShift = 0
    let pageMask = 0

    for (let k = 0; k < n; k++) {
      const entity = entities[k] as Entity
      const id = entityId(entity)
      if (generations[id] !== entityGeneration(entity)) continue
      const archetype = archetypes[archetypeIds[id]]
      if (archetype !== bound) {
        bound = archetype
        boundPage = -1
        pageShift = archetype.pageShift
        pageMask = archetype.pageMask
        bindable = binding.bind(archetype)
        if (bindable && filter !== null) filter.bind(archetype)
      }
      if (!bindable) continue

      const row = rows[id]
      const page = row >>> pageShift
      const i = row & pageMask
      if (page !== boundPage) {
        boundPage = page
        for (let c = 0; c < cursors.length; c++) cursors[c][$bind](cursorColumns[c], page, tick)
        for (let b = 0; b < boxedArg.length; b++)
          boxedPage[b] = boxedColumn[b].pages[page] as unknown[]
      }
      if (filter !== null && !filter.accept(entity, page, i)) continue
      for (let c = 0; c < cursors.length; c++) cursors[c][$row] = i
      for (let b = 0; b < boxedArg.length; b++) args[boxedArg[b]] = boxedPage[b][i]
      invoke(fn, args, arity, entity)
    }
  }
}

/** Tier 1 over the materialised order; entities that died since it was built are skipped. */
class SortedIterator implements Iterator<Entity> {
  readonly #entities: Float64Array
  readonly #length: number
  readonly #index: EntityIndex
  readonly #result: IteratorResult<Entity> = { done: false, value: 0 as Entity }
  #at = 0

  public constructor(entities: Float64Array, length: number, index: EntityIndex) {
    this.#entities = entities
    this.#length = length
    this.#index = index
  }

  public next(): IteratorResult<Entity> {
    const result = this.#result
    const generations = this.#index.generations
    while (this.#at < this.#length) {
      const entity = this.#entities[this.#at++] as Entity
      if (generations[entityId(entity)] === entityGeneration(entity)) {
        result.value = entity
        return result
      }
    }
    result.done = true
    result.value = undefined as unknown as Entity
    return result
  }
}
