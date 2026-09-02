import { Archetype, ArchetypeGraph } from './archetype'
import type { Column } from './column'
import { PAGE_SIZE } from './column'
import { ApecsError, assert } from './debug'
import { EntityIndex } from './entity-index'
import {
  FIRST_ENTITY_ID,
  MAX_GENERATION,
  MAX_WORLD_ID,
  NULL_ENTITY,
  WORLD_ENTITY_ID,
  entityGeneration,
  entityId,
  entityWorld,
  packEntity,
  type Entity,
} from './entity'
import { Iteration } from './iteration'
import { maskHas } from './mask'
import { QueryCache, type QueryResult } from './query'
import { TraitRegistry } from './registry'
import type { Field } from './schema'
import { SparseStore } from './sparse'
import {
  $archetypes,
  $entities,
  $id,
  $index,
  $kind,
  $options,
  $plan,
  $queries,
  $traits,
  $trait,
} from './symbols'
import type { Term } from './terms'
import { Ticks } from './ticks'
import type { Trait } from './trait'
import { initTrait, readStruct, traitOf, valueOf, writeStruct, type TraitLike } from './value'

export interface WorldOptions {
  /** Rows per column page; a power of two (SPEC §10.2). */
  pageSize?: number
  /** Pre-sizes the entity index. Not a cap — the index grows past it (SPEC §5.1). */
  maxEntities?: number
}

/** Anything that yields packed handles: an array, a `Float64Array`, a query result. */
export type EntityBatch = Iterable<number>

const DEFAULT_MAX_ENTITIES = 1 << 20
const INITIAL_FREE_CAPACITY = 64

/** World ids are an 8-bit field of every handle, so they are pooled (SPEC §4.1, §5.5). */
const freeWorldIds: number[] = []
let nextWorldId = 0

function allocWorldId(): number {
  const recycled = freeWorldIds.pop()
  if (recycled !== undefined) return recycled
  if (nextWorldId > MAX_WORLD_ID)
    throw new ApecsError(`no more than ${MAX_WORLD_ID + 1} worlds may be alive at once`)
  return nextWorldId++
}

/** Indexable batches are walked in place; anything else is snapshotted once. */
function indexed(batch: EntityBatch): ArrayLike<number> {
  const candidate = batch as unknown as ArrayLike<number>
  return typeof candidate.length === 'number' ? candidate : Array.from(batch)
}

/** `target` is defined for relations, `undefined` otherwise (SPEC §8.1). */
export type ObserverFn = (entity: Entity, target?: Entity) => void

interface Boundary {
  readonly query: QueryResult
  readonly enter: ObserverFn[]
  readonly exit: ObserverFn[]
}

/** Dev builds treat a deeper observer cascade as an infinite loop (SPEC §8.4). */
const MAX_OBSERVER_DEPTH = 32

function append(list: ObserverFn[], fn: ObserverFn): () => void {
  list.push(fn)
  return () => {
    const at = list.indexOf(fn)
    if (at >= 0) list.splice(at, 1)
  }
}

function subscribe(map: Map<Trait, ObserverFn[]>, trait: Trait, fn: ObserverFn): () => void {
  let list = map.get(trait)
  if (list === undefined) map.set(trait, (list = []))
  return append(list, fn)
}

/**
 * An isolated container of entities, archetypes and trait storage. Every method
 * lives on the prototype, and every piece of internal state is symbol- or
 * `#private`-keyed, so subclassing is safe (SPEC §5.2).
 */
export class World {
  declare readonly [$id]: number
  declare readonly [$options]: Readonly<Required<WorldOptions>>
  declare readonly [$entities]: EntityIndex
  declare readonly [$traits]: TraitRegistry
  declare readonly [$archetypes]: ArchetypeGraph
  declare readonly [$queries]: QueryCache

  /** Id 1 in every world; world traits are ordinary traits on it (SPEC §5.4). */
  declare readonly entity: Entity

  /** Ring buffer of retired ids with the generation they will come back with. */
  #freeIds = new Uint32Array(INITIAL_FREE_CAPACITY)
  #freeGenerations = new Uint16Array(INITIAL_FREE_CAPACITY)
  #freeHead = 0
  #freeTail = 0
  #freeCount = 0
  #nextId = FIRST_ENTITY_ID

  #stores = new Map<number, SparseStore>()
  #storeList: SparseStore[] = []
  #destroyed = false

