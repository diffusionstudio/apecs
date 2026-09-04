/**
 * Coalescing between a world's writes and a framework's re-render
 * (SPEC-CLIENTS §C.3.3).
 *
 * The canvas may run far above the display's refresh rate, or on a fixed
 * timestep unrelated to it; the DOM must not follow. Dirty cells are queued and
 * recomputed once per animation frame, so a 240Hz simulation still yields at
 * most one DOM update per paint.
 *
 * `'microtask'` tracks the simulation rate instead and exists for contexts with
 * no rAF — Node, SSR, a worker — where `'frame'` degrades to it. `'sync'` is for
 * tests; it defeats the coalescing by construction.
 */
import type { World } from '../core/world';
import { todo } from './todo';

export type Flush = 'frame' | 'microtask' | 'sync';

/** Marks a cell dirty and schedules its world's flush. One per world per frame. */
export function schedule(world: World, notify: () => void): void {
  todo(world, notify);
}

/** Per world, not global. Defaults to `'frame'`. */
export function setFlush(world: World, mode: Flush): void {
  todo(world, mode);
}
