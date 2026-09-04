/**
 * The framework-agnostic half of the bindings.
 *
 * Both `apecs/react` and `apecs/solid` need the same thing from a world: a
 * monotonic counter that moves when some slice of it changes, and a way to be
 * told about it. Neither framework's primitive fits a mutable store directly —
 * React compares snapshots with `Object.is`, Solid wants a signal — so the
 * shared piece stops at the counter and each binding adapts it (SPEC §8.4).
 */
import type { Entity } from '../core/entity';
import type { Field } from '../core/schema';
import type { TraitLike } from '../core/value';
import type { World } from '../core/world';
import { todo } from './todo';

/**
 * A change counter over one slice of a world.
 *
 * `version` moves on every write to the slice — eagerly, since a `++` is
 * cheaper than the check that would avoid it. `subscribe` is the coalesced
 * half: a listener hears at most once per flush, however many writes landed
 * (see `./scheduler`).
 */
export interface Source {
  /** Monotonic. Compare against a previously read value; the magnitude means nothing. */
  version(): number;
  /** Returns its own unsubscribe. The last unsubscribe releases the world observers. */
  subscribe(listener: () => void): () => void;
}

/** Moves when the entity's value for `field` is written. */
export function fieldSource(world: World, entity: Entity, field: Field): Source {
  return todo(world, entity, field);
}

/** Moves when the entity gains, loses, or has a write stamped on `trait`. */
export function traitSource(world: World, entity: Entity, trait: TraitLike): Source {
  return todo(world, entity, trait);
}

/** Moves when an entity enters or leaves the query's match set. */
export function querySource(world: World, key: string): Source {
  return todo(world, key);
}
