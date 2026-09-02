import { snapshotRows, type Archetype, type ArchetypeGraph } from './archetype'
import { Chunks } from './chunk'
import { assert } from './debug'
import type { Entity } from './entity'
import type { EntityIndex } from './entity-index'
import type { Frame, Iteration } from './iteration'
import { createMask, maskHas, maskIntersects, maskSuperset, maskWith, type Mask } from './mask'
import type { TraitRegistry } from './registry'
import type { Field } from './schema'
import { SortedQueryResult, type Comparator } from './sorted'
import {
  $archetypes,
  $bind,
  $id,
  $index,
  $options,
  $plan,
  $row,
  $target,
  $term,
  $terms,
  $trait,
  $view,
} from './symbols'
import type { Ticks } from './ticks'
import { With, type Modifier, type Term } from './terms'
import { Trait, type TraitInstance } from './trait'
import { Binding, RowFilter, invoke, termTrait } from './walk'

const HAS = 0
const NOT = 1
const OR = 2
const ANY = 3

/** One node of the exotic part of a predicate; the plain part rides in two masks. */
interface Node {
  readonly op: number
  readonly bit: number
  readonly children: readonly Node[]
}

const NO_CHILDREN: readonly Node[] = []

function node(op: number, bit: number, children: readonly Node[] = NO_CHILDREN): Node {
  return { op, bit, children }
}

function evaluate(self: Node, mask: Mask): boolean {
  switch (self.op) {
    case HAS:
      return maskHas(mask, self.bit)
    case NOT:
      return !evaluate(self.children[0], mask)
    case OR: {
      const children = self.children
      for (let i = 0; i < children.length; i++) if (evaluate(children[i], mask)) return true
      return false
    }
    default:
      return true
  }
}

/**
 * The term list as a predicate over archetype masks, evaluated once per
 * archetype at creation. Per-frame matching therefore costs nothing (SPEC §10.4).
 */
export class QueryPlan {
  /** Bits every match must carry, and bits no match may carry. */
  readonly all: Mask
  readonly none: Mask
  /** `Or` and nested modifiers — what a pair of masks cannot express. */
  readonly nodes: readonly Node[]

  public constructor(all: Mask, none: Mask, nodes: readonly Node[]) {
    this.all = all
    this.none = none
    this.nodes = nodes
  }

  public test(mask: Mask): boolean {
    if (!maskSuperset(mask, this.all) || maskIntersects(mask, this.none)) return false
    const nodes = this.nodes
    for (let i = 0; i < nodes.length; i++) if (!evaluate(nodes[i], mask)) return false
    return true
  }
}

/** Mentioning a trait in a query registers it, so every term owns a mask bit. */
function bitOf(traits: TraitRegistry, term: Term): number {
  const trait = termTrait(term)
  return trait === null ? -1 : traits.register(trait)
}

function compileNode(traits: TraitRegistry, term: Term): Node {
  const trait = termTrait(term)
  if (trait !== null) return node(HAS, traits.register(trait))

  const modifier = term as Modifier
  const operands = modifier[$terms]
  switch (modifier[$term]) {
    case 'not':
      return node(NOT, -1, [compileNode(traits, operands[0])])
    case 'or': {
      const children: Node[] = new Array(operands.length)
      for (let i = 0; i < operands.length; i++) children[i] = compileNode(traits, operands[i])
      return node(OR, -1, children)
    }
    case 'with':
    case 'added':
    case 'changed':
      return node(HAS, bitOf(traits, operands[0]))
    default:
      // `Optional` and `Cascade` constrain nothing, and `Removed` reports a
      // trait the archetype no longer carries (SPEC §6.1, §8.3).
      bitOf(traits, operands[0])
      return node(ANY, -1)
  }
}