  readonly #ticks = new Ticks()
  readonly #iteration = new Iteration()
  readonly #onAdd = new Map<Trait, ObserverFn[]>()
  readonly #onRemove = new Map<Trait, ObserverFn[]>()
  readonly #onChange = new Map<Trait, ObserverFn[]>()
  readonly #boundaries: Boundary[] = []
  #observerDepth = 0

  public constructor(options?: WorldOptions) {
    const pageSize = options?.pageSize ?? PAGE_SIZE
    const maxEntities = options?.maxEntities ?? DEFAULT_MAX_ENTITIES
    if (__DEV__) {
      assert(
        Number.isInteger(pageSize) && pageSize > 0 && (pageSize & (pageSize - 1)) === 0,
        `page size ${pageSize} must be a positive power of two`,
      )
      assert(
        Number.isInteger(maxEntities) && maxEntities > 0,
        `maxEntities ${maxEntities} must be a positive integer`,
      )
    }

    this[$options] = { pageSize, maxEntities }
    this[$id] = allocWorldId()
    this[$entities] = new EntityIndex(maxEntities)
    this[$traits] = new TraitRegistry()
    this[$archetypes] = new ArchetypeGraph(this[$traits], pageSize)
    this[$queries] = new QueryCache(this[$traits], this[$archetypes], this.#ticks, this.#iteration)

    const entities = this[$entities]
    const root = this[$archetypes].root
    entities.ensure(WORLD_ENTITY_ID)
    entities.generations[WORLD_ENTITY_ID] = 1
    this.entity = packEntity(WORLD_ENTITY_ID, 1, this[$id])
    entities.archetypes[WORLD_ENTITY_ID] = root.id
    entities.rows[WORLD_ENTITY_ID] = root.appendRow(this.entity)
  }

  // ---------------------------------------------------------------- lifecycle

  public spawn(...items: TraitLike[]): Entity {
    if (__DEV__) this.#assertNotDestroyed()
    const entities = this[$entities]
    const id = this.#allocId()
    const entity = packEntity(id, entities.generations[id], this[$id])

    const archetype = this.#destination(this[$archetypes].root, items, 0)
    const row = archetype.appendRow(entity)
    entities.archetypes[id] = archetype.id
    entities.rows[id] = row

    const tick = this.#ticks.tick
    for (let i = 0; i < items.length; i++) {
      const trait = traitOf(items[i])
      const value = valueOf(items[i])
      if (trait[$options].storage === 'sparse') this.#store(trait).add(id, value, tick)
      else initTrait(archetype.columnsOf.get(trait[$id]), row, trait, value, tick)
    }

    // Events fire only after every value is in place (SPEC §8.1).
    if (this.#onAdd.size !== 0 || this.#ticks.added.size !== 0) {
      for (let i = 0; i < items.length; i++) this.#attached(entity, id, traitOf(items[i]))
    }
    if (this.#boundaries.length !== 0) this.#crossed(entity, null, archetype)
    return entity
  }

  /** One archetype transition for the whole batch instead of `n` (SPEC §4.3). */
  public spawnMany(n: number, ...items: TraitLike[]): Float64Array {
    if (__DEV__) this.#assertNotDestroyed()
    const batch = new Float64Array(n > 0 ? n : 0)
    if (batch.length === 0) return batch

    const entities = this[$entities]
    const archetype = this.#destination(this[$archetypes].root, items, 0)
    const first = archetype.appendRows(n)

    for (let k = 0; k < n; k++) {
      const id = this.#allocId()
      const entity = packEntity(id, entities.generations[id], this[$id])
      const row = first + k
      batch[k] = entity
      entities.archetypes[id] = archetype.id
      entities.rows[id] = row
      archetype.setEntity(row, entity)
    }

    const tick = this.#ticks.tick
    for (let i = 0; i < items.length; i++) {
      const trait = traitOf(items[i])
      const value = valueOf(items[i])
      if (trait[$options].storage === 'sparse') {
        const store = this.#store(trait)
        for (let k = 0; k < n; k++) store.add(entityId(batch[k]), value, tick)
      } else {
        const columns = archetype.columnsOf.get(trait[$id])
        for (let k = 0; k < n; k++) initTrait(columns, first + k, trait, value, tick)
      }
    }

    // All handlers for entity n fire before those for entity n+1 (SPEC §8.4).
    if (this.#onAdd.size !== 0 || this.#ticks.added.size !== 0 || this.#boundaries.length !== 0) {
      for (let k = 0; k < n; k++) {
        const entity = batch[k] as Entity
        const id = entityId(entity)
        for (let i = 0; i < items.length; i++) this.#attached(entity, id, traitOf(items[i]))
        this.#crossed(entity, null, archetype)
      }
    }
    return batch
  }

  public despawn(entity: Entity): void {
    const id = entityId(entity)
    if (__DEV__) {
      this.#assertAlive(entity, id)
      assert(id !== WORLD_ENTITY_ID, 'the world entity cannot be despawned')
    }
    this.#despawn(entity, id)
  }

  public despawnMany(batch: EntityBatch): void {
    if (__DEV__) this.#assertNotDestroyed()
    const list = indexed(batch)
    for (let i = 0; i < list.length; i++) this.despawn(list[i] as Entity)
  }

  public isAlive(entity: Entity): boolean {
    if (__DEV__) this.#assertNotDestroyed()
    return (
      entityWorld(entity) === this[$id] &&
      this[$entities].isAlive(entityId(entity), entityGeneration(entity))
    )
  }

  // --------------------------------------------------------------- structural

  public add(target: Entity | TraitLike, ...items: TraitLike[]): void
  public add(...items: unknown[]): void {
    const world = typeof items[0] !== 'number'
    const entity = world ? this.entity : (items[0] as Entity)
    const id = entityId(entity)
    if (__DEV__) this.#assertAlive(entity, id)
    this.#add(entity, id, items as TraitLike[], world ? 0 : 1)
  }

  public addMany(batch: EntityBatch, ...items: TraitLike[]): void {
    if (__DEV__) this.#assertNotDestroyed()
    const list = indexed(batch)
    for (let i = 0; i < list.length; i++) {
      const entity = list[i] as Entity
      const id = entityId(entity)
      if (__DEV__) this.#assertAlive(entity, id)
      this.#add(entity, id, items, 0)
    }
  }

  public remove(target: Entity | TraitLike, ...traits: TraitLike[]): void
  public remove(...traits: unknown[]): void {
    const world = typeof traits[0] !== 'number'
    const entity = world ? this.entity : (traits[0] as Entity)
    const id = entityId(entity)
    if (__DEV__) this.#assertAlive(entity, id)
    this.#remove(entity, id, traits as TraitLike[], world ? 0 : 1)
  }

  public removeMany(batch: EntityBatch, ...traits: TraitLike[]): void {
    if (__DEV__) this.#assertNotDestroyed()
    const list = indexed(batch)
    for (let i = 0; i < list.length; i++) {
      const entity = list[i] as Entity
      const id = entityId(entity)
      if (__DEV__) this.#assertAlive(entity, id)
      this.#remove(entity, id, traits, 0)
    }
  }

  public has(target: Entity | Trait, trait?: Trait): boolean {
    const world = typeof target !== 'number'
    const entity = world ? this.entity : (target as Entity)
    const subject = (world ? target : trait) as Trait
    const id = entityId(entity)
    if (__DEV__) this.#assertAlive(entity, id)
    return this.#hasTrait(id, subject)
  }

  // --------------------------------------------------------------------- data

  public get(target: Entity | Trait | Field, spec?: Trait | Field | object, out?: object): any {
    const world = typeof target !== 'number'
    const entity = world ? this.entity : (target as Entity)
    const subject = (world ? target : spec) as Trait | Field
    const into = (world ? spec : out) as Record<string, unknown> | undefined
    const id = entityId(entity)
    if (__DEV__) this.#assertAlive(entity, id)

    const trait = typeof subject === 'function' ? (subject as Trait) : (subject as Field)[$trait]
    const columns = this.#columnsOf(trait, id)
    if (__DEV__) {
      assert(trait[$kind] !== 'tag', 'a tag carries no value to get')
      assert(columns !== undefined, 'this entity does not have that trait')
    }
    const row = this.#rowOf(trait, id)

    if (typeof subject !== 'function') {
      const field = subject as Field
      const raw = columns![field[$index]].get(row)
      return field.kind === 'bool' ? raw !== 0 : raw
    }
    if (trait[$kind] === 'aos') return columns![0].get(row)
    return readStruct(trait[$plan], columns!, row, into ?? {})
  }

  public set(
    target: Entity | Trait | Field,
    spec?: Trait | Field | unknown,
    value?: unknown,
  ): void {
    const world = typeof target !== 'number'
    const entity = world ? this.entity : (target as Entity)
    const subject = (world ? target : spec) as Trait | Field
    const written = world ? spec : value
    const id = entityId(entity)
    if (__DEV__) this.#assertAlive(entity, id)

    const trait = typeof subject === 'function' ? (subject as Trait) : (subject as Field)[$trait]
    const columns = this.#columnsOf(trait, id)
    if (__DEV__) {
      assert(trait[$kind] !== 'tag', 'a tag carries no value to set')
      assert(columns !== undefined, 'this entity does not have that trait')
    }
    const row = this.#rowOf(trait, id)
    const tick = this.#ticks.tick

    if (typeof subject !== 'function') {
      const column = columns![(subject as Field)[$index]]
      column.set(row, written)
      column.stamp(row, tick)
    } else if (trait[$kind] === 'aos') {
      columns![0].set(row, written)
      columns![0].stamp(row, tick)
    } else {
      writeStruct(trait[$plan], columns!, row, written as Record<string, unknown>, tick)
    }
    this.#wrote(entity, trait)
  }

  /** Stamps the change tick without touching the data (SPEC §8.3). */
  public changed(target: Entity | Trait, spec?: Trait): void {
    const world = typeof target !== 'number'
    const entity = world ? this.entity : (target as Entity)
    const trait = (world ? target : spec) as Trait
    const id = entityId(entity)
    if (__DEV__) {
      this.#assertAlive(entity, id)
      assert(this.#hasTrait(id, trait), 'this entity does not have that trait')
    }

    const columns = this.#columnsOf(trait, id)
    if (columns !== undefined) {
      const row = this.#rowOf(trait, id)
      const tick = this.#ticks.tick
      for (let i = 0; i < columns.length; i++) columns[i].stamp(row, tick)
    }
    this.#wrote(entity, trait)
  }

  // ------------------------------------------------------------------- events

  /** The monotonic change clock (SPEC §8.3). */
  public get tick(): number {
    if (__DEV__) this.#assertNotDestroyed()
    return this.#ticks.tick
  }

  /** Advances the clock one tick and expires stale removal records (SPEC §8.3). */
  public step(): void {
    if (__DEV__) this.#assertNotDestroyed()
    this.#ticks.step()
  }

  public onAdd(trait: Trait, fn: ObserverFn): () => void {
    if (__DEV__) this.#assertNotDestroyed()
    return subscribe(this.#onAdd, trait, fn)
  }

  public onRemove(trait: Trait, fn: ObserverFn): () => void {
    if (__DEV__) this.#assertNotDestroyed()
    return subscribe(this.#onRemove, trait, fn)
  }

  /** Subscribing is what promotes the trait to tracked (SPEC §8.3). */
  public onChange(trait: Trait, fn: ObserverFn): () => void {
    if (__DEV__) this.#assertNotDestroyed()
    this[$archetypes].track(trait)
    return subscribe(this.#onChange, trait, fn)
  }

  public onEnter(query: QueryResult, fn: ObserverFn): () => void {
    if (__DEV__) this.#assertNotDestroyed()
    return append(this.#boundary(query).enter, fn)
  }

  public onExit(query: QueryResult, fn: ObserverFn): () => void {
    if (__DEV__) this.#assertNotDestroyed()
    return append(this.#boundary(query).exit, fn)
  }

  // ------------------------------------------------------------------ queries

  /** O(1) after the first call: the term list is hashed to a cached result (SPEC §6.2). */
  public query(...terms: Term[]): QueryResult {
    if (__DEV__) this.#assertNotDestroyed()
    return this[$queries].get(terms)
  }

  /** The explicit hoist. Identical to what `query` hands out (SPEC §6.2). */
  public createQuery(...terms: Term[]): QueryResult {
    if (__DEV__) this.#assertNotDestroyed()
    return this[$queries].get(terms)
  }

  public queryFirst(...terms: Term[]): Entity | undefined {
    if (__DEV__) this.#assertNotDestroyed()
    return this[$queries].get(terms).first
  }

  // ----------------------------------------------------------------- deferral

  /** Queues work for `flush`, which the outermost `each` / `chunks` exit runs (SPEC §9). */
  public defer(fn: () => void): void {
    if (__DEV__) this.#assertNotDestroyed()
    this.#iteration.defer(fn)
  }

  public flush(): void {
    if (__DEV__) this.#assertNotDestroyed()
    this.#iteration.flush()
  }

  // -------------------------------------------------------------------- world

  /** Despawns every entity but the world's own; archetypes and pages stay allocated (SPEC §5.5). */
  public clear(): void {
    if (__DEV__) this.#assertNotDestroyed()
    this.#clear()
  }

  /** Releases the empty tail pages that despawns leave behind (SPEC §10.2). */
  public compact(): void {
    if (__DEV__) this.#assertNotDestroyed()
    const archetypes = this[$archetypes].list
    for (let i = 0; i < archetypes.length; i++) archetypes[i].compact()
    const stores = this.#storeList
    for (let i = 0; i < stores.length; i++) stores[i].compact()
  }

  public destroy(): void {
    if (this.#destroyed) return
    this.#clear()
    // The world entity goes down with the world; its traits get their `onRemove` too.
    if (this.#onRemove.size !== 0) this.#removing(this.entity, WORLD_ENTITY_ID)
    this.#destroyed = true
    this[$queries].clear()
    this[$archetypes].dispose()
    this.#stores.clear()
    this.#storeList.length = 0
    this.#onAdd.clear()
    this.#onRemove.clear()
    this.#onChange.clear()
    this.#boundaries.length = 0
    this.#iteration.clear()
    freeWorldIds.push(this[$id])
  }

  // ----------------------------------------------------------------- internal

  #archetypeOf(id: number): Archetype {
    return this[$archetypes].list[this[$entities].archetypes[id]]
  }

  #despawn(entity: Entity, id: number): void {
    if (this.#onRemove.size !== 0) this.#removing(entity, id)
    if (this.#boundaries.length !== 0) this.#crossed(entity, this.#archetypeOf(id), null)
    this.#release(id)
  }

  /**
   * Highest id first, so most removals take the archetype tail and swap nothing.
   * The index is re-read per id: an `onRemove` handler may spawn and grow it.
   */
  #clear(): void {
    for (let id = this.#nextId - 1; id >= FIRST_ENTITY_ID; id--) {
      const generation = this[$entities].generations[id]
      if (generation !== 0) this.#despawn(packEntity(id, generation, this[$id]), id)
    }
  }

  /** `onRemove` for every trait the entity holds, while its data is still intact (SPEC §8.1). */
  #removing(entity: Entity, id: number): void {
    for (const [trait, list] of this.#onRemove) {
      if (list.length !== 0 && this.#hasTrait(id, trait)) this.#dispatch(list, entity)
    }
  }

  #hasTrait(id: number, trait: Trait): boolean {
    if (trait[$options].storage === 'sparse') {
      const store = this.#stores.get(trait[$id])
      return store !== undefined && store.slotOf(id) >= 0
    }
    const local = this[$traits].localId(trait)
    return local >= 0 && maskHas(this.#archetypeOf(id).mask, local)
  }

  /** Handlers run immediately and may recurse into structural ops (SPEC §8.1, §8.4). */
  #dispatch(list: ObserverFn[], entity: Entity): void {
    if (__DEV__) {
      assert(
        this.#observerDepth < MAX_OBSERVER_DEPTH,
        `observer cascade exceeded ${MAX_OBSERVER_DEPTH} levels — ` +
          'an observer keeps triggering the operation it observes',
      )
      this.#observerDepth++
      try {
        for (let i = 0; i < list.length; i++) list[i](entity)
      } finally {
        this.#observerDepth--
      }
    } else {
      for (let i = 0; i < list.length; i++) list[i](entity)
    }
  }

  #wrote(entity: Entity, trait: Trait): void {
    const list = this.#onChange.get(trait)
    if (list !== undefined && list.length !== 0) this.#dispatch(list, entity)
  }

  /** The trait was just attached: records the gain and fires `onAdd`. */
  #attached(entity: Entity, id: number, trait: Trait): void {
    if (this.#ticks.added.size !== 0) this.#ticks.stampAdded(trait[$id], id)
    const list = this.#onAdd.get(trait)
    if (list !== undefined && list.length !== 0) this.#dispatch(list, entity)
  }

  /** Fires enter/exit for the queries whose match boundary the move crossed (SPEC §8.2). */
  #crossed(entity: Entity, from: Archetype | null, to: Archetype | null): void {
    const boundaries = this.#boundaries
    for (let i = 0; i < boundaries.length; i++) {
      const boundary = boundaries[i]
      const plan = boundary.query[$plan]
      const before = from !== null && plan.test(from.mask)
      const after = to !== null && plan.test(to.mask)
      if (before === after) continue
      const list = after ? boundary.enter : boundary.exit
      if (list.length !== 0) this.#dispatch(list, entity)
    }
  }

  #boundary(query: QueryResult): Boundary {
    const boundaries = this.#boundaries
    for (let i = 0; i < boundaries.length; i++) {
      if (boundaries[i].query === query) return boundaries[i]
    }
    const boundary: Boundary = { query, enter: [], exit: [] }
    boundaries.push(boundary)
    return boundary
  }

  /** The columns holding `trait` for `id`, or undefined when it does not have it. */
  #columnsOf(trait: Trait, id: number): Column[] | undefined {
    if (trait[$options].storage !== 'sparse') {
      return this.#archetypeOf(id).columnsOf.get(trait[$id])
    }
    const store = this.#stores.get(trait[$id])
    return store !== undefined && store.slotOf(id) >= 0 ? store.columns : undefined
  }

  #rowOf(trait: Trait, id: number): number {
    return trait[$options].storage === 'sparse'
      ? this.#stores.get(trait[$id])!.slotOf(id)
      : this[$entities].rows[id]
  }

  #store(trait: Trait): SparseStore {
    let store = this.#stores.get(trait[$id])
    if (store === undefined) {
      this[$traits].register(trait)
      store = new SparseStore(trait, this[$options].pageSize)
      this.#stores.set(trait[$id], store)
      this.#storeList.push(store)
    }
    return store
  }

  /** Walks the add edges once per table trait; sparse traits leave the graph alone. */
  #destination(from: Archetype, items: readonly TraitLike[], start: number): Archetype {
    const graph = this[$archetypes]
    let to = from
    for (let i = start; i < items.length; i++) {
      const trait = traitOf(items[i])
      if (trait[$options].storage === 'sparse') continue
      const local = this[$traits].register(trait)
      if (!maskHas(to.mask, local)) to = graph.edgeAdd(to, local)
    }
    return to
  }

  #add(entity: Entity, id: number, items: readonly TraitLike[], start: number): void {
    const from = this.#archetypeOf(id)
    const to = this.#destination(from, items, start)
    const row = to === from ? this[$entities].rows[id] : this.#move(id, entity, from, to)
    const tick = this.#ticks.tick

    // Freshly attached traits, collected so events fire only after every value
    // is in place — a handler may itself mutate, which would stale `to`/`row`.
    const announce = this.#onAdd.size !== 0 || this.#ticks.added.size !== 0
    let fresh: Trait[] | null = null

    for (let i = start; i < items.length; i++) {
      const trait = traitOf(items[i])
      const value = valueOf(items[i])
      if (trait[$options].storage === 'sparse') {
        if (this.#store(trait).add(id, value, tick) && announce) (fresh ??= []).push(trait)
      } else if (!maskHas(from.mask, this[$traits].localId(trait))) {
        initTrait(to.columnsOf.get(trait[$id]), row, trait, value, tick)
        if (announce) (fresh ??= []).push(trait)
      } else if (value !== undefined) {
        // A re-add without a value leaves the data alone; with one it re-seeds
        // the row from the defaults before writing (SPEC §4.4).
        initTrait(to.columnsOf.get(trait[$id]), row, trait, value, tick)
      }
    }

    if (fresh !== null) {
      for (let i = 0; i < fresh.length; i++) this.#attached(entity, id, fresh[i])
    }
    if (to !== from && this.#boundaries.length !== 0) this.#crossed(entity, from, to)
  }

  #remove(entity: Entity, id: number, traits: readonly TraitLike[], start: number): void {
    // `onRemove` runs first, while the data is still intact (SPEC §8.1). The
    // transition is computed afterwards because handlers may themselves mutate.
    if (this.#onRemove.size !== 0) {
      for (let i = start; i < traits.length; i++) {
        const trait = traitOf(traits[i])
        const list = this.#onRemove.get(trait)
        if (list !== undefined && list.length !== 0 && this.#hasTrait(id, trait)) {
          this.#dispatch(list, entity)
        }
      }
    }

    const graph = this[$archetypes]
    const ticks = this.#ticks
    const from = this.#archetypeOf(id)
    let to = from
    for (let i = start; i < traits.length; i++) {
      const trait = traitOf(traits[i])
      if (trait[$options].storage === 'sparse') {
        const store = this.#stores.get(trait[$id])
        if (store !== undefined && store.remove(id)) ticks.logRemoved(entity, trait[$id])
        continue
      }
      const local = this[$traits].localId(trait)
      if (local >= 0 && maskHas(to.mask, local)) {
        to = graph.edgeRemove(to, local)
        ticks.logRemoved(entity, trait[$id])
      }
    }
    if (to !== from) {
      this.#move(id, entity, from, to)
      if (this.#boundaries.length !== 0) this.#crossed(entity, from, to)
    }
  }

  /** Appends to `to`, carries the shared columns across, swap-removes from `from`. */
  #move(id: number, entity: Entity, from: Archetype, to: Archetype): number {
    const entities = this[$entities]
    const source = entities.rows[id]
    if (__DEV__) this.#iteration.assertRemovable(from, source)
    const destination = to.appendRow(entity)

    const traitIds = from.traitIds
    const groups = from.traitColumns
    for (let t = 0; t < traitIds.length; t++) {
      const target = to.columnsOf.get(traitIds[t])
      if (target === undefined) continue
      const columns = groups[t]
      for (let i = 0; i < columns.length; i++) {
        target[i].set(destination, columns[i].get(source))
        target[i].moveTick(destination, columns[i], source)
      }
    }

    const moved = from.removeRow(source)
    if (moved !== NULL_ENTITY) entities.rows[entityId(moved)] = source
    entities.archetypes[id] = to.id
    entities.rows[id] = destination
    return destination
  }

  #release(id: number): void {
    const entities = this[$entities]
    const row = entities.rows[id]
    const archetype = this.#archetypeOf(id)
    if (__DEV__) this.#iteration.assertRemovable(archetype, row)
    const moved = archetype.removeRow(row)
    if (moved !== NULL_ENTITY) entities.rows[entityId(moved)] = row

    const stores = this.#storeList
    for (let i = 0; i < stores.length; i++) stores[i].remove(id)

    const generation = entities.generations[id]
    entities.generations[id] = 0
    entities.archetypes[id] = 0
    entities.rows[id] = 0
    // The generation field is 12 bits; on wrap the id is retired, never reissued,
    // so a stale handle can never alias a live row (SPEC §4.1).
    if (generation < MAX_GENERATION) this.#recycle(id, generation + 1)
  }

