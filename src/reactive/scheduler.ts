/**
 * Coalescing between a world's observers and a framework's re-render.
 *
 * `onChange` fires per write. Handing that straight to a framework means
 * thousands of re-render requests inside one frame of a system loop, so a
 * dirtied source is queued here and its listeners run once per flush.
 *
 * The default flush point is `world.step()` — it is already the frame boundary
 * and already advances the change clock (SPEC §8.3). Worlds that never step
 * fall back to a microtask so a one-off write from an event handler still
 * lands in the same turn.
 */
import type { World } from '../core/world';
import { todo } from './todo';

export type Flush = 'step' | 'microtask' | 'sync';

/** Queues `notify` for a dirtied source; it runs once at the next flush. */
export function schedule(world: World, notify: () => void): void {
  todo(world, notify);
}

/** Overrides when queued notifications run for this world. Defaults to `'step'`. */
export function setFlush(world: World, mode: Flush): void {
  todo(world, mode);
}
