import type { Archetype } from './archetype'
import type { Column, ColumnPage } from './column'
import { assert } from './debug'
import type { Entity } from './entity'
import type { Field, Plan } from './schema'
import { $id, $index, $kind, $plan, $trait } from './symbols'
import type { Trait } from './trait'

/**
 * Per-field typed-array views over one page, rebuilt in place when the chunk
 * moves on. The shape mirrors the schema, so `chunk.get(Position).x` is the
 * page itself and nothing is copied (SPEC §6.6).
 */
class StoreView {
  readonly root: Record<string, unknown> = {}

  /** Parallel arrays: `owners[i][keys[i]] = columns[slots[i]].pages[page]`. */
  private readonly owners: Record<string, unknown>[] = []
  private readonly keys: string[] = []
  private readonly slots: number[] = []

  public constructor(plan: Plan) {
    this.walk(plan, this.root)
  }

  public bind(columns: Column[], page: number): Record<string, unknown> {
    const { owners, keys, slots } = this
    for (let i = 0; i < owners.length; i++) owners[i][keys[i]] = columns[slots[i]].pages[page]
    return this.root
  }

  private walk(plan: Plan, into: Record<string, unknown>): void {
    for (const key in plan) {
      const node = plan[key]
      if ($index in node) {
        this.owners.push(into)
        this.keys.push(key)
        this.slots.push((node as Field)[$index])
      } else {
        const nested: Record<string, unknown> = {}
        into[key] = nested
        this.walk(node as Plan, nested)
      }
    }
  }
}

const EMPTY = new Float64Array(0)

/**
 * One page of one archetype. Reused across steps: the views it hands out are
 * valid for the current step only (SPEC §6.6).
 */
export class Chunk {
  public length = 0
  /** The whole page — `length` is what bounds the loop, not `entities.length`. */
  public entities: Float64Array = EMPTY

  private archetype!: Archetype
  private page = 0
  private readonly views = new Map<number, StoreView>()

  public entity(i: number): Entity {
    return this.entities[i] as Entity
  }

  public get(trait: Trait): any {
    const columns = this.archetype.columnsOf.get(trait[$id])
    if (__DEV__) assert(columns !== undefined, 'this chunk does not hold that trait')
    if (trait[$kind] === 'aos') return columns![0].pages[this.page]

    let view = this.views.get(trait[$id])
    if (view === undefined) {
      view = new StoreView(trait[$plan])
      this.views.set(trait[$id], view)
    }
    return view.bind(columns!, this.page)
  }

  public column(field: Field): ColumnPage {
    const columns = this.archetype.columnsOf.get(field[$trait][$id])
    if (__DEV__) assert(columns !== undefined, 'this chunk does not hold that field')
    return columns![field[$index]].pages[this.page]
  }

  /** @internal */
  public move(archetype: Archetype, page: number, length: number): void {
    this.archetype = archetype
    this.page = page
    this.length = length
    this.entities = archetype.entities[page]
  }
}

/**
 * The chunk walk: one reusable iterator, no generator, no allocation per step
 * (SPEC §12.2). Archetypes and pages run back to front, matching `each`.
 */
export class Chunks implements Iterable<Chunk> {
  readonly #archetypes: readonly Archetype[]
  readonly #chunk = new Chunk()
  readonly #result: IteratorResult<Chunk> = { done: true, value: undefined as unknown as Chunk }

  #archetype = -1
  #page = -1

  public constructor(archetypes: readonly Archetype[]) {
    this.#archetypes = archetypes
  }

  public [Symbol.iterator](): IterableIterator<Chunk> {
    this.#archetype = this.#archetypes.length
    this.#page = -1
    return this
  }

  public next(): IteratorResult<Chunk> {
    const archetypes = this.#archetypes
    const result = this.#result

    for (;;) {
      if (this.#page < 0) {
        let index = this.#archetype - 1
        while (index >= 0 && archetypes[index].rows === 0) index--
        this.#archetype = index
        if (index < 0) {
          result.done = true
          result.value = undefined as unknown as Chunk
          return result
        }
        this.#page = (archetypes[index].rows - 1) >>> archetypes[index].pageShift
      }

      const archetype = archetypes[this.#archetype]
      const page = this.#page--
      const rows = archetype.rows - (page << archetype.pageShift)
      if (rows <= 0) continue

      this.#chunk.move(archetype, page, rows < archetype.pageSize ? rows : archetype.pageSize)
      result.done = false
      result.value = this.#chunk
      return result
    }
  }
}
