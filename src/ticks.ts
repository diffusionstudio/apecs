import type { Entity } from './entity'

const EMPTY_TABLE = new Uint32Array(0)
const MIN_TABLE = 1024

/**
 * The per-world change clock, plus the structural event stores that must
 * outlive the archetype a row was in: gains are entity-indexed so a slow query
 * never misses one, and losses live in a log that `step` expires — a removal is
 * observable for exactly one tick (SPEC §8.3).
 */
export class Ticks {
  /** Monotonic; `world.step()` advances it. */
  public tick = 0

  /** Global trait id → entity-id-indexed tick of the last gain. Allocated by the first `Added()` query. */
  readonly added = new Map<number, Uint32Array>()

  // Removal records, appended in tick order so expiry is a prefix cut.
  #removedEntities: number[] = []
  #removedTraits: number[] = []
  #removedTicks: number[] = []
  /** Log length that triggers the next opportunistic expiry, doubled on a miss. */
  #expireAt = 64

  public step(): void {
    ++this.tick
    this.#expire()
  }

  public trackAdded(traitId: number): void {
    if (!this.added.has(traitId)) this.added.set(traitId, EMPTY_TABLE)
  }

  /** Records a gain. No-op for traits no `Added()` query has asked about. */
  public stampAdded(traitId: number, entityId: number): void {
    let table = this.added.get(traitId)
    if (table === undefined) return
    if (entityId >= table.length) {
      const grown = new Uint32Array(Math.max(MIN_TABLE, table.length * 2, entityId + 1))
      grown.set(table)
      this.added.set(traitId, (table = grown))
    }
    table[entityId] = this.tick
  }

  public logRemoved(entity: Entity, traitId: number): void {
    // Amortised expiry bounds the log even in a world that never steps.
    if (this.#removedTicks.length >= this.#expireAt) this.#expire()
    this.#removedEntities.push(entity)
    this.#removedTraits.push(traitId)
    this.#removedTicks.push(this.tick)
  }

  /** Handles that lost `traitId` after `after`, into a caller-owned set. */
  public collectRemoved(traitId: number, after: number, into: Set<number>): void {
    const traits = this.#removedTraits
    const ticks = this.#removedTicks
    for (let i = 0; i < traits.length; i++) {
      if (traits[i] === traitId && ticks[i] > after) into.add(this.#removedEntities[i])
    }
  }

  /** Drops records older than one tick — a removal is observable for exactly one tick. */
  #expire(): void {
    const ticks = this.#removedTicks
    const horizon = this.tick - 1
    let cut = 0
    while (cut < ticks.length && ticks[cut] < horizon) cut++
    if (cut > 0) {
      this.#removedEntities.splice(0, cut)
      this.#removedTraits.splice(0, cut)
      ticks.splice(0, cut)
    }
    this.#expireAt = Math.max(64, ticks.length * 2)
  }
}
