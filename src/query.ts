import type { Archetype, ArchetypeGraph } from './archetype'
import { Chunks } from './chunk'
import type { Column } from './column'
import { cursorClassFor, type Cursor } from './cursor'
import { assert } from './debug'
import { entityId, type Entity } from './entity'
import { createMask, maskHas, maskIntersects, maskSuperset, maskWith, type Mask } from './mask'
import type { TraitRegistry } from './registry'
import {
  $archetypes,
  $bind,
  $id,
  $kind,
  $options,
  $plan,
  $poison,
  $row,
  $target,
  $term,
  $terms,
  $trait,
} from './symbols'
import type { Ticks } from './ticks'
import { isDataTerm, type Modifier, type Term } from './terms'
import { Trait, type TraitInstance } from './trait'

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

/** The trait a term constrains, or null for a modifier. */
function traitOf(term: Term): Trait | null {
  if (term instanceof Trait) return term as Trait
  const trait = (term as TraitInstance)[$trait]
  return trait === undefined ? null : trait
}

/** Mentioning a trait in a query registers it, so every term owns a mask bit. */
function bitOf(traits: TraitRegistry, term: Term): number {
  const trait = traitOf(term)
  return trait === null ? -1 : traits.register(trait)
}

function compileNode(traits: TraitRegistry, term: Term): Node {
  const trait = traitOf(term)
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
    const trait = traitOf(term)
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
  const trait = traitOf(term)
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

/** One data-bearing term — one argument position of the `each` callback. */
class Slot {
  readonly trait: Trait
  readonly optional: boolean
  /** `null` for an AoS trait, which yields the stored reference itself. */
  readonly cursor: Cursor | null

  public constructor(trait: Trait, optional: boolean) {
    const cls = cursorClassFor(trait, trait[$options].track)
    this.trait = trait
    this.optional = optional
    this.cursor = cls === null ? null : new cls()
  }
}

function slotsOf(terms: readonly Term[]): Slot[] {
  const slots: Slot[] = []
  for (const term of terms) {
    if (!isDataTerm(term)) continue
    const optional = !(term instanceof Trait) && (term as Modifier)[$term] === 'optional'
    const subject = optional ? ((term as Modifier)[$terms][0] as Term) : term
    slots.push(new Slot(traitOf(subject)!, optional))
  }
  return slots
}

const NO_TRAITS: readonly Trait[] = []
const NO_IDS: readonly number[] = []

/** The tick-based terms of a query, split by what each one is checked against (SPEC §8.3). */
interface Filters {
  /** Per-row tick columns. */
  readonly changed: readonly Trait[]
  /** Entity-indexed gain tables, by global trait id. */
  readonly added: readonly number[]
  /** The removal log, by global trait id. */
  readonly removed: readonly number[]
}

function filtersOf(terms: readonly Term[]): Filters | null {
  let changed: Trait[] | null = null
  let added: number[] | null = null
  let removed: number[] | null = null

  for (const term of terms) {
    if (traitOf(term) !== null) continue
    const modifier = term as Modifier
    const trait = traitOf(modifier[$terms][0] as Term)
    if (trait === null) continue
    switch (modifier[$term]) {
      case 'changed':
        if (__DEV__) assert(trait[$kind] !== 'tag', 'Changed() needs a data-bearing trait')
        ;(changed ??= []).push(trait)
        break
      case 'added':
        ;(added ??= []).push(trait[$id])
        break
      case 'removed':
        ;(removed ??= []).push(trait[$id])
        break
    }
  }

  if (changed === null && added === null && removed === null) return null
  return { changed: changed ?? NO_TRAITS, added: added ?? NO_IDS, removed: removed ?? NO_IDS }
}

/**
 * The three access tiers over one matching-archetype list. Every walk runs
 * archetypes and rows back to front, which is what makes mutating or despawning
 * the current entity safe (SPEC §9).
 */
export class QueryResult {
  declare readonly [$plan]: QueryPlan
  declare readonly [$archetypes]: Archetype[]

  readonly #cache: QueryCache
  readonly #key: string
  readonly #slots: readonly Slot[]
  readonly #args: unknown[]
  readonly #ticks: Ticks

  /**
   * The per-archetype binding, split so the row loop only walks what actually
   * moves: cursors need a row index, AoS slots need a fresh reference.
   */
  readonly #cursors: Cursor[] = []
  readonly #cursorColumns: Column[][] = []
  readonly #boxedArg: number[] = []
  readonly #boxedColumn: Column[] = []
  readonly #boxedPage: unknown[][] = []

  /** Tick filters and their per-run scratch, reused so a filtered walk allocates nothing. */
  readonly #filters: Filters | null
  readonly #changedColumns: Column[][] = []
  readonly #addedTables: Uint32Array[] = []
  readonly #removedSets: Set<number>[] = []
  /** Each `Changed`/`Added`/`Removed` query keeps its own horizon (SPEC §8.3). */
  #lastSeen = -1

  #chunks: Chunks | undefined

  public constructor(
    cache: QueryCache,
    key: string,
    plan: QueryPlan,
    terms: readonly Term[],
    ticks: Ticks,
  ) {
    this.#cache = cache
    this.#key = key
    this.#slots = slotsOf(terms)
    this.#args = new Array(this.#slots.length + 1).fill(null)
    this.#ticks = ticks
    this.#filters = filtersOf(terms)
    this[$plan] = plan
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
    if (this.#filters === null) this.#eachAll(fn)
    else this.#eachFiltered(fn)
    if (__DEV__) {
      const slots = this.#slots
      for (let s = 0; s < slots.length; s++) slots[s].cursor?.[$poison]()
    }
  }

  #eachAll(fn: (...args: any[]) => void): void {
    const archetypes = this[$archetypes]
    const args = this.#args
    const arity = args.length - 1
    const cursors = this.#cursors
    const cursorColumns = this.#cursorColumns
    const boxedArg = this.#boxedArg
    const boxedColumn = this.#boxedColumn
    const boxedPage = this.#boxedPage
    const tick = this.#ticks.tick

    for (let a = archetypes.length - 1; a >= 0; a--) {
      const archetype = archetypes[a]
      const rows = archetype.rows
      if (rows === 0 || !this.#bind(archetype)) continue

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
          const entity = handles[i] as Entity
          switch (arity) {
            case 0:
              fn(entity)
              break
            case 1:
              fn(args[0], entity)
              break
            case 2:
              fn(args[0], args[1], entity)
              break
            case 3:
              fn(args[0], args[1], args[2], entity)
              break
            default:
              args[arity] = entity
              fn.apply(undefined, args)
          }
        }
        i = pageMask
      }
    }
  }

  /**
   * The same walk with a per-row tick predicate. A separate loop so the
   * unfiltered path carries none of it (SPEC §8.3).
   */
  #eachFiltered(fn: (...args: any[]) => void): void {
    const { changed, added, removed } = this.#filters!
    const ticks = this.#ticks
    const lastSeen = this.#lastSeen
    this.#lastSeen = ticks.tick

    // Removal records resolve to handle sets once per run; an empty set means
    // the conjunction cannot match and the walk is skipped outright.
    const removedSets = this.#removedSets
    for (let r = 0; r < removed.length; r++) {
      const set = (removedSets[r] ??= new Set())
      set.clear()
      ticks.collectRemoved(removed[r], lastSeen, set)
      if (set.size === 0) return
    }
    const addedTables = this.#addedTables
    for (let a = 0; a < added.length; a++) addedTables[a] = ticks.added.get(added[a])!

    const archetypes = this[$archetypes]
    const args = this.#args
    const arity = args.length - 1
    const cursors = this.#cursors
    const cursorColumns = this.#cursorColumns
    const boxedArg = this.#boxedArg
    const boxedColumn = this.#boxedColumn
    const boxedPage = this.#boxedPage
    const changedColumns = this.#changedColumns

    for (let a = archetypes.length - 1; a >= 0; a--) {
      const archetype = archetypes[a]
      const rows = archetype.rows
      if (rows === 0 || !this.#bind(archetype)) continue
      for (let t = 0; t < changed.length; t++)
        changedColumns[t] = archetype.columnsOf.get(changed[t][$id])!

      const { pageShift, pageMask } = archetype
      const cursorCount = cursors.length
      const boxedCount = boxedArg.length

      for (let page = (rows - 1) >>> pageShift, i = (rows - 1) & pageMask; page >= 0; page--) {
        const handles = archetype.entities[page]
        for (let c = 0; c < cursorCount; c++) cursors[c][$bind](cursorColumns[c], page, ticks.tick)
        for (let b = 0; b < boxedCount; b++) boxedPage[b] = boxedColumn[b].pages[page] as unknown[]

        for (; i >= 0; i--) {
          const entity = handles[i] as Entity
          if (!this.#accept(entity, page, i, lastSeen)) continue
          for (let c = 0; c < cursorCount; c++) cursors[c][$row] = i
          for (let b = 0; b < boxedCount; b++) args[boxedArg[b]] = boxedPage[b][i]
          switch (arity) {
            case 0:
              fn(entity)
              break
            case 1:
              fn(args[0], entity)
              break
            case 2:
              fn(args[0], args[1], entity)
              break
            case 3:
              fn(args[0], args[1], args[2], entity)
              break
            default:
              args[arity] = entity
              fn.apply(undefined, args)
          }
        }
        i = pageMask
      }
    }
  }

  #accept(entity: Entity, page: number, i: number, lastSeen: number): boolean {
    const changedColumns = this.#changedColumns
    for (let t = 0; t < changedColumns.length; t++) {
      const columns = changedColumns[t]
      let hit = false
      for (let c = 0; c < columns.length && !hit; c++) hit = columns[c].ticks![page][i] > lastSeen
      if (!hit) return false
    }

    const addedTables = this.#addedTables
    if (addedTables.length !== 0) {
      const id = entityId(entity)
      for (let a = 0; a < addedTables.length; a++) {
        const table = addedTables[a]
        // A row the table has never reached carries the zero tick, which is
        // exactly what lets a query's first run see pre-existing entities.
        if ((id < table.length ? table[id] : 0) <= lastSeen) return false
      }
    }

    const removedSets = this.#removedSets
    for (let r = 0; r < removedSets.length; r++) if (!removedSets[r].has(entity)) return false
    return true
  }

  public chunks(): Chunks {
    return (this.#chunks ??= new Chunks(this[$archetypes], this.#ticks))
  }

  public dispose(): void {
    this.#cache.release(this.#key, this)
  }

  /**
   * Points every slot at this archetype's columns. Returns false when a
   * required trait is not stored here at all — a sparse trait carries no mask
   * bit, so no archetype can satisfy it (SPEC §3.5).
   */
  #bind(archetype: Archetype): boolean {
    const slots = this.#slots
    const args = this.#args
    const cursors = this.#cursors
    const cursorColumns = this.#cursorColumns
    const boxedArg = this.#boxedArg
    const boxedColumn = this.#boxedColumn
    cursors.length = 0
    cursorColumns.length = 0
    boxedArg.length = 0
    boxedColumn.length = 0

    for (let s = 0; s < slots.length; s++) {
      const slot = slots[s]
      const columns = archetype.columnsOf.get(slot.trait[$id])
      if (columns === undefined) {
        if (!slot.optional) return false
        args[s] = null
      } else if (slot.cursor !== null) {
        args[s] = slot.cursor
        cursors.push(slot.cursor)
        cursorColumns.push(columns)
      } else {
        boxedArg.push(s)
        boxedColumn.push(columns[0])
      }
    }
    return true
  }
}

