/**
 * apecs/solid — signal accessors over a world (SPEC-CLIENTS §C.6).
 *
 * Solid is push-based, so there is no snapshot contract to satisfy: each factory
 * seeds a signal from a `Cell` and writes it from the cell's subscription, with
 * `equals: false` because the cell has already gated on value (§C.3.2).
 *
 * The getters are typed `() => V` rather than Solid's `Accessor<V>` —
 * structurally identical, and it avoids colliding with apecs's own `Accessor`.
 *
 * The world is never an argument: it comes from the required `WorldProvider`
 * (§C.4.1). Omitting the entity reads the world trait (§C.4.6, SPEC §5.4).
 */
import { createComponent, createContext, useContext, type JSX } from 'solid-js';

import type { Entity } from '../core/entity';
import type { Field, Schema } from '../core/schema';
import type { Term } from '../core/terms';
import type { Value } from '../core/types';
import type { TraitLike } from '../core/value';
import type { World } from '../core/world';
import type { Flush } from '../reactive/scheduler';
import { todo } from '../reactive/todo';

const WorldContext = createContext<World>();

/** Required. Every factory reads the world from here (§C.4.1). */
export function WorldProvider(props: {
  world: World;
  /** Defaults to 'frame'. TODO(§C.3.3): wire to the scheduler. */
  flush?: Flush;
  children: JSX.Element;
}): JSX.Element {
  // What the Solid JSX transform emits, written out: the children getter keeps
  // them lazy, so the provider does not force them at creation.
  return createComponent(WorldContext.Provider, {
    value: props.world,
    get children() {
      return props.children;
    },
  });
}

/** The provider's world. Throws when there is none (§C.5.1). */
export function useWorld(): World {
  const world = useContext(WorldContext);
  if (world === undefined) {
    throw new Error('apecs: no WorldProvider — every hook needs one above it');
  }
  return world;
}

/** One field of one entity, read through a memoised accessor. */
export function createField<V>(entity: Entity, field: Field<V>): () => V | undefined;
export function createField<V>(field: Field<V>): () => V | undefined;
export function createField<V>(a: Entity | Field<V>, b?: Field<V>): () => V | undefined {
  return todo(a, b);
}

/** A whole trait, as the gated copy from §C.3.2, or `undefined`. */
export function createTrait<S extends Schema>(
  entity: Entity,
  trait: TraitLike<S>,
): () => Value<S> | undefined;
export function createTrait<S extends Schema>(trait: TraitLike<S>): () => Value<S> | undefined;
export function createTrait<S extends Schema>(
  a: Entity | TraitLike<S>,
  b?: TraitLike<S>,
): () => Value<S> | undefined {
  return todo(a, b);
}

/** Whether the trait is held. */
export function createHas(entity: Entity, trait: TraitLike): () => boolean;
export function createHas(trait: TraitLike): () => boolean;
export function createHas(a: Entity | TraitLike, b?: TraitLike): () => boolean {
  return todo(a, b);
}

/** `createHas` for traits that carry no data; dev builds assert the tag kind. */
export function createTag(entity: Entity, tag: TraitLike): () => boolean;
export function createTag(tag: TraitLike): () => boolean;
export function createTag(a: Entity | TraitLike, b?: TraitLike): () => boolean {
  return todo(a, b);
}

/** The match set, recomputed on enter/exit. Order is not stable (§C.4.4). */
export function createQuery(...terms: Term[]): () => readonly Entity[] {
  return todo(terms);
}

/** `query.first` — commits an entity, so churn behind it costs no update. */
export function createQueryFirst(...terms: Term[]): () => Entity | undefined {
  return todo(terms);
}

/** `sortBy` behind a cell: the one factory whose order means something (§C.3.6). */
export function createSortedQuery(
  terms: Term[],
  field: Field,
  direction?: 'asc' | 'desc',
): () => readonly Entity[] {
  return todo(terms, field, direction);
}

/** The extremum by the key — commits one entity, so reshuffles behind it are free. */
export function createSortedQueryFirst(
  terms: Term[],
  field: Field,
  direction?: 'asc' | 'desc',
): () => Entity | undefined {
  return todo(terms, field, direction);
}

/** The target of an exclusive relation; `NULL_ENTITY` maps to `undefined`. */
export function createTarget(entity: Entity, relation: TraitLike): () => Entity | undefined {
  return todo(entity, relation);
}

/** `createTarget` under the name the hierarchy case reads better in. */
export function createParent(entity: Entity, relation: TraitLike): () => Entity | undefined {
  return todo(entity, relation);
}

/** Its complement: `world.query(relation(entity))`. */
export function createChildren(entity: Entity, relation: TraitLike): () => readonly Entity[] {
  return todo(entity, relation);
}