export function compileTerms(traits: TraitRegistry, terms: readonly Term[]): QueryPlan {
  let all = createMask()
  let none = createMask()
  const nodes: Node[] = []

  for (const term of terms) {
    const trait = termTrait(term)
    if (trait !== null) {
      all = maskWith(all, traits.register(trait))
      continue
    }
    const modifier = term as Modifier
    const operands = modifier[$terms]
    switch (modifier[$term]) {
      case 'with':
      case 'added':
      case 'changed':
        all = maskWith(all, bitOf(traits, operands[0]))
        break
      case 'not': {
        const bit = bitOf(traits, operands[0])
        if (bit >= 0) none = maskWith(none, bit)
        else nodes.push(compileNode(traits, term))
        break
      }
      case 'or':
        nodes.push(compileNode(traits, term))
        break
      default:
        bitOf(traits, operands[0])
    }
  }
  return new QueryPlan(all, none, nodes)
}

/** Structural, not by identity: a freshly built `Not(Velocity)` hashes the same. */
function hash(term: Term): string {
  const trait = termTrait(term)
  if (trait !== null) {
    if (term instanceof Trait) return `${trait[$id]}`
    return `${trait[$id]}#${String((term as TraitInstance)[$target])}`
  }
  const modifier = term as Modifier
  const operands = modifier[$terms]
  let key = `${modifier[$term]}(`
  for (let i = 0; i < operands.length; i++) key += `${hash(operands[i])},`
  return `${key})`
}

export function signatureOf(terms: readonly Term[]): string {
  let key = ''
  for (let i = 0; i < terms.length; i++) key += `${hash(terms[i])};`
  return key
}

/**
 * The three access tiers over one matching-archetype list. Every walk runs
 * archetypes and rows back to front over row counts fixed when it started,
 * which is what makes mutating or despawning the current entity safe (SPEC §9).
 */
export class QueryResult {
  declare readonly [$plan]: QueryPlan
  declare readonly [$terms]: readonly Term[]
  declare readonly [$archetypes]: Archetype[]

  readonly #cache: QueryCache
  readonly #key: string
  readonly #binding: Binding
  readonly #filter: RowFilter | null
  readonly #ticks: Ticks
  readonly #iteration: Iteration
  #caps: Uint32Array = new Uint32Array(0)
  #chunks: Chunks | undefined

  /** Sorted views memoised on (field, direction) or comparator identity (SPEC §6.7). */
  #sorted: Map<Field | Comparator, SortedQueryResult> | null = null
  #sortedDescending: Map<Field | Comparator, SortedQueryResult> | null = null
  /** Views whose archetype list is this one's; told about every archetype that joins. */
  readonly #views: SortedQueryResult[] = []

  public constructor(cache: QueryCache, key: string, plan: QueryPlan, terms: readonly Term[]) {
    this.#cache = cache
    this.#key = key
    this.#binding = new Binding(terms)
    this.#filter = RowFilter.of(terms)
    this.#ticks = cache.ticks
    this.#iteration = cache.iteration
    this[$plan] = plan
    this[$terms] = terms
    this[$archetypes] = []
  }

  public get count(): number {
    const archetypes = this[$archetypes]
    let total = 0
    for (let i = 0; i < archetypes.length; i++) total += archetypes[i].rows
    return total
  }

  public get isEmpty(): boolean {
    const archetypes = this[$archetypes]
    for (let i = 0; i < archetypes.length; i++) if (archetypes[i].rows !== 0) return false
    return true
  }

  public get first(): Entity | undefined {
    const archetypes = this[$archetypes]
    for (let i = archetypes.length - 1; i >= 0; i--) {
      const archetype = archetypes[i]
      if (archetype.rows !== 0) return archetype.entityAt(archetype.rows - 1)
    }
    return undefined
  }

  public [Symbol.iterator](): Iterator<Entity> {
    return new EntityIterator(this[$archetypes])
  }

