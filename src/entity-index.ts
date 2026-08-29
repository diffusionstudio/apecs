/**
 * id → (archetype, row, generation) as three parallel typed arrays, so a
 * liveness check is one compare and a lookup is two reads (SPEC §10.3).
 */
export class EntityIndex {
  archetypes: Uint32Array
  rows: Uint32Array
  generations: Uint16Array
  capacity: number

  public constructor(capacity: number) {
    const size = nextPowerOfTwo(capacity)
    this.capacity = size
    this.archetypes = new Uint32Array(size)
    this.rows = new Uint32Array(size)
    this.generations = new Uint16Array(size)
  }

  /** Generation 0 is never live, so `NULL_ENTITY` and out-of-range ids are dead. */
  public isAlive(id: number, generation: number): boolean {
    return generation !== 0 && id < this.capacity && this.generations[id] === generation
  }

  public ensure(id: number): void {
    if (id < this.capacity) return
    const size = nextPowerOfTwo(id + 1)
    const archetypes = new Uint32Array(size)
    const rows = new Uint32Array(size)
    const generations = new Uint16Array(size)
    archetypes.set(this.archetypes)
    rows.set(this.rows)
    generations.set(this.generations)
    this.archetypes = archetypes
    this.rows = rows
    this.generations = generations
    this.capacity = size
  }
}

export function nextPowerOfTwo(n: number): number {
  return n <= 1 ? 1 : 2 ** (32 - Math.clz32(n - 1))
}
