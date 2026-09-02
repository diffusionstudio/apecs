import type { Archetype } from './archetype'
import { ApecsError } from './debug'
import { entityGeneration, entityId, type Entity } from './entity'
import type { EntityIndex } from './entity-index'
import type { Iteration } from './iteration'
import type { QueryCache, QueryPlan, QueryResult } from './query'
import { $bind, $plan, $row, $terms } from './symbols'
import type { EntityList } from './targets'
import type { Ticks } from './ticks'
import type { Term } from './terms'
import type { Trait } from './trait'
import { Binding, RowFilter, invoke } from './walk'

/** A result layered over a `QueryResult`'s archetype list, told what it learns. */
export interface View {
  admit(archetype: Archetype): void
  retrack(trait: Trait): void
  dispose(): void
}

/**
 * Tier 1 and `each` over a materialised entity list. Every entity is located
 * through the entity index as it is reached, so the walk is indifferent to
 * where rows move meanwhile; the trade is that `chunks` has nothing to hand
 * out (SPEC §6.7, §7.4).
 *
 * `step` is +1 for a list whose order is the point, and -1 for one that may be
 * swap-removed from under the walk — going back to front, the entity pulled
 * into the hole has already been visited (SPEC §9).
 */
export class ListWalk {
  /** `null` when the list is known to hold only matching entities. */
  readonly #plan: QueryPlan | null
  readonly #binding: Binding
  readonly #filter: RowFilter | null
  readonly #entities: EntityIndex
  readonly #archetypes: readonly Archetype[]
  readonly #ticks: Ticks
  readonly #iteration: Iteration

  public constructor(terms: readonly Term[], plan: QueryPlan | null, cache: QueryCache) {
    this.#plan = plan
    this.#binding = new Binding(terms)
    this.#filter = RowFilter.of(terms)
    this.#entities = cache.entities
    this.#archetypes = cache.graph.list
    this.#ticks = cache.ticks
    this.#iteration = cache.iteration
  }

  public retrack(trait: Trait): void {
    this.#binding.retrack(trait)
  }

  public each(fn: (...args: any[]) => void, entities: Float64Array, n: number, step: number): void {
    const iteration = this.#iteration
    const frame = iteration.enter()
    // A materialised walk has no unvisited row a swap-remove could disturb (SPEC §9).
    if (__DEV__) frame.archetype = null
    try {
      this.#walk(fn, entities, n, step)
    } finally {
      if (__DEV__) this.#binding.poison()
      iteration.exit()
    }
  }

