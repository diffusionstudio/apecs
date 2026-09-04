import { accessorField, createAccessor, type Accessor, type AccessorHost } from './accessor'
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
import { maskHas, type Mask } from './mask'
import { QueryCache, type QueryResult } from './query'
import { TraitRegistry } from './registry'
import {
  WILDCARD,
  isExclusive,
  isRelation,
  pairOf,
  pairsTo,
  peekPair,
  releasePair,
  type Pair,
  type Relation,
} from './relation'
import type { Field, Schema } from './schema'
import { SparseStore } from './sparse'
import {
  $archetypes,
  $entities,
  $fields,
  $id,
  $index,
  $kind,
  $options,
  $plan,
  $queries,
  $relation,
  $relations,
  $sparse,
  $target,
  $traits,
  $trait,
} from './symbols'
import { Relations } from './targets'
import type { Term } from './terms'
import type { Init, Value } from './types'
import { Ticks } from './ticks'
import type { Trait, TraitInstance } from './trait'
import {
  decode,
  initTrait,
  readStruct,
  targetOf,
  traitOf,
  valueOf,
  writeStruct,
  type TraitLike,
} from './value'

export interface WorldOptions {
  /** Rows per column page; a power of two (SPEC §10.2). */
  pageSize?: number
  /** Pre-sizes the entity index. Not a cap — the index grows past it (SPEC §5.1). */
  maxEntities?: number
}

/** Anything that yields packed handles: an array, a `Float64Array`, a query result. */
export type EntityBatch = Iterable<number>

/** What `get` and `set` address: a trait, one of its fields, or a relation pair (SPEC §4.4, §7.3). */
export type Subject = Trait | Field | TraitInstance

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
  readonly query: QueryResult<any>
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

/** Observers key on the trait, or on the interned pair for `R(target)` (SPEC §8.1). */
function observerKey(item: TraitLike): Trait {
  if (typeof item === 'function') return item
  const target = item[$target]
  return typeof target === 'number' && target !== NULL_ENTITY
    ? pairOf(item[$trait] as Relation, target)
    : item[$trait]
}

