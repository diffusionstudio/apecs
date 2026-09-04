/**
 * apecs/solid — signal accessors over a world.
 *
 * Solid is push-based, so there is no snapshot to compare and nothing to
 * cache: each factory returns a getter that reads a version signal and then
 * the live value, and only the computations that called it re-run. That makes
 * `createField` a signal read plus an `Accessor.get` — no component re-render
 * anywhere (SPEC §4.5).
 *
 * The getters are typed as plain `() => V` rather than Solid's `Accessor<V>`,
 * which is structurally the same and avoids colliding with apecs's own
 * `Accessor`.
 */
import { createComponent, createContext, useContext, type JSX } from 'solid-js';

import type { Entity } from '../core/entity';
import { todo } from '../reactive/todo';
import type { Field, Schema } from '../core/schema';
import type { Term } from '../core/terms';
import type { Value } from '../core/types';
import type { TraitLike } from '../core/value';
import type { World } from '../core/world';

const WorldContext = createContext<World>();

/** Puts a world on the context for `useWorld`. Optional — the factories take a world directly. */
export function WorldProvider(props: { world: World; children: JSX.Element }): JSX.Element {
  // What the Solid JSX transform emits, written out: the children getter keeps
  // them lazy, so the provider does not force them at creation.
  return createComponent(WorldContext.Provider, {
    value: props.world,
    get children() {
      return props.children;
    },
  });
}

/** The nearest `WorldProvider`'s world. Throws when there is none. */
export function useWorld(): World {
  const world = useContext(WorldContext);
  if (world === undefined) {
    throw new Error('apecs: useWorld() called outside a WorldProvider');
  }
  return world;
}

/** One field of one entity, read through a memoised accessor. */
export function createField<V>(world: World, entity: Entity, field: Field<V>): () => V {
  return todo(world, entity, field);
}

/** A whole trait as a plain object, or `undefined` while the entity does not hold it. */
export function createTrait<S extends Schema>(
  world: World,
  entity: Entity,
  trait: TraitLike<S>,
): () => Value<S> | undefined {
  return todo(world, entity, trait);
}

/** Whether the entity holds the trait. */
export function createHas(world: World, entity: Entity, trait: TraitLike): () => boolean {
  return todo(world, entity, trait);
}

/** The entities matching `terms`, updating when one enters or leaves. */
export function createQuery<const T extends readonly Term[]>(
  world: World,
  ...terms: T
): () => readonly Entity[] {
  return todo(world, terms);
}