  /** A copy, so it survives the structural change it is being used to drive (SPEC §9). */
  public entities(): Float64Array {
    const archetypes = this[$archetypes]
    const out = new Float64Array(this.count)
    let at = 0
    for (let a = archetypes.length - 1; a >= 0; a--) {
      const archetype = archetypes[a]
      for (let row = archetype.rows - 1; row >= 0; row--) out[at++] = archetype.entityAt(row)
    }
    return out
  }

  public each(fn: (...args: any[]) => void): void {
    const iteration = this.#iteration
    const frame = iteration.enter()
    try {
      if (this.#filter === null) this.#eachAll(fn, frame)
      else this.#eachFiltered(fn, frame, this.#filter)
    } finally {
      if (__DEV__) this.#binding.poison()
      iteration.exit()
    }
  }

  #eachAll(fn: (...args: any[]) => void, frame: Frame): void {
    const archetypes = this[$archetypes]
    const caps = (this.#caps = snapshotRows(archetypes, this.#caps))
    const binding = this.#binding
    const { args, cursors, cursorColumns, boxedArg, boxedColumn, boxedPage } = binding
    const arity = args.length - 1
    const tick = this.#ticks.tick

    for (let a = archetypes.length - 1; a >= 0; a--) {
      const archetype = archetypes[a]
      const rows = Math.min(archetype.rows, caps[a])
      if (rows === 0 || !binding.bind(archetype)) continue
      if (__DEV__) frame.archetype = archetype

      const { pageShift, pageMask } = archetype
      const cursorCount = cursors.length
      const boxedCount = boxedArg.length

      for (let page = (rows - 1) >>> pageShift, i = (rows - 1) & pageMask; page >= 0; page--) {
        const handles = archetype.entities[page]
        for (let c = 0; c < cursorCount; c++) cursors[c][$bind](cursorColumns[c], page, tick)
        for (let b = 0; b < boxedCount; b++) boxedPage[b] = boxedColumn[b].pages[page] as unknown[]

        for (; i >= 0; i--) {
          for (let c = 0; c < cursorCount; c++) cursors[c][$row] = i
          for (let b = 0; b < boxedCount; b++) args[boxedArg[b]] = boxedPage[b][i]
          if (__DEV__) frame.row = (page << pageShift) | i
          invoke(fn, args, arity, handles[i] as Entity)
        }
        i = pageMask
      }
    }
  }

  /**
   * The same walk with a per-row tick predicate. A separate loop so the
   * unfiltered path carries none of it (SPEC §8.3).
   */
  #eachFiltered(fn: (...args: any[]) => void, frame: Frame, filter: RowFilter): void {
    const ticks = this.#ticks
    if (!filter.begin(ticks)) return
    const tick = ticks.tick

    const archetypes = this[$archetypes]
    const caps = (this.#caps = snapshotRows(archetypes, this.#caps))
    const binding = this.#binding
    const { args, cursors, cursorColumns, boxedArg, boxedColumn, boxedPage } = binding
    const arity = args.length - 1

    for (let a = archetypes.length - 1; a >= 0; a--) {
      const archetype = archetypes[a]
      const rows = Math.min(archetype.rows, caps[a])
      if (rows === 0 || !binding.bind(archetype)) continue
      if (__DEV__) frame.archetype = archetype
      filter.bind(archetype)

      const { pageShift, pageMask } = archetype
      const cursorCount = cursors.length
      const boxedCount = boxedArg.length

      for (let page = (rows - 1) >>> pageShift, i = (rows - 1) & pageMask; page >= 0; page--) {
        const handles = archetype.entities[page]
        for (let c = 0; c < cursorCount; c++) cursors[c][$bind](cursorColumns[c], page, tick)
        for (let b = 0; b < boxedCount; b++) boxedPage[b] = boxedColumn[b].pages[page] as unknown[]

        for (; i >= 0; i--) {
          const entity = handles[i] as Entity
          if (!filter.accept(entity, page, i)) continue
          for (let c = 0; c < cursorCount; c++) cursors[c][$row] = i
          for (let b = 0; b < boxedCount; b++) args[boxedArg[b]] = boxedPage[b][i]
          if (__DEV__) frame.row = (page << pageShift) | i
          invoke(fn, args, arity, entity)
        }
        i = pageMask
      }
    }
  }

  public chunks(): Chunks {
    return (this.#chunks ??= new Chunks(this[$archetypes], this.#ticks, this.#iteration))
  }

  /**
   * The memoised order (SPEC §6.7). A field keys on itself and the direction,
   * a comparator on its identity — hoist the comparator to get the cached view.
   */
  public sortBy(field: Field, direction?: 'asc' | 'desc'): SortedQueryResult
  public sortBy(compare: Comparator): SortedQueryResult
  public sortBy(by: Field | Comparator, direction: 'asc' | 'desc' = 'asc'): SortedQueryResult {
    const descending = typeof by !== 'function' && direction === 'desc'
    let memo = descending ? this.#sortedDescending : this.#sorted
    let sorted = memo?.get(by)
    if (sorted === undefined) {
      sorted = this.#cache.sortBy(this, by, descending)
      if (memo === null) {
        memo = new Map()
        if (descending) this.#sortedDescending = memo
        else this.#sorted = memo
      }
      memo.set(by, sorted)
    }
    return sorted
  }

  public dispose(): void {
    this.#cache.release(this.#key, this)
    // Views over a dead list would never learn of new archetypes.
    this.#sorted?.forEach((sorted) => sorted.dispose())
    this.#sortedDescending?.forEach((sorted) => sorted.dispose())
    for (const sorted of this.#views.slice()) sorted.dispose()
  }

  /** @internal An archetype the plan accepted; the sorted views over this list register on it. */
  public admit(archetype: Archetype): void {
    this[$archetypes].push(archetype)
    const views = this.#views
    for (let i = 0; i < views.length; i++) views[i][$view].watch(archetype)
  }

  /** @internal */
  public attach(sorted: SortedQueryResult): void {
    this.#views.push(sorted)
  }

  /** @internal */
  public detach(sorted: SortedQueryResult): void {
    const at = this.#views.indexOf(sorted)
    if (at >= 0) this.#views.splice(at, 1)
  }

  /** @internal Drops a memo entry; the view is disposing itself. */
  public forget(by: Field | Comparator, descending: boolean): void {
    ;(descending ? this.#sortedDescending : this.#sorted)?.delete(by)
  }

  /** @internal Swaps in tracked cursors after a promotion (SPEC §8.3). */
  public retrack(trait: Trait): void {
    this.#binding.retrack(trait)
    this.#sorted?.forEach((sorted) => sorted.retrack(trait))
    this.#sortedDescending?.forEach((sorted) => sorted.retrack(trait))
  }
}

/** Tier 1. A plain object rather than a generator, so iteration allocates once. */
class EntityIterator implements Iterator<Entity> {
  readonly #archetypes: readonly Archetype[]
  readonly #caps: Uint32Array
  readonly #result: IteratorResult<Entity> = { done: false, value: 0 as Entity }

  #index: number
  #row = -1

  public constructor(archetypes: readonly Archetype[]) {
    this.#archetypes = archetypes
    this.#caps = snapshotRows(archetypes, new Uint32Array(archetypes.length))
    this.#index = archetypes.length
  }

  public next(): IteratorResult<Entity> {
    const archetypes = this.#archetypes
    const result = this.#result

    while (this.#row < 0) {
      const index = --this.#index
      if (index < 0) {
        result.done = true
        result.value = undefined as unknown as Entity
        return result
      }
      this.#row = Math.min(archetypes[index].rows, this.#caps[index]) - 1
    }

    result.value = archetypes[this.#index].entityAt(this.#row--)
    return result
  }
}

/**
 * Per-world query cache. A signature is hashed once; the same `QueryResult`
 * comes back for the same term list, and it keeps its matching-archetype list
 * up to date through the graph's creation hook (SPEC §6.2, §10.4).
 */
export class QueryCache {
  readonly live: QueryResult[] = []
  readonly graph: ArchetypeGraph
  readonly entities: EntityIndex
  readonly ticks: Ticks
  readonly iteration: Iteration

  readonly #traits: TraitRegistry
  readonly #byKey = new Map<string, QueryResult>()

  public constructor(
    traits: TraitRegistry,
    graph: ArchetypeGraph,
    entities: EntityIndex,
    ticks: Ticks,
    iteration: Iteration,
  ) {
    this.#traits = traits
    this.graph = graph
    this.entities = entities
    this.ticks = ticks
    this.iteration = iteration
    graph.onCreate = (archetype) => this.#offer(archetype)
  }

  public get(terms: readonly Term[]): QueryResult {
    const key = signatureOf(terms)
    let query = this.#byKey.get(key)
    if (query === undefined) {
      // Before the binding picks its cursor classes: `Changed` promotes its
      // trait to tracked and `Added` allocates the gain table (SPEC §8.3).
      for (const term of terms) {
        if (termTrait(term) !== null) continue
        const modifier = term as Modifier
        const trait = termTrait(modifier[$terms][0] as Term)
        if (trait === null) continue
        if (modifier[$term] === 'changed') this.track(trait)
        else if (modifier[$term] === 'added') this.ticks.trackAdded(trait[$id])
      }

      query = new QueryResult(this, key, compileTerms(this.#traits, terms), terms)
      this.#byKey.set(key, query)
      this.live.push(query)

      const existing = this.graph.list
      const plan = query[$plan]
      for (let i = 0; i < existing.length; i++)
        if (plan.test(existing[i].mask)) query.admit(existing[i])
    }
    return query
  }

  /**
   * Builds the view for `parent`. A field's trait is marked tracked, and when
   * the parent does not already require it the view runs over the parent
   * narrowed by `With(trait)`: an entity without the key trait has no key.
   */
  public sortBy(
    parent: QueryResult,
    by: Field | Comparator,
    descending: boolean,
  ): SortedQueryResult {
    let base = parent
    if (typeof by === 'function') {
      if (__DEV__) assert(!(by instanceof Trait), 'sortBy() takes a field or a comparator')
    } else {
      const trait = by[$trait]
      if (__DEV__) {
        assert($index in by, 'sortBy() takes a field or a comparator')
        assert(
          by.array !== null,
          `sortBy() needs a numeric key and "${by.key}" is not one — use the comparator overload`,
        )
        assert(trait[$options].storage !== 'sparse', 'sortBy() cannot key on a sparse trait')
      }
      this.track(trait)
      if (!maskHas(parent[$plan].all, this.#traits.register(trait)))
        base = this.get([...parent[$terms], With(trait)])
    }
    return new SortedQueryResult(parent, base, by, descending, this)
  }

  /**
   * Promotes a trait to tracked. Queries built before the promotion carry
   * untracked cursors, so they are re-slotted here (SPEC §8.3).
   */
  public track(trait: Trait): void {
    if (trait[$options].track) return
    this.graph.track(trait)
    const live = this.live
    for (let i = 0; i < live.length; i++) live[i].retrack(trait)
  }

  public release(key: string, query: QueryResult): void {
    if (!this.#byKey.delete(key)) return
    const at = this.live.indexOf(query)
    if (at >= 0) this.live.splice(at, 1)
  }

  public clear(): void {
    this.#byKey.clear()
    this.live.length = 0
    this.graph.onCreate = null
  }

  #offer(archetype: Archetype): void {
    const live = this.live
    const mask = archetype.mask
    for (let i = 0; i < live.length; i++) {
      const query = live[i]
      if (query[$plan].test(mask)) query.admit(archetype)
    }
  }
}