/** Tier 1. A plain object rather than a generator, so iteration allocates once. */
class EntityIterator implements Iterator<Entity> {
  readonly #archetypes: readonly Archetype[]
  readonly #result: IteratorResult<Entity> = { done: false, value: 0 as Entity }

  #index: number
  #row = -1

  public constructor(archetypes: readonly Archetype[]) {
    this.#archetypes = archetypes
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
      this.#row = archetypes[index].rows - 1
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

  readonly #traits: TraitRegistry
  readonly #graph: ArchetypeGraph
  readonly #ticks: Ticks
  readonly #byKey = new Map<string, QueryResult>()

  public constructor(traits: TraitRegistry, graph: ArchetypeGraph, ticks: Ticks) {
    this.#traits = traits
    this.#graph = graph
    this.#ticks = ticks
    graph.onCreate = (archetype) => this.#offer(archetype)
  }

  public get(terms: readonly Term[]): QueryResult {
    const key = signatureOf(terms)
    let query = this.#byKey.get(key)
    if (query === undefined) {
      // Before slots pick their cursor class: `Changed` promotes its trait to
      // tracked and `Added` allocates the gain table (SPEC §8.3).
      for (const term of terms) {
        if (traitOf(term) !== null) continue
        const modifier = term as Modifier
        const trait = traitOf(modifier[$terms][0] as Term)
        if (trait === null) continue
        if (modifier[$term] === 'changed') this.#graph.track(trait)
        else if (modifier[$term] === 'added') this.#ticks.trackAdded(trait[$id])
      }

      query = new QueryResult(this, key, compileTerms(this.#traits, terms), terms, this.#ticks)
      this.#byKey.set(key, query)
      this.live.push(query)

      const existing = this.#graph.list
      const matching = query[$archetypes]
      const plan = query[$plan]
      for (let i = 0; i < existing.length; i++)
        if (plan.test(existing[i].mask)) matching.push(existing[i])
    }
    return query
  }

  public release(key: string, query: QueryResult): void {
    if (!this.#byKey.delete(key)) return
    const at = this.live.indexOf(query)
    if (at >= 0) this.live.splice(at, 1)
  }

  public clear(): void {
    this.#byKey.clear()
    this.live.length = 0
    this.#graph.onCreate = null
  }

  #offer(archetype: Archetype): void {
    const live = this.live
    const mask = archetype.mask
    for (let i = 0; i < live.length; i++) {
      const query = live[i]
      if (query[$plan].test(mask)) query[$archetypes].push(archetype)
    }
  }
}
