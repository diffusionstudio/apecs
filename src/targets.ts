import { ApecsError } from './debug'
import { NULL_ENTITY, entityGeneration, entityId, type Entity } from './entity'
import type { EntityIndex } from './entity-index'
import { nextPowerOfTwo } from './entity-index'
import type { TraitRegistry } from './registry'
import type { Relation } from './relation'

const NOWHERE = -1

/** A dense, swap-removed list of handles; the unit the target index hands to queries. */
export class EntityList {
  public items = new Float64Array(4)
  public length = 0

  /** Returns the position taken. */
  public push(entity: Entity): number {
    const at = this.length++
    if (at === this.items.length) {
      const grown = new Float64Array(at * 2)
      grown.set(this.items)
      this.items = grown
    }
    this.items[at] = entity
    return at
  }

  /** Swap-removes `at`; returns the entity relocated into it, or `NULL_ENTITY`. */
  public removeAt(at: number): Entity {
    const last = --this.length
    if (at === last) return NULL_ENTITY
    const moved = this.items[last] as Entity
    this.items[at] = moved
    return moved
  }
}

/**
 * Per-world state of one exclusive relation: for every target, the entities
 * aimed at it, so `query(R(target))` is O(matches) and a retarget is two list
 * edits (SPEC §7.4). Once a `Cascade` query asks for it, also every entity's
 * depth, kept current as relations change (SPEC §7.6).
 */
export class TargetIndex {
  readonly relation: Relation
  /** The relation's mask bit in this world. */
  readonly local: number
  /** `[relation]`, kept so a target despawn can remove it from each source without allocating. */
  readonly only: readonly [Relation]
  readonly lists = new Map<Entity, EntityList>()
  /** Entity id → depth; `null` until the first `Cascade` over this relation. */
  public depths: Uint32Array | null = null
  /** The tick of the last depth change — the sorted view's dirty signal. */
  public depthTick = 0

  /** Entity id → position in its target's list, `NOWHERE` for a non-source. */
  #at = new Int32Array(0)
  #queue: number[] = []

  public constructor(relation: Relation, local: number) {
    this.relation = relation
    this.local = local
    this.only = [relation]
  }

  /** Stable per target: a query built over it sees every later change. */
  public listFor(target: Entity): EntityList {
    let list = this.lists.get(target)
    if (list === undefined) this.lists.set(target, (list = new EntityList()))
    return list
  }

  public link(id: number, entity: Entity, target: Entity): void {
    this.#ensure(id)
    this.#at[id] = this.listFor(target).push(entity)
  }

  public unlink(id: number, target: Entity): void {
    const list = this.lists.get(target)
    if (list === undefined) return
    const at = this.#at[id]
    const moved = list.removeAt(at)
    if (moved !== NULL_ENTITY) this.#at[entityId(moved)] = at
    this.#at[id] = NOWHERE
  }

  public depthOf(target: Entity): number {
    const depths = this.depths!
    const id = entityId(target)
    return id < depths.length ? depths[id] : 0
  }

  /**
   * Sets `entity`'s depth and pushes the change through its subtree with an
   * explicit stack. A subtree whose root did not move is left alone. Reaching
   * `entity` again means the edit closed a cycle: dev throws, prod stops.
   */
  public reroot(entity: Entity, depth: number, tick: number): number {
    const depths = this.depths!
    const id = entityId(entity)
    if (depths[id] === depth) return 0
    depths[id] = depth
    this.depthTick = tick

    const queue = this.#queue
    queue.length = 0
    queue.push(entity)
    let touched = 1
    while (queue.length !== 0) {
      const parent = queue.pop()!
      const children = this.lists.get(parent as Entity)
      if (children === undefined) continue
      const below = depths[entityId(parent)] + 1
      const items = children.items
      for (let i = 0; i < children.length; i++) {
        const child = items[i]
        if (child === entity) {
          if (__DEV__) throw new ApecsError('Cascade() over a relation with a cycle (SPEC §7.6)')
          return -1
        }
        depths[entityId(child)] = below
        queue.push(child)
        touched++
      }
    }
    return touched
  }

  /**
   * First `Cascade` over this relation: depths for the hierarchy as it stands.
   * Roots are the sources whose target is dead or is no source itself; a
   * source no root reaches sits in a cycle.
   */
  public enableDepths(index: EntityIndex, tick: number): void {
    this.depths = new Uint32Array(Math.max(this.#at.length, 1))
    let sources = 0
    let reached = 0
    for (const [target, list] of this.lists) {
      sources += list.length
      const id = entityId(target)
      const alive = index.isAlive(id, entityGeneration(target))
      if (alive && id < this.#at.length && this.#at[id] !== NOWHERE) continue
      for (let i = 0; i < list.length; i++) {
        const touched = this.reroot(list.items[i] as Entity, 1, tick)
        if (touched < 0) return
        reached += touched
      }
    }
    if (__DEV__ && reached !== sources)
      throw new ApecsError('Cascade() over a relation with a cycle (SPEC §7.6)')
  }

  /** The id is being released: whatever depth it had must not greet its next owner. */
  public forget(id: number): void {
    if (this.depths !== null && id < this.depths.length) this.depths[id] = 0
  }

  #ensure(id: number): void {
    if (id < this.#at.length) return
    const size = nextPowerOfTwo(id + 1)
    const at = new Int32Array(size).fill(NOWHERE)
    at.set(this.#at)
    this.#at = at
    if (this.depths !== null) {
      const depths = new Uint32Array(size)
      depths.set(this.depths)
      this.depths = depths
    }
  }
}

/** The exclusive relations a world has used, each with its index (SPEC §7.4). */
export class Relations {
  readonly list: TargetIndex[] = []
  readonly #byRelation = new Map<Relation, TargetIndex>()
  readonly #traits: TraitRegistry

  public constructor(traits: TraitRegistry) {
    this.#traits = traits
  }

  public get(relation: Relation): TargetIndex | undefined {
    return this.#byRelation.get(relation)
  }

  public stateOf(relation: Relation): TargetIndex {
    let state = this.#byRelation.get(relation)
    if (state === undefined) {
      state = new TargetIndex(relation, this.#traits.register(relation))
      this.#byRelation.set(relation, state)
      this.list.push(state)
    }
    return state
  }

  public clear(): void {
    this.#byRelation.clear()
    this.list.length = 0
  }
}
