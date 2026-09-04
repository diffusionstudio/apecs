/**
 * apecs/react — hooks over a world.
 *
 * Every hook is a `useSyncExternalStore` over a `Source` (see
 * `src/reactive/source.ts`). The snapshot rule shapes the surface: React
 * compares with `Object.is` and must not see a fresh object per call, so
 * `useField` returns the scalar straight off an `Accessor` and allocates
 * nothing, while `useTrait` caches the copy `world.get` hands back and
 * re-materialises it only when the source's version moves (SPEC §4.5, §14).
 *
 * The world is passed explicitly rather than read from context inside each
 * hook: it keeps the hooks free of a provider requirement and tree-shakeable.
 * `WorldProvider` / `useWorld` are there for apps that want one anyway.
 */
import { createContext, createElement, useContext, type ReactElement, type ReactNode } from 'react';

import type { Entity } from '../core/entity';
import { todo } from '../reactive/todo';
import type { Field, Schema } from '../core/schema';
import type { Term } from '../core/terms';
import type { Value } from '../core/types';
import type { TraitLike } from '../core/value';
import type { World } from '../core/world';

const WorldContext = createContext<World | null>(null);

/** Puts a world on the context for `useWorld`. Optional — the hooks take a world directly. */
export function WorldProvider(props: { world: World; children: ReactNode }): ReactElement {
  return createElement(WorldContext.Provider, { value: props.world }, props.children);
}

/** The nearest `WorldProvider`'s world. Throws when there is none. */
export function useWorld(): World {
  const world = useContext(WorldContext);
  if (world === null) {
    throw new Error('apecs: useWorld() called outside a WorldProvider');
  }
  return world;
}

/**
 * One field of one entity. The fast path: the read goes through a memoised
 * accessor, so the snapshot is a number or string and costs no allocation.
 */
export function useField<V>(world: World, entity: Entity, field: Field<V>): V {
  return todo(world, entity, field);
}

/**
 * A whole trait as a plain object, or `undefined` while the entity does not
 * hold it. The copy is cached between changes — `world.get` returns a fresh
 * object per call, which `Object.is` would read as a change every render
 * (SPEC §4.4).
 */
export function useTrait<S extends Schema>(
  world: World,
  entity: Entity,
  trait: TraitLike<S>,
): Value<S> | undefined {
  return todo(world, entity, trait);
}

/** Whether the entity holds the trait, re-rendering when that flips. */
export function useHas(world: World, entity: Entity, trait: TraitLike): boolean {
  return todo(world, entity, trait);
}

/**
 * The entities matching `terms`, re-rendering when one enters or leaves.
 * The array identity is stable until the match set actually changes.
 */
export function useQuery<const T extends readonly Term[]>(
  world: World,
  ...terms: T
): readonly Entity[] {
  return todo(world, terms);
}