function subscribe(map: Map<Trait, ObserverFn[]>, item: TraitLike, fn: ObserverFn): () => void {
  const key = observerKey(item)
  let list = map.get(key)
  if (list === undefined) map.set(key, (list = []))
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
  declare readonly [$relations]: Relations
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
  #accessors = new Map<Field, Accessor<unknown>>()
  #host: AccessorHost | null = null
  #destroyed = false

  readonly #ticks = new Ticks()
  readonly #iteration = new Iteration()
  readonly #onAdd = new Map<Trait, ObserverFn[]>()
  readonly #onRemove = new Map<Trait, ObserverFn[]>()
  readonly #onChange = new Map<Trait, ObserverFn[]>()
  readonly #boundaries: Boundary[] = []
  #observerDepth = 0
  /** Sources an `onTargetDespawn: 'despawn'` queued; drained iteratively, never recursed (SPEC §7.5). */
  readonly #pending: number[] = []

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
    this[$relations] = new Relations(this[$traits])
    this[$queries] = new QueryCache(
      this[$traits],
      this[$relations],
      this[$archetypes],
      this[$entities],
      this.#ticks,
      this.#iteration,
    )

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
    // Resolved before the id is taken, so a rejected item leaves nothing half-made.
    const archetype = this.#destination(this[$archetypes].root, items, 0)
    const entities = this[$entities]
    const id = this.#allocId()
    const entity = packEntity(id, entities.generations[id], this[$id])
    const row = archetype.appendRow(entity)
    entities.archetypes[id] = archetype.id
    entities.rows[id] = row

    const tick = this.#ticks.tick
    for (let i = 0; i < items.length; i++) {
      const trait = traitOf(items[i])
      const value = valueOf(items[i])
      if (trait[$sparse]) this.#store(trait).add(id, value, tick)
      else {
        const columns = archetype.columnsOf.get(trait[$id])
        initTrait(columns, row, trait, value, tick)
        if (isExclusive(trait))
          this.#link(trait, entity, id, columns!, row, targetOf(items[i]) as Entity, tick)
      }
    }

    // Events fire only after every value is in place (SPEC §8.1).
    if (this.#onAdd.size !== 0 || this.#ticks.added.size !== 0) {
      for (let i = 0; i < items.length; i++)
        this.#attached(entity, id, traitOf(items[i]), targetOf(items[i]) as Entity)
    }
    if (this.#boundaries.length !== 0) this.#crossed(entity, null, archetype)
    return entity
  }

  /** One archetype transition for the whole batch instead of `n` (SPEC §4.3). */
  public spawnMany(n: number, ...items: TraitLike[]): Float64Array {
    if (__DEV__) this.#assertNotDestroyed()
    if (!(n > 0)) return new Float64Array(0)
    const archetype = this.#destination(this[$archetypes].root, items, 0)
    const batch = new Float64Array(n)
    const entities = this[$entities]
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
      if (trait[$sparse]) {
        const store = this.#store(trait)
        for (let k = 0; k < n; k++) store.add(entityId(batch[k]), value, tick)
      } else {
        const columns = archetype.columnsOf.get(trait[$id])
        for (let k = 0; k < n; k++) initTrait(columns, first + k, trait, value, tick)
        if (isExclusive(trait)) {
          const target = targetOf(items[i]) as Entity
          for (let k = 0; k < n; k++) {
            const entity = batch[k] as Entity
            this.#link(trait, entity, entityId(entity), columns!, first + k, target, tick)
          }
        }
      }
    }

    // All handlers for entity n fire before those for entity n+1 (SPEC §8.4).
    if (this.#onAdd.size !== 0 || this.#ticks.added.size !== 0 || this.#boundaries.length !== 0) {
      for (let k = 0; k < n; k++) {
        const entity = batch[k] as Entity
        const id = entityId(entity)
        for (let i = 0; i < items.length; i++)
          this.#attached(entity, id, traitOf(items[i]), targetOf(items[i]) as Entity)
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
    this.#drain()
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

  public has(target: Entity | TraitLike, item?: TraitLike): boolean {
    const world = typeof target !== 'number'
    const entity = world ? this.entity : (target as Entity)
    const subject = (world ? target : item) as TraitLike
    const id = entityId(entity)
    if (__DEV__) this.#assertAlive(entity, id)
    return this.#has(id, subject)
  }

  // --------------------------------------------------------------------- data

  public get<S extends Schema>(entity: Entity, trait: TraitLike<S>, out?: Value<S>): Value<S>
  public get<V>(entity: Entity, field: Field<V>): V
  public get<S extends Schema>(trait: TraitLike<S>, out?: Value<S>): Value<S>
  public get<V>(field: Field<V>): V
  public get(target: Entity | Subject, spec?: Subject | object, out?: object): any {
    if (typeof target !== 'number') return this.get(this.entity, target as Trait, spec as object)
    const id = entityId(target)
    if (__DEV__) this.#assertAlive(target, id)
    const subject = spec as Subject
    if (typeof subject !== 'function' && $index in subject)
      return this.#getField(id, subject as Field)
    return this.#getTrait(id, traitOf(subject as TraitLike), out)
  }

  public set<S extends Schema>(entity: Entity, trait: TraitLike<S>, value: Init<S>): void
  public set<V>(entity: Entity, field: Field<V>, value: V): void
  public set<S extends Schema>(trait: TraitLike<S>, value: Init<S>): void
  public set<V>(field: Field<V>, value: V): void
  public set(target: Entity | Subject, spec?: Subject | unknown, value?: unknown): void {
    if (typeof target !== 'number') return this.set(this.entity, target as Trait, spec)
    const id = entityId(target)
    if (__DEV__) this.#assertAlive(target, id)
    const subject = spec as Subject
    if (typeof subject !== 'function' && $index in subject)
      this.#setField(target, id, subject as Field, value)
    else this.#setTrait(target, id, traitOf(subject as TraitLike), value)
  }

  public accessor<V>(field: Field<V>): Accessor<V>
  public accessor<S extends () => unknown>(trait: Trait<S>): Accessor<ReturnType<S>>
  public accessor(subject: Field | Trait): Accessor<unknown> {
    if (__DEV__) this.#assertNotDestroyed()
    const field = accessorField(subject)
    let accessor = this.#accessors.get(field)
    if (accessor === undefined) {
      this.#host ??= {
        entities: this[$entities],
        archetypes: this[$archetypes].list,
        ticks: this.#ticks,
        changed: this.#onChange,
        wrote: (entity, id, trait) => this.#emitChange(entity, id, trait),
        store: (trait) => this.#store(trait),
        assertAlive: (entity, id) => this.#assertAlive(entity, id),
      }
      this.#accessors.set(field, (accessor = createAccessor(this.#host, field)))
    }
    return accessor
  }

  /** Stamps the change tick without touching the data (SPEC §8.3). */
  public changed(target: Entity | TraitLike, spec?: TraitLike): void {
    const world = typeof target !== 'number'
    const entity = world ? this.entity : (target as Entity)
    const trait = traitOf((world ? target : spec) as TraitLike)
    const id = entityId(entity)
    if (__DEV__) {
      this.#assertAlive(entity, id)
      assert(this.#hasTrait(id, trait), 'this entity does not have that trait')
    }

    const row = this.#rowOf(trait, id)
    const columns = this.#columnsAt(trait, id, row)
    if (columns !== undefined) {
      const tick = this.#ticks.tick
      for (let i = 0; i < columns.length; i++) columns[i].stamp(row, tick)
    }
    this.#wrote(entity, id, trait)
  }

  // ---------------------------------------------------------------- relations

  /** The one target of an exclusive relation, or `NULL_ENTITY` (SPEC §7.3). */
  public target(entity: Entity, relation: Relation): Entity {
    const id = entityId(entity)
    if (__DEV__) {
      this.#assertAlive(entity, id)
      assert(
        isExclusive(relation),
        'target() reads an exclusive relation — targets() iterates the rest (SPEC §7.3)',
      )
    }
    return this.#targetOf(id, relation)
  }

  /** Every target of a relation on `entity`; a cold-path copy (SPEC §7.3). */
  public targets(entity: Entity, relation: Relation): Entity[] {
    const id = entityId(entity)
    if (__DEV__) this.#assertAlive(entity, id)
    if (isExclusive(relation)) {
      const target = this.#targetOf(id, relation)
      return target === NULL_ENTITY ? [] : [target]
    }
    const pairs: Pair[] = []
    this.#pairsIn(this.#archetypeOf(id).mask, relation, pairs)
    const out: Entity[] = new Array(pairs.length)
    for (let i = 0; i < pairs.length; i++) out[i] = pairs[i][$target]
    return out
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

  public onAdd(trait: TraitLike, fn: ObserverFn): () => void {
    if (__DEV__) this.#assertNotDestroyed()
    return subscribe(this.#onAdd, trait, fn)
  }

  public onRemove(trait: TraitLike, fn: ObserverFn): () => void {
    if (__DEV__) this.#assertNotDestroyed()
    return subscribe(this.#onRemove, trait, fn)
  }

  /** Subscribing is what promotes the trait to tracked (SPEC §8.3). */
  public onChange(trait: TraitLike, fn: ObserverFn): () => void {
    if (__DEV__) this.#assertNotDestroyed()
    this[$queries].track(observerKey(trait))
    return subscribe(this.#onChange, trait, fn)
  }

  public onEnter(query: QueryResult<any>, fn: ObserverFn): () => void {
    if (__DEV__) this.#assertNotDestroyed()
    return append(this.#boundary(query).enter, fn)
  }

  public onExit(query: QueryResult<any>, fn: ObserverFn): () => void {
    if (__DEV__) this.#assertNotDestroyed()
    return append(this.#boundary(query).exit, fn)
  }

  // ------------------------------------------------------------------ queries

  /** O(1) after the first call: the term list is hashed to a cached result (SPEC §6.2). */
  public query<const T extends readonly Term[]>(...terms: T): QueryResult<T> {
    if (__DEV__) this.#assertNotDestroyed()
    return this[$queries].get(terms) as QueryResult<T>
  }

  /** The explicit hoist. Identical to what `query` hands out (SPEC §6.2). */
  public createQuery<const T extends readonly Term[]>(...terms: T): QueryResult<T> {
    if (__DEV__) this.#assertNotDestroyed()
    return this[$queries].get(terms) as QueryResult<T>
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
    this[$relations].clear()
    this.#stores.clear()
    this.#storeList.length = 0
    this.#accessors.clear()
    this.#onAdd.clear()
    this.#onRemove.clear()
    this.#onChange.clear()
    this.#boundaries.length = 0
    this.#iteration.clear()
    this.#pending.length = 0
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
    this.#resolveTargets(entity)
    if (this[$archetypes].refs.length !== 0) this.#patchRefs(entity)
  }

  /** Despawns what a `'despawn'` policy queued, each of which may queue more (SPEC §7.5). */
  #drain(): void {
    const pending = this.#pending
    while (pending.length !== 0) {
      const entity = pending.pop()! as Entity
      const id = entityId(entity)
      if (this[$entities].isAlive(id, entityGeneration(entity))) this.#despawn(entity, id)
    }
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
    this.#drain()
  }

  /** `onRemove` for every trait the entity holds, while its data is still intact (SPEC §8.1). */
  #removing(entity: Entity, id: number): void {
    for (const [key, list] of this.#onRemove) {
      if (list.length === 0) continue
      const relation = (key as Pair)[$relation]
      if (relation !== undefined) {
        const target = (key as Pair)[$target]
        const held = isExclusive(relation)
          ? this.#targetOf(id, relation) === target
          : this.#hasTrait(id, key)
        if (held) this.#dispatch(list, entity, target)
      } else if (isExclusive(key)) {
        const target = this.#targetOf(id, key)
        if (target !== NULL_ENTITY) this.#dispatch(list, entity, target)
      } else if (isRelation(key)) {
        const pairs: Pair[] = []
        this.#pairsIn(this.#archetypeOf(id).mask, key, pairs)
        for (let i = 0; i < pairs.length; i++) this.#dispatch(list, entity, pairs[i][$target])
      } else if (this.#hasTrait(id, key)) this.#dispatch(list, entity, undefined)
    }
  }

  #hasTrait(id: number, trait: Trait): boolean {
    if (trait[$sparse]) {
      const store = this.#stores.get(trait[$id])
      return store !== undefined && store.slotOf(id) >= 0
    }
    const local = this[$traits].localId(trait)
    return local >= 0 && maskHas(this.#archetypeOf(id).mask, local)
  }

  /** `has` with a target also checks the target: the column for an exclusive relation (SPEC §7.2). */
  #has(id: number, item: TraitLike): boolean {
    const trait = traitOf(item)
    if (!this.#hasTrait(id, trait)) return false
    const target = targetOf(item)
    return (
      typeof target !== 'number' ||
      target === NULL_ENTITY ||
      !isExclusive(trait) ||
      this.#targetOf(id, trait) === target
    )
  }

  #targetOf(id: number, relation: Relation): Entity {
    const columns = this.#archetypeOf(id).columnsOf.get(relation[$id])
    if (columns === undefined) return NULL_ENTITY
    return columns[columns.length - 1].get(this[$entities].rows[id]) as Entity
  }

  /** The pairs of `relation` set in `mask`; returns how many, pushing them into `into`. */
  #pairsIn(mask: Mask, relation: Relation, into: Pair[] | null): number {
    const traits = this[$traits].list
    let found = 0
    for (let block = 0; block < mask.length; block++) {
      let bits = mask[block]
      while (bits !== 0) {
        const lowest = bits & -bits
        bits ^= lowest
        const trait = traits[(block << 5) + (31 - Math.clz32(lowest))]
        if ((trait as Pair)[$relation] !== relation) continue
        found++
        into?.push(trait as Pair)
      }
    }
    return found
  }

  /** Handlers run immediately and may recurse into structural ops (SPEC §8.1, §8.4). */
  #dispatch(list: ObserverFn[], entity: Entity, target: Entity | undefined): void {
    if (__DEV__) {
      assert(
        this.#observerDepth < MAX_OBSERVER_DEPTH,
        `observer cascade exceeded ${MAX_OBSERVER_DEPTH} levels — ` +
          'an observer keeps triggering the operation it observes',
      )
      this.#observerDepth++
      try {
        for (let i = 0; i < list.length; i++) list[i](entity, target)
      } finally {
        this.#observerDepth--
      }
    } else {
      for (let i = 0; i < list.length; i++) list[i](entity, target)
    }
  }

  /**
   * Fires the lists an event on `trait` reaches: a pair's own and its
   * relation's; an exclusive relation's own and, if one was ever subscribed,
   * the pair for its target; a plain trait's own, with no target (SPEC §8.1).
   */
  #emit(map: Map<Trait, ObserverFn[]>, entity: Entity, trait: Trait, target: Entity): void {
    const relation = (trait as Pair)[$relation]
    if (relation !== undefined) {
      this.#fire(map.get(relation), entity, (trait as Pair)[$target])
      this.#fire(map.get(trait), entity, (trait as Pair)[$target])
    } else if (target !== NULL_ENTITY) {
      this.#fire(map.get(trait), entity, target)
      const pair = peekPair(trait as Relation, target)
      if (pair !== undefined) this.#fire(map.get(pair), entity, target)
    } else this.#fire(map.get(trait), entity, undefined)
  }

  #fire(list: ObserverFn[] | undefined, entity: Entity, target: Entity | undefined): void {
    if (list !== undefined && list.length !== 0) this.#dispatch(list, entity, target)
  }

  #wrote(entity: Entity, id: number, trait: Trait): void {
    if (this.#onChange.size !== 0) this.#emitChange(entity, id, trait)
  }

  #emitChange(entity: Entity, id: number, trait: Trait): void {
    const target = isExclusive(trait) ? this.#targetOf(id, trait) : NULL_ENTITY
    this.#emit(this.#onChange, entity, trait, target)
  }

  /** The trait was just attached: records the gain and fires `onAdd`. */
  #attached(entity: Entity, id: number, trait: Trait, target: Entity): void {
    if (this.#ticks.added.size !== 0) {
      this.#ticks.stampAdded(trait[$id], id)
      const relation = (trait as Pair)[$relation]
      if (relation !== undefined) this.#ticks.stampAdded(relation[$id], id)
    }
    if (this.#onAdd.size !== 0) this.#emit(this.#onAdd, entity, trait, target)
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
      if (list.length !== 0) this.#dispatch(list, entity, undefined)
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

  /** The row `id` occupies for `trait`, then the columns holding it: two calls rather than one allocation. */
  #rowOf(trait: Trait, id: number): number {
    return trait[$sparse] ? this.#sparseRow(trait, id) : this[$entities].rows[id]
  }

  /** `undefined` when `id` lacks the trait; `row` is what `#rowOf` returned. */
  #columnsAt(trait: Trait, id: number, row: number): Column[] | undefined {
    return trait[$sparse]
      ? this.#sparseColumns(trait, row)
      : this.#archetypeOf(id).columnsOf.get(trait[$id])
  }

  #sparseRow(trait: Trait, id: number): number {
    const store = this.#stores.get(trait[$id])
    return store === undefined ? -1 : store.slotOf(id)
  }

  #sparseColumns(trait: Trait, row: number): Column[] | undefined {
    return row < 0 ? undefined : this.#stores.get(trait[$id])!.columns
  }

  /**
   * One column of a table trait, page math inlined. This and `#setField` are
   * the hot halves of `get` / `set`; everything else is a call out, so the
   * pair stays inside the inlining budget of a caller's loop (SPEC §12.2).
   */
  #getField(id: number, field: Field): unknown {
    const trait = field[$trait]
    if (trait[$sparse]) return this.#getSparseField(id, field)
    const entities = this[$entities]
    const columns = this[$archetypes].list[entities.archetypes[id]].columnsOf.get(trait[$id])
    if (__DEV__) this.#assertReadable(trait, columns)
    const row = entities.rows[id]
    const column = columns![field[$index]]
    return decode(field, (column.pages[row >>> column.shift] as unknown[])[row & column.mask])
  }

  #setField(entity: Entity, id: number, field: Field, value: unknown): void {
    const trait = field[$trait]
    if (trait[$sparse]) return this.#setSparseField(entity, id, field, value)
    const entities = this[$entities]
    const columns = this[$archetypes].list[entities.archetypes[id]].columnsOf.get(trait[$id])
    if (__DEV__) this.#assertReadable(trait, columns)
    const row = entities.rows[id]
    const column = columns![field[$index]]
    ;(column.pages[row >>> column.shift] as unknown[])[row & column.mask] = value
    column.stamp(row, this.#ticks.tick)
    this.#wrote(entity, id, trait)
  }

  #getSparseField(id: number, field: Field): unknown {
    const trait = field[$trait]
    const row = this.#sparseRow(trait, id)
    const columns = this.#sparseColumns(trait, row)
    if (__DEV__) this.#assertReadable(trait, columns)
    return decode(field, columns![field[$index]].get(row))
  }

  #setSparseField(entity: Entity, id: number, field: Field, value: unknown): void {
    const trait = field[$trait]
    const row = this.#sparseRow(trait, id)
    const columns = this.#sparseColumns(trait, row)
    if (__DEV__) this.#assertReadable(trait, columns)
    const column = columns![field[$index]]
    column.set(row, value)
    column.stamp(row, this.#ticks.tick)
    this.#wrote(entity, id, trait)
  }

  /** The whole-trait copy, or the AoS reference (SPEC §4.4). */
  #getTrait(id: number, trait: Trait, into: object | undefined): unknown {
    const row = this.#rowOf(trait, id)
    const columns = this.#columnsAt(trait, id, row)
    if (__DEV__) this.#assertReadable(trait, columns)
    if (trait[$kind] === 'aos') return columns![0].get(row)
    return readStruct(trait[$plan], columns!, row, (into ?? {}) as Record<string, unknown>)
  }

  #setTrait(entity: Entity, id: number, trait: Trait, value: unknown): void {
    const row = this.#rowOf(trait, id)
    const columns = this.#columnsAt(trait, id, row)
    if (__DEV__) this.#assertReadable(trait, columns)
    const tick = this.#ticks.tick
    if (trait[$kind] === 'aos') {
      columns![0].set(row, value)
      columns![0].stamp(row, tick)
    } else writeStruct(trait[$plan], columns!, row, value as Record<string, unknown>, tick)
    this.#wrote(entity, id, trait)
  }

  #store(trait: Trait): SparseStore {
    let store = this.#stores.get(trait[$id])
    if (store === undefined) {
      this[$traits].register(trait)
      store = new SparseStore(trait, this[$options].pageSize)
      this.#stores.set(trait[$id], store)
      this.#storeList.push(store)
      const fields = trait[$fields]
      for (let i = 0; i < fields.length; i++)
        if (fields[i].kind === 'eid') this[$archetypes].refs.push(store.columns[i])
    }
    return store
  }

  /**
   * Walks the add edges once per table trait; sparse traits leave the graph
   * alone. A pair first raises its relation's bit, so `R('*')` stays a plain
   * archetype match and every pair archetype descends from one prefix (SPEC §7.4).
   */
  #destination(from: Archetype, items: readonly TraitLike[], start: number): Archetype {
    const graph = this[$archetypes]
    const traits = this[$traits]
    let to = from
    for (let i = start; i < items.length; i++) {
      const trait = traitOf(items[i])
      if (__DEV__) this.#assertAddable(trait, targetOf(items[i]))
      if (trait[$sparse]) continue
      const relation = (trait as Pair)[$relation]
      if (relation !== undefined) {
        const bit = traits.register(relation)
        if (!maskHas(to.mask, bit)) to = graph.edgeAdd(to, bit)
      }
      const local = traits.register(trait)
      if (!maskHas(to.mask, local)) to = graph.edgeAdd(to, local)
    }
    return to
  }

  #add(entity: Entity, id: number, items: readonly TraitLike[], start: number): void {
    const from = this.#archetypeOf(id)
    const to = this.#destination(from, items, start)
    const row = to === from ? this[$entities].rows[id] : this.#move(id, entity, from, to)
    const tick = this.#ticks.tick
    const traits = this[$traits]

    // Freshly attached traits, collected so events fire only after every value
    // is in place — a handler may itself mutate, which would stale `to`/`row`.
    const announce = this.#onAdd.size !== 0 || this.#ticks.added.size !== 0
    let fresh: TraitLike[] | null = null

    for (let i = start; i < items.length; i++) {
      const item = items[i]
      const trait = traitOf(item)
      const value = valueOf(item)
      if (trait[$sparse]) {
        if (this.#store(trait).add(id, value, tick) && announce) (fresh ??= []).push(item)
      } else if (!maskHas(from.mask, traits.localId(trait))) {
        const columns = to.columnsOf.get(trait[$id])
        initTrait(columns, row, trait, value, tick)
        if (isExclusive(trait))
          this.#link(trait, entity, id, columns!, row, targetOf(item) as Entity, tick)
        if (announce) (fresh ??= []).push(item)
      } else if (isExclusive(trait)) {
        const columns = to.columnsOf.get(trait[$id])!
        const moved = this.#retarget(
          trait,
          entity,
          id,
          columns,
          row,
          targetOf(item) as Entity,
          value,
          tick,
        )
        if (moved && announce) (fresh ??= []).push(item)
      } else if (value !== undefined) {
        // A re-add without a value leaves the data alone; with one it re-seeds
        // the row from the defaults before writing (SPEC §4.4).
        initTrait(to.columnsOf.get(trait[$id]), row, trait, value, tick)
      }
    }

    if (fresh !== null) {
      for (let i = 0; i < fresh.length; i++)
        this.#attached(entity, id, traitOf(fresh[i]), targetOf(fresh[i]) as Entity)
    }
    if (to !== from && this.#boundaries.length !== 0) this.#crossed(entity, from, to)
  }

  /** Writes the target column and registers the source with the index (SPEC §7.4). */
  #link(
    relation: Relation,
    entity: Entity,
    id: number,
    columns: Column[],
    row: number,
    target: Entity,
    tick: number,
  ): void {
    const column = columns[columns.length - 1]
    column.set(row, target)
    column.stamp(row, tick)
    const state = this[$relations].stateOf(relation)
    state.link(id, entity, target)
    if (state.depths !== null) state.reroot(entity, state.depthOf(target) + 1, tick)
  }

  /**
   * The entity already carries the relation: a column write plus two index
   * edits, and no archetype transition. Returns whether the target changed;
   * the old pair's `onRemove` fires first, the new one's `onAdd` is the
   * caller's to announce (SPEC §7.4).
   */
  #retarget(
    relation: Relation,
    entity: Entity,
    id: number,
    columns: Column[],
    row: number,
    target: Entity,
    value: unknown,
    tick: number,
  ): boolean {
    const column = columns[columns.length - 1]
    const previous = column.get(row) as Entity
    const moved = previous !== target
    if (moved) {
      if (this.#onRemove.size !== 0) this.#emit(this.#onRemove, entity, relation, previous)
      this.#unlink(relation, entity, id, previous, tick)
    }
    if (value !== undefined) initTrait(columns, row, relation, value, tick)
    if (moved) this.#link(relation, entity, id, columns, row, target, tick)
    else if (value !== undefined) {
      column.set(row, target)
      column.stamp(row, tick)
    }
    return moved
  }

  #unlink(relation: Relation, entity: Entity, id: number, target: Entity, tick: number): void {
    const state = this[$relations].stateOf(relation)
    state.unlink(id, target)
    if (state.depths !== null) state.reroot(entity, 0, tick)
  }

  #remove(entity: Entity, id: number, items: readonly TraitLike[], start: number): void {
    // `onRemove` runs first, while the data is still intact (SPEC §8.1). The
    // transition is computed afterwards because handlers may themselves mutate.
    if (this.#onRemove.size !== 0) {
      for (let i = start; i < items.length; i++) this.#leaving(entity, id, items[i])
    }

    const graph = this[$archetypes]
    const traits = this[$traits]
    const ticks = this.#ticks
    const from = this.#archetypeOf(id)
    const row = this[$entities].rows[id]
    let to = from
    for (let i = start; i < items.length; i++) {
      const item = items[i]
      const trait = traitOf(item)
      if (trait[$sparse]) {
        const store = this.#stores.get(trait[$id])
        if (store !== undefined && store.remove(id)) ticks.logRemoved(entity, trait[$id])
        continue
      }
      const local = traits.localId(trait)
      if (local < 0 || !maskHas(to.mask, local)) continue

      if (isExclusive(trait)) {
        const columns = from.columnsOf.get(trait[$id])!
        const current = columns[columns.length - 1].get(row) as Entity
        const target = targetOf(item)
        if (typeof target === 'number' && target !== NULL_ENTITY && target !== current) continue
        this.#unlink(trait, entity, id, current, ticks.tick)
      } else if (isRelation(trait)) {
        // Bare or wildcard: every pair goes, then the relation bit they held up.
        const pairs: Pair[] = []
        this.#pairsIn(to.mask, trait, pairs)
        for (let p = 0; p < pairs.length; p++) {
          to = graph.edgeRemove(to, traits.localId(pairs[p]))
          ticks.logRemoved(entity, pairs[p][$id])
        }
      }
      to = graph.edgeRemove(to, local)
      ticks.logRemoved(entity, trait[$id])

      const relation = (trait as Pair)[$relation]
      if (relation !== undefined && this.#pairsIn(to.mask, relation, null) === 0) {
        to = graph.edgeRemove(to, traits.localId(relation))
        ticks.logRemoved(entity, relation[$id])
      }
    }
    if (to !== from) {
      this.#move(id, entity, from, to)
      if (this.#boundaries.length !== 0) this.#crossed(entity, from, to)
    }
  }

  /** `onRemove` for one item of a `remove` call, if the entity actually holds it. */
  #leaving(entity: Entity, id: number, item: TraitLike): void {
    const trait = traitOf(item)
    if (isExclusive(trait)) {
      const current = this.#targetOf(id, trait)
      const target = targetOf(item)
      if (current === NULL_ENTITY) return
      if (typeof target === 'number' && target !== NULL_ENTITY && target !== current) return
      this.#emit(this.#onRemove, entity, trait, current)
    } else if (isRelation(trait)) {
      const pairs: Pair[] = []
      this.#pairsIn(this.#archetypeOf(id).mask, trait, pairs)
      for (let p = 0; p < pairs.length; p++)
        this.#emit(this.#onRemove, entity, pairs[p], NULL_ENTITY)
    } else if (this.#hasTrait(id, trait)) this.#emit(this.#onRemove, entity, trait, NULL_ENTITY)
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

    // The entity's own links leave the index while its target column is still there.
    const states = this[$relations].list
    for (let i = 0; i < states.length; i++) {
      const state = states[i]
      if (!maskHas(archetype.mask, state.local)) continue
      const columns = archetype.columnsOf.get(state.relation[$id])!
      state.unlink(id, columns[columns.length - 1].get(row) as Entity)
      state.forget(id)
    }

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

  /** Applies `onTargetDespawn` to everything that pointed at the dead entity (SPEC §7.5). */
  #resolveTargets(entity: Entity): void {
    const tick = this.#ticks.tick
    const states = this[$relations].list
    for (let s = 0; s < states.length; s++) {
      const state = states[s]
      const list = state.lists.get(entity)
      if (list === undefined) continue
      const policy = state.relation[$options].onTargetDespawn
      if (policy === 'orphan') {
        // The dead target counts for nothing, so its orphans sit right under the roots.
        if (state.depths !== null)
          for (let i = 0; i < list.length; i++) state.reroot(list.items[i] as Entity, 1, tick)
        continue
      }
      if (policy === 'despawn') {
        for (let i = 0; i < list.length; i++) this.#pending.push(list.items[i])
      } else {
        // Each removal unlinks the source, so the list drains from its tail.
        while (list.length !== 0) {
          const source = list.items[list.length - 1] as Entity
          this.#remove(source, entityId(source), state.only, 0)
        }
      }
      state.lists.delete(entity)
    }

    const pairs = pairsTo(entity)
    if (pairs === null) return
    const archetypes = this[$archetypes].list
    for (let p = 0; p < pairs.length; p++) {
      const pair = pairs[p]
      const policy = pair[$relation][$options].onTargetDespawn
      if (policy === 'orphan') continue
      const local = this[$traits].localId(pair)
      if (local >= 0) {
        const only = [pair]
        for (let a = archetypes.length - 1; a >= 0; a--) {
          const archetype = archetypes[a]
          if (!maskHas(archetype.mask, local)) continue
          if (policy === 'despawn') {
            for (let row = archetype.rows - 1; row >= 0; row--)
              this.#pending.push(archetype.entityAt(row))
          } else {
            while (archetype.rows !== 0) {
              const source = archetype.entityAt(archetype.rows - 1)
              this.#remove(source, entityId(source), only, 0)
            }
          }
        }
      }
      releasePair(pair)
    }
  }

  /** Every `eid` reference to the dead entity becomes `NULL_ENTITY`, tick-stamped (SPEC §8.5). */
  #patchRefs(entity: Entity): void {
    const refs = this[$archetypes].refs
    const tick = this.#ticks.tick
    for (let r = 0; r < refs.length; r++) {
      const column = refs[r]
      const pages = column.pages
      const ticks = column.ticks
      for (let p = 0; p < pages.length; p++) {
        const page = pages[p] as Float64Array
        for (let i = 0; i < page.length; i++) {
          if (page[i] !== entity) continue
          page[i] = NULL_ENTITY
          if (ticks !== null) {
            ticks[p][i] = tick
            column.lastWriteTick = tick
          }
        }
      }
    }
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

  /** Dev: a relation is added with one live target of this world (SPEC §7.2). */
  #assertAddable(trait: Trait, target: Entity | '*'): void {
    if (isRelation(trait)) {
      assert(target !== WILDCARD, "'*' matches any target and cannot be added")
      assert(
        trait[$options].exclusive,
        'a non-exclusive relation is added with a target: world.add(e, Likes(target))',
      )
      assert(
        target !== NULL_ENTITY,
        'an exclusive relation is added with a target: world.add(e, ChildOf(target))',
      )
      this.#assertAlive(target as Entity, entityId(target as Entity))
    } else {
      const pair = trait as Pair
      if (pair[$relation] !== undefined) this.#assertAlive(pair[$target], entityId(pair[$target]))
    }
  }

  /** Dev: the entity holds `trait`, and it is something `get` / `set` can address (SPEC §7.3). */
  #assertReadable(trait: Trait, columns: Column[] | undefined): void {
    assert(trait[$kind] !== 'tag', 'a tag carries no value to get or set')
    assert(
      !isRelation(trait) || trait[$options].exclusive,
      'a non-exclusive relation is read and written through a target: world.get(e, Likes(target))',
    )
    assert(columns !== undefined, 'this entity does not have that trait')
  }
}
