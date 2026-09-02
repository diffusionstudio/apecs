import type { Archetype } from './archetype'
import { ApecsError } from './debug'

/** Where one walk in progress stands. Only dev builds keep it current (SPEC §9). */
export class Frame {
  public archetype: Archetype | null = null
  /** The row being visited — for a chunk walk, the first row of the page. */
  public row = 0
}

/**
 * Per-world iteration state: the nesting depth that decides when deferred
 * work drains, the FIFO queue itself, and the frames of every walk in
 * progress, which dev builds check structural changes against (SPEC §9).
 */
export class Iteration {
  public depth = 0
  /** `frames[0 .. depth)` are live; the rest are kept so re-entry allocates nothing. */
  readonly frames: Frame[] = []

  readonly #queue: Array<() => void> = []
  #flushing = false

  public defer(fn: () => void): void {
    this.#queue.push(fn)
  }

  /** Drains FIFO; a closure deferred while draining runs in the same pass. */
  public flush(): void {
    if (this.#flushing) return
    const queue = this.#queue
    this.#flushing = true
    try {
      for (let i = 0; i < queue.length; i++) queue[i]()
    } finally {
      queue.length = 0
      this.#flushing = false
    }
  }

  public enter(): Frame {
    const depth = this.depth++
    const frames = this.frames
    return depth < frames.length ? frames[depth] : (frames[depth] = new Frame())
  }

  /** Closing the outermost walk is what drains the queue (SPEC §9). */
  public exit(): void {
    if (--this.depth === 0 && this.#queue.length !== 0) this.flush()
  }

  /**
   * Dev: a swap-remove pulls the tail row into `row`. Every walk runs back to
   * front, so that is harmless unless a walk over this archetype still has
   * `row` ahead of it — then it would visit the relocated entity twice.
   */
  public assertRemovable(archetype: Archetype, row: number): void {
    const frames = this.frames
    for (let i = 0; i < this.depth; i++) {
      const frame = frames[i]
      if (frame.archetype === archetype && row < frame.row) {
        throw new ApecsError(
          'structural change to an entity the iteration has not reached — ' +
            'only the current entity may be mutated in place; use world.defer() (SPEC §9)',
        )
      }
    }
  }

  public clear(): void {
    this.#queue.length = 0
  }
}
