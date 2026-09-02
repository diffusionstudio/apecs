import { snapshotRows, type Archetype } from './archetype'
import type { Column, ColumnPage } from './column'
import { assert, warnOnce } from './debug'
import type { Entity } from './entity'
import type { Frame, Iteration } from './iteration'
import type { Field, Plan } from './schema'
import { $id, $index, $kind, $options, $plan, $trait } from './symbols'
import type { Ticks } from './ticks'
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
 *
 * Walk the page back to front when mutating the entities in it: a swap-remove
 * then only ever pulls a row already visited into the hole (SPEC §9).
 */
export class Chunk {
  public length = 0
  /** The whole page — `length` is what bounds the loop, not `entities.length`. */
  public entities: Float64Array = EMPTY

  private archetype!: Archetype
  private page = 0
  private readonly views = new Map<number, StoreView>()
  private readonly ticks: Ticks
  /** Dev: tracked stores handed out this step, awaiting a `markChanged` (SPEC §6.6). */
  private guards: Map<number, string> | null = null

  public constructor(ticks: Ticks) {
    this.ticks = ticks
  }

  public entity(i: number): Entity {
    return this.entities[i] as Entity
  }

  public get(trait: Trait): any {
    const columns = this.archetype.columnsOf.get(trait[$id])
    if (__DEV__) assert(columns !== undefined, 'this chunk does not hold that trait')
    if (__DEV__ && trait[$options].track) {
      const site = new Error().stack?.split('\n')[2] ?? 'unknown call site'
      ;(this.guards ??= new Map()).set(trait[$id], site)
    }
    if (trait[$kind] === 'aos') return columns![0].pages[this.page]

    let view = this.views.get(trait[$id])
    if (view === undefined) {
      view = new StoreView(trait[$plan])
      this.views.set(trait[$id], view)
    }
    return view.bind(columns!, this.page)
  }

  /**
   * The explicit signal that a direct page write happened — the only thing
   * `Changed()` filters and sorted views can see from this tier (SPEC §6.6).
   */
  public markChanged(trait: Trait, row?: number): void {
    const columns = this.archetype.columnsOf.get(trait[$id])
    if (__DEV__) assert(columns !== undefined, 'this chunk does not hold that trait')
    if (__DEV__) this.guards?.delete(trait[$id])
    if (columns === undefined) return
    const tick = this.ticks.tick
    for (let i = 0; i < columns.length; i++) {
      const pages = columns[i].ticks
      if (pages === null) continue
      if (row === undefined) pages[this.page].fill(tick, 0, this.length)
      else pages[this.page][row] = tick
      columns[i].lastWriteTick = tick
    }
  }

  /** @internal Dev: warns once per call site for stores that were never marked. */
  public flushGuards(): void {
    const guards = this.guards
    if (guards === null || guards.size === 0) return
    for (const site of guards.values()) {
      warnOnce(
        site,
        'a store for a tracked trait left chunk iteration without markChanged — ' +
          'Changed() filters and sorted queries cannot see direct page writes (SPEC §6.6)',
      )
    }
    guards.clear()
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
 * (SPEC §12.2). Archetypes and pages run back to front, matching `each`, and
 * the row counts are fixed at the start so nothing appended mid-walk is reached.
 */
export class Chunks implements Iterable<Chunk> {
  readonly #archetypes: readonly Archetype[]
  readonly #chunk: Chunk
  readonly #iteration: Iteration
  readonly #result: IteratorResult<Chunk> = { done: true, value: undefined as unknown as Chunk }

  #caps: Uint32Array = new Uint32Array(0)
  #frame: Frame | null = null
  #archetype = 0
  #page = -1

  public constructor(archetypes: readonly Archetype[], ticks: Ticks, iteration: Iteration) {
    this.#archetypes = archetypes
    this.#chunk = new Chunk(ticks)
    this.#iteration = iteration
  }

  public [Symbol.iterator](): IterableIterator<Chunk> {
    // A walk abandoned before it drained is closed here rather than leaking its depth.
    if (this.#frame !== null) this.#close()
    this.#frame = this.#iteration.enter()
    this.#caps = snapshotRows(this.#archetypes, this.#caps)
    this.#archetype = this.#archetypes.length
    this.#page = -1
    return this
  }

  public next(): IteratorResult<Chunk> {
    const archetypes = this.#archetypes
    const result = this.#result
    // Only the step boundary knows a handed-out store was never marked.
    if (__DEV__) this.#chunk.flushGuards()

    for (;;) {
      if (this.#page < 0) {
        let index = this.#archetype - 1
        while (index >= 0 && this.#rowsOf(index) === 0) index--
        if (index < 0) return this.return()
        this.#archetype = index
        this.#page = (this.#rowsOf(index) - 1) >>> archetypes[index].pageShift
      }

      const archetype = archetypes[this.#archetype]
      const page = this.#page--
      const start = page << archetype.pageShift
      const rows = this.#rowsOf(this.#archetype) - start
      if (rows <= 0) continue

      if (__DEV__) {
        this.#frame!.archetype = archetype
        this.#frame!.row = start
      }
      this.#chunk.move(archetype, page, rows < archetype.pageSize ? rows : archetype.pageSize)
      result.done = false
      result.value = this.#chunk
      return result
    }
  }

  /** `break` and `throw` land here; the walk closes exactly as a drained one does. */
  public return(): IteratorResult<Chunk> {
    if (this.#frame !== null) this.#close()
    const result = this.#result
    result.done = true
    result.value = undefined as unknown as Chunk
    return result
  }

  #rowsOf(index: number): number {
    return Math.min(this.#archetypes[index].rows, this.#caps[index])
  }

  #close(): void {
    this.#frame = null
    this.#archetype = 0
    this.#page = -1
    if (__DEV__) this.#chunk.flushGuards()
    this.#iteration.exit()
  }
}
