/**
 * apecs/react — hooks over a world (SPEC-CLIENTS §C.5).
 *
 * Every hook is a `useSyncExternalStore` over a `Cell` (§C.3.1). The cell has
 * already gated on value, so its committed snapshot has stable identity between
 * real changes and satisfies React's `Object.is` contract without allocating
 * per render (§C.3.2).
 *
 * The world is never an argument: it comes from the required `WorldProvider`
 * (§C.4.1). Omitting the entity reads the world trait, mirroring core's own
 * `world.get` overloads (§C.4.6, SPEC §5.4).
 */
import { createContext, createElement, useContext, type ReactElement, type ReactNode } from 'react';

import type { Entity } from '../core/entity';
import type { Field, Schema } from '../core/schema';
import type { Term } from '../core/terms';
import type { Value } from '../core/types';
import type { TraitLike } from '../core/value';
import type { World } from '../core/world';
import type { Flush } from '../reactive/scheduler';
import { todo } from '../reactive/todo';

const WorldContext = createContext<World | null>(null);

/** Required. Every hook reads the world from here (§C.4.1). */
export function WorldProvider(props: {
  world: World;
  /** Defaults to 'frame'. TODO(§C.3.3): wire to the scheduler. */
  flush?: Flush;
  children: ReactNode;
}): ReactElement {
  return createElement(WorldContext.Provider, { value: props.world }, props.children);
}

/**
 * The provider's world. Throws when there is none — unconditionally, since
 * assertion bodies are stripped from the published build and a missing provider
 * must fail legibly there too (§C.5.1).
 */
export function useWorld(): World {
  const world = useContext(WorldContext);
  if (world === null) {
    throw new Error('apecs: no WorldProvider — every hook needs one above it');
  }
  return world;
}

/** One field of one entity — a primitive snapshot gated by `Object.is`. */
export function useField<V>(entity: Entity, field: Field<V>): V | undefined;
export function useField<V>(field: Field<V>): V | undefined;
export function useField<V>(a: Entity | Field<V>, b?: Field<V>): V | undefined {
  return todo(a, b);
}

/** A whole trait, as the gated copy from §C.3.2, or `undefined`. */
export function useTrait<S extends Schema>(
  entity: Entity,
  trait: TraitLike<S>,
): Value<S> | undefined;
export function useTrait<S extends Schema>(trait: TraitLike<S>): Value<S> | undefined;
export function useTrait<S extends Schema>(
  a: Entity | TraitLike<S>,
  b?: TraitLike<S>,
): Value<S> | undefined {
  return todo(a, b);
}

/** Whether the trait is held. */
export function useHas(entity: Entity, trait: TraitLike): boolean;
export function useHas(trait: TraitLike): boolean;
export function useHas(a: Entity | TraitLike, b?: TraitLike): boolean {
  return todo(a, b);
}

/** `useHas` for traits that carry no data; dev builds assert the tag kind. */
export function useTag(entity: Entity, tag: TraitLike): boolean;
export function useTag(tag: TraitLike): boolean;
export function useTag(a: Entity | TraitLike, b?: TraitLike): boolean {
  return todo(a, b);
}

/** The match set, recomputed on enter/exit. Order is not stable (§C.4.4). */
export function useQuery(...terms: Term[]): readonly Entity[] {
  return todo(terms);
}

/** `query.first` — commits an entity, so churn behind it costs no render. */
export function useQueryFirst(...terms: Term[]): Entity | undefined {
  return todo(terms);
}

/** `sortBy` behind a cell: the one hook whose order means something (§C.3.6). */
export function useSortedQuery(
  terms: Term[],
  field: Field,
  direction?: 'asc' | 'desc',
): readonly Entity[] {
  return todo(terms, field, direction);
}

/** The extremum by the key — commits one entity, so reshuffles behind it are free. */
export function useSortedQueryFirst(
  terms: Term[],
  field: Field,
  direction?: 'asc' | 'desc',
): Entity | undefined {
  return todo(terms, field, direction);
}

/** The target of an exclusive relation; `NULL_ENTITY` maps to `undefined`. */
export function useTarget(entity: Entity, relation: TraitLike): Entity | undefined {
  return todo(entity, relation);
}

/** `useTarget` under the name the hierarchy case reads better in. */
export function useParent(entity: Entity, relation: TraitLike): Entity | undefined {
  return todo(entity, relation);
}

/** Its complement: `world.query(relation(entity))`. */
export function useChildren(entity: Entity, relation: TraitLike): readonly Entity[] {
  return todo(entity, relation);
}
