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
import { maskHas } from './mask'
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
  $traits,
  $trait,
} from './symbols'
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
    const entities = this[$entities]
    const id = this.#allocId()
    const entity = packEntity(id, entities.generations[id], this[$id])

    const archetype = this.#destination(this[$archetypes].root, items, 0)
    const row = archetype.appendRow(entity)
    entities.archetypes[id] = archetype.id
    entities.rows[id] = row

    for (let i = 0; i < items.length; i++) {
      const trait = traitOf(items[i])
      const value = valueOf(items[i])
      if (trait[$options].storage === 'sparse') this.#store(trait).add(id, value)
      else initTrait(archetype.columnsOf.get(trait[$id]), row, trait, value)
    }
    return entity
  }

  /** One archetype transition for the whole batch instead of `n` (SPEC §4.3). */
  public spawnMany(n: number, ...items: TraitLike[]): Float64Array {
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

    for (let i = 0; i < items.length; i++) {
      const trait = traitOf(items[i])
      const value = valueOf(items[i])
      if (trait[$options].storage === 'sparse') {
        const store = this.#store(trait)
        for (let k = 0; k < n; k++) store.add(entityId(batch[k]), value)
      } else {
        const columns = archetype.columnsOf.get(trait[$id])
        for (let k = 0; k < n; k++) initTrait(columns, first + k, trait, value)
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
    this.#release(id)
  }

  public despawnMany(batch: EntityBatch): void {
    const list = indexed(batch)
    for (let i = 0; i < list.length; i++) this.despawn(list[i] as Entity)
  }

  public isAlive(entity: Entity): boolean {
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

    if (subject[$options].storage === 'sparse') {
      const store = this.#stores.get(subject[$id])
      return store !== undefined && store.slotOf(id) >= 0
    }
    const local = this[$traits].localId(subject)
    return local >= 0 && maskHas(this.#archetypeOf(id).mask, local)
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

    if (typeof subject !== 'function') columns![(subject as Field)[$index]].set(row, written)
    else if (trait[$kind] === 'aos') columns![0].set(row, written)
    else writeStruct(trait[$plan], columns!, row, written as Record<string, unknown>)
  }

  // -------------------------------------------------------------------- world

  public destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#stores.clear()
    this.#storeList.length = 0
    freeWorldIds.push(this[$id])
  }

  // ----------------------------------------------------------------- internal

  #archetypeOf(id: number): Archetype {
    return this[$archetypes].list[this[$entities].archetypes[id]]
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

    for (let i = start; i < items.length; i++) {
      const trait = traitOf(items[i])
      const value = valueOf(items[i])
      if (trait[$options].storage === 'sparse') {
        this.#store(trait).add(id, value)
      } else if (value !== undefined || !maskHas(from.mask, this[$traits].localId(trait))) {
        // A re-add without a value leaves the data alone; with one it re-seeds
        // the row from the defaults before writing (SPEC §4.4).
        initTrait(to.columnsOf.get(trait[$id]), row, trait, value)
      }
    }
  }

  #remove(entity: Entity, id: number, traits: readonly TraitLike[], start: number): void {
    const graph = this[$archetypes]
    const from = this.#archetypeOf(id)
    let to = from
    for (let i = start; i < traits.length; i++) {
      const trait = traitOf(traits[i])
      if (trait[$options].storage === 'sparse') {
        this.#stores.get(trait[$id])?.remove(id)
        continue
      }
      const local = this[$traits].localId(trait)
      if (local >= 0 && maskHas(to.mask, local)) to = graph.edgeRemove(to, local)
    }
    if (to !== from) this.#move(id, entity, from, to)
  }

  /** Appends to `to`, carries the shared columns across, swap-removes from `from`. */
  #move(id: number, entity: Entity, from: Archetype, to: Archetype): number {
    const entities = this[$entities]
    const source = entities.rows[id]
    const destination = to.appendRow(entity)

    const traitIds = from.traitIds
    const groups = from.traitColumns
    for (let t = 0; t < traitIds.length; t++) {
      const target = to.columnsOf.get(traitIds[t])
      if (target === undefined) continue
      const columns = groups[t]
      for (let i = 0; i < columns.length; i++) target[i].set(destination, columns[i].get(source))
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
    const moved = this.#archetypeOf(id).removeRow(row)
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

  #assertAlive(entity: Entity, id: number): void {
    assert(
      entityWorld(entity) === this[$id],
      `entity ${entity} belongs to world ${entityWorld(entity)}, not ${this[$id]}`,
    )
    assert(this[$entities].isAlive(id, entityGeneration(entity)), `entity ${entity} is not alive`)
  }
}