  #allocId(): number {
    let id: number
    let generation: number
    if (this.#freeCount > 0) {
      const head = this.#freeHead
      id = this.#freeIds[head]
      generation = this.#freeGenerations[head]
      this.#freeHead = (head + 1) & (this.#freeIds.length - 1)
      this.#freeCount--
    } else {
      id = this.#nextId++
      generation = 1
    }
    const entities = this[$entities]
    entities.ensure(id)
    entities.generations[id] = generation
    return id
  }

  /** FIFO, so a freed id is not immediately reissued (SPEC §4.2). */
  #recycle(id: number, generation: number): void {
    const capacity = this.#freeIds.length
    if (this.#freeCount === capacity) {
      const ids = new Uint32Array(capacity * 2)
      const generations = new Uint16Array(capacity * 2)
      for (let i = 0; i < capacity; i++) {
        const slot = (this.#freeHead + i) & (capacity - 1)
        ids[i] = this.#freeIds[slot]
        generations[i] = this.#freeGenerations[slot]
      }
      this.#freeIds = ids
      this.#freeGenerations = generations
      this.#freeHead = 0
      this.#freeTail = capacity
    }
    const tail = this.#freeTail
    this.#freeIds[tail] = id
    this.#freeGenerations[tail] = generation
    this.#freeTail = (tail + 1) & (this.#freeIds.length - 1)
    this.#freeCount++
  }

  #assertNotDestroyed(): void {
    assert(!this.#destroyed, 'this world has been destroyed')
  }

  #assertAlive(entity: Entity, id: number): void {
    this.#assertNotDestroyed()
    assert(
      entityWorld(entity) === this[$id],
      `entity ${entity} belongs to world ${entityWorld(entity)}, not ${this[$id]}`,
    )
    assert(this[$entities].isAlive(id, entityGeneration(entity)), `entity ${entity} is not alive`)
  }
}
