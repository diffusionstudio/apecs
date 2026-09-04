/**
 * Coalescing between a world's writes and a framework's re-render
 * (SPEC-CLIENTS §C.3.3).
 *
 * The canvas may run far above the display's refresh rate, or on a fixed
 * timestep unrelated to it; the DOM must not follow. Dirty cells are queued and
 * recomputed once per animation frame, so a 240Hz simulation still yields at
 * most one DOM update per paint. Demand-driven: a frame is requested by the
 * write that dirties the first cell, never by a loop.
 *
 * `'microtask'` tracks the simulation rate instead and is what `'frame'`
 * degrades to without a rAF — Node, SSR, a worker. `'sync'` is for tests; it
 * defeats the coalescing by construction.
 */
import { assert } from '../core/debug';
import type { World } from '../core/world';

export type Flush = 'frame' | 'microtask' | 'sync';

/** What the queue holds: marked once per flush, recomputed by that flush. */
export interface Dirtyable {
  dirty: boolean;
  /** Recompute, and notify only if the value moved. Runs on a flush, never inside `mark`. */
  flush(): void;
}

declare const requestAnimationFrame: undefined | ((fn: () => void) => unknown);

export class Scheduler {
  public mode: Flush = 'frame';

  private readonly queue: Dirtyable[] = [];
  private pending = false;
  private flushing = false;

  public mark(cell: Dirtyable): void {
    if (cell.dirty) {
      return;
    }
    cell.dirty = true;
    this.queue.push(cell);
    if (!this.pending && this.mode !== 'sync') {
      this.pending = true;
      if (this.mode === 'frame' && typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(this.run);
      } else {
        queueMicrotask(this.run);
      }
    }
  }

  /**
   * Sync mode's flush point. Core's `onRemove` fires before the data goes, so
   * a dispatcher that only marks there leaves the recompute to the post-state
   * event that always follows it — the exit boundary or the replacing `onAdd`.
   */
  public settle(): void {
    if (this.mode === 'sync') {
      this.flush();
    }
  }

  /** Cells dirtied by a listener during the flush ride the same pass. */
  public flush(): void {
    if (this.flushing) {
      return;
    }
    const queue = this.queue;
    this.flushing = true;
    let i = 0;
    try {
      for (; i < queue.length; i++) {
        const cell = queue[i];
        cell.dirty = false;
        cell.flush();
      }
    } finally {
      for (; i < queue.length; i++) {
        queue[i].dirty = false;
      }
      queue.length = 0;
      this.flushing = false;
      this.pending = false;
    }
  }

  private readonly run = (): void => {
    this.flush();
  };
}

const schedulers = new WeakMap<World, Scheduler>();

export function schedulerOf(world: World): Scheduler {
  let scheduler = schedulers.get(world);
  if (scheduler === undefined) {
    schedulers.set(world, (scheduler = new Scheduler()));
  }
  return scheduler;
}

/** Per world, not global. Defaults to `'frame'`; switching to `'sync'` drains what is pending. */
export function setFlush(world: World, mode: Flush): void {
  if (__DEV__) {
    assert(
      mode === 'frame' || mode === 'microtask' || mode === 'sync',
      `unknown flush mode "${mode}" — expected 'frame', 'microtask' or 'sync'`,
    );
  }
  const scheduler = schedulerOf(world);
  scheduler.mode = mode;
  if (mode === 'sync') {
    scheduler.flush();
  }
}