  public iterator(entities: Float64Array, n: number, step: number): Iterator<Entity> {
    return new ListIterator(entities, n, step, this.#entities, this.#plan, this.#archetypes)
  }

  public count(entities: Float64Array, n: number): number {
    const { generations, archetypes: archetypeIds } = this.#entities
    const plan = this.#plan
    let total = 0
    for (let k = 0; k < n; k++) {
      const entity = entities[k]
      const id = entityId(entity)
      if (generations[id] !== entityGeneration(entity)) continue
      if (plan === null || plan.test(this.#archetypes[archetypeIds[id]].mask)) total++
    }
    return total
  }

  public first(entities: Float64Array, n: number, step: number): Entity | undefined {
    const result = this.iterator(entities, n, step).next()
    return result.done ? undefined : result.value
  }

  public collect(entities: Float64Array, n: number, step: number): Float64Array {
    const out = new Float64Array(this.count(entities, n))
    const iterator = this.iterator(entities, n, step)
    let at = 0
    for (let next = iterator.next(); !next.done; next = iterator.next()) out[at++] = next.value
    return out
  }

  #walk(fn: (...args: any[]) => void, entities: Float64Array, n: number, step: number): void {
    const filter = this.#filter
    const ticks = this.#ticks
    if (filter !== null && !filter.begin(ticks)) return
    const tick = ticks.tick

    const plan = this.#plan
    const { generations, archetypes: archetypeIds, rows } = this.#entities
    const archetypes = this.#archetypes
    const binding = this.#binding
    const { args, cursors, cursorColumns, boxedArg, boxedColumn, boxedPage } = binding
    const arity = args.length - 1

    let bound: Archetype | null = null
    let bindable = false
    let boundPage = -1
    let pageShift = 0
    let pageMask = 0

    for (let k = step > 0 ? 0 : n - 1; k >= 0 && k < n; k += step) {
      const entity = entities[k] as Entity
      const id = entityId(entity)
      if (generations[id] !== entityGeneration(entity)) continue
      const archetype = archetypes[archetypeIds[id]]
      if (archetype !== bound) {
        bound = archetype
        boundPage = -1
        pageShift = archetype.pageShift
        pageMask = archetype.pageMask
        bindable = (plan === null || plan.test(archetype.mask)) && binding.bind(archetype)
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

/** Tier 1 over a list; entities that died since it was built are skipped. */
class ListIterator implements Iterator<Entity> {
  readonly #entities: Float64Array
  readonly #n: number
  readonly #step: number
  readonly #index: EntityIndex
  readonly #plan: QueryPlan | null
  readonly #archetypes: readonly Archetype[]
  readonly #result: IteratorResult<Entity> = { done: false, value: 0 as Entity }
  #at: number

  public constructor(
    entities: Float64Array,
    n: number,
    step: number,
    index: EntityIndex,
    plan: QueryPlan | null,
    archetypes: readonly Archetype[],
  ) {
    this.#entities = entities
    this.#n = n
    this.#step = step
    this.#index = index
    this.#plan = plan
    this.#archetypes = archetypes
    this.#at = step > 0 ? 0 : n - 1
  }

  public next(): IteratorResult<Entity> {
    const result = this.#result
    const { generations, archetypes: archetypeIds } = this.#index
    const plan = this.#plan
    for (; this.#at >= 0 && this.#at < this.#n; this.#at += this.#step) {
      const entity = this.#entities[this.#at] as Entity
      const id = entityId(entity)
      if (generations[id] !== entityGeneration(entity)) continue
      if (plan !== null && !plan.test(this.#archetypes[archetypeIds[id]].mask)) continue
      this.#at += this.#step
      result.value = entity
      return result
    }
    result.done = true
    result.value = undefined as unknown as Entity
    return result
  }
}

/**
 * `query(R(target))` for an exclusive relation: the target index's list for
 * that target, narrowed by whatever else the query asks. The list is the
 * index's own, so it is walked back to front and never copied (SPEC §7.4).
 */
export class IndexedQueryResult implements View {
  declare readonly [$plan]: QueryPlan
  declare readonly [$terms]: readonly Term[]

  readonly #base: QueryResult
  readonly #list: EntityList
  readonly #walk: ListWalk
  readonly #forget: () => void

  /** `base` is the query with the target dropped; it owns the plan and archetype list. */
  public constructor(
    base: QueryResult,
    list: EntityList,
    terms: readonly Term[],
    cache: QueryCache,
    forget: () => void,
  ) {
    this[$plan] = base[$plan]
    this[$terms] = terms
    this.#base = base
    this.#list = list
    this.#walk = new ListWalk(terms, base[$plan], cache)
    this.#forget = forget
    base.attach(this)
  }

  public get count(): number {
    return this.#walk.count(this.#list.items, this.#list.length)
  }

  public get isEmpty(): boolean {
    return this.first === undefined
  }

  public get first(): Entity | undefined {
    return this.#walk.first(this.#list.items, this.#list.length, -1)
  }

  public [Symbol.iterator](): Iterator<Entity> {
    return this.#walk.iterator(this.#list.items, this.#list.length, -1)
  }

  public entities(): Float64Array {
    return this.#walk.collect(this.#list.items, this.#list.length, -1)
  }

  public each(fn: (...args: any[]) => void): void {
    this.#walk.each(fn, this.#list.items, this.#list.length, -1)
  }

  public chunks(): never {
    throw new ApecsError(
      'a target query is served by the target index and has no chunks — use each() (SPEC §7.4)',
    )
  }

  public dispose(): void {
    this.#base.detach(this)
    this.#forget()
  }

  /** @internal */
  public admit(): void {}

  /** @internal */
  public retrack(trait: Trait): void {
    this.#walk.retrack(trait)
  }
}
