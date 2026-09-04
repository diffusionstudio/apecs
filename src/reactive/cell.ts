/**
 * The framework-agnostic half of the bindings (SPEC-CLIENTS §C.3).
 *
 * A cell is a value derived from a world, recomputed on a flush and committed
 * only when it differs from what was committed last. The gate is the point: a
 * simulation writing the same value sixty times between paints must produce no
 * notification at all (§C.3.2).
 *
 * Cells are interned per `(world, entity, subject)` and reference counted, so
 * every factory here returns a shared instance: asking twice recomputes once and
 * notifies twice (§C.3.4). The committed value is shared with every other reader
 * and must be treated as read-only (§C.4.6).
 */
import type { Entity } from '../core/entity';
import type { Relation } from '../core/relation';
import type { Field } from '../core/schema';
import type { Term } from '../core/terms';
import type { TraitLike } from '../core/value';
import type { World } from '../core/world';
import { todo } from './todo';

/**
 * A gated view of one slice of a world.
 *
 * `value` is the last committed value; its identity is stable until the value
 * actually changes, which is what lets React use it as a `getSnapshot` and both
 * bindings use it as a memo dependency. Commit happens before notify, so a
 * listener always reads the value it was woken for.
 */
export interface Cell<V> {
  value(): V;
  /** Returns its own unsubscribe. The last one releases the world observers. */
  subscribe(listener: () => void): () => void;
}

/** One field of one entity, read through an accessor. `Object.is` gated. */
export function fieldCell<V>(world: World, entity: Entity, field: Field<V>): Cell<V | undefined> {
  return todo(world, entity, field);
}

/**
 * A whole trait as an object. Reads into a reusable scratch via `world.get`'s
 * `out` parameter and compares field-wise, so the steady state allocates
 * nothing and the committed identity survives an unchanged frame (§C.3.2).
 *
 * Pass `world.entity` for a world trait; the entity-less hook overloads resolve
 * it themselves (§C.4.6).
 */
export function traitCell<V>(world: World, entity: Entity, trait: TraitLike): Cell<V | undefined> {
  return todo(world, entity, trait);
}

/** Whether the entity holds the trait. */
export function hasCell(world: World, entity: Entity, trait: TraitLike): Cell<boolean> {
  return todo(world, entity, trait);
}

/** The match set, recomputed on enter/exit only. Length then element-wise. */
export function queryCell(world: World, terms: readonly Term[]): Cell<readonly Entity[]> {
  return todo(world, terms);
}

/** `query.first`, committed as an entity so membership churn behind it is free. */
export function queryFirstCell(world: World, terms: readonly Term[]): Cell<Entity | undefined> {
  return todo(world, terms);
}

/** The target of an exclusive relation; `NULL_ENTITY` maps to `undefined`. */
export function targetCell(
  world: World,
  entity: Entity,
  relation: Relation,
): Cell<Entity | undefined> {
  return todo(world, entity, relation);
}
