/**
 * apecs/solid — signal accessors over a world (SPEC-CLIENTS §C.6).
 *
 * Solid is push-based, so there is no snapshot contract to satisfy: each factory
 * seeds a signal from a `Cell` and writes it from the cell's subscription, with
 * `equals: false` because the cell has already gated on value (§C.3.2). Updates
 * coalesce to one per animation frame unless the provider says otherwise
 * (§C.3.3).
 *
 * Reading a value through `createField` / `createTrait` promotes that trait to
 * tracked for the whole world, which every system writing it then pays for
 * (§C.3.5). The `on` subscriptions are the way to observe many traits at once
 * without that fan-out.
 *
 * The getters are typed `() => V` rather than Solid's `Accessor<V>` —
 * structurally identical, and it avoids colliding with apecs's own `Accessor`.
 *
 * The world is never an argument: it comes from the required `WorldProvider`
 * (§C.4.1). Omitting the entity reads the world trait (§C.4.6, SPEC §5.4).
 */
import {
  createComponent,
  createContext,
  createRenderEffect,
  createSignal,
  onCleanup,
  useContext,
  type JSX,
} from 'solid-js';

import type { Accessor } from '../core/accessor';
import { assert } from '../core/debug';
import type { Entity } from '../core/entity';
import type { Relation } from '../core/relation';
import type { Field, Schema } from '../core/schema';
import { $kind } from '../core/symbols';
import type { Term } from '../core/terms';
import type { Value } from '../core/types';
import { traitOf, type TraitLike } from '../core/value';
import type { ObserverFn, QueryEvent, TraitEvent, World, WorldEvent } from '../core/world';
import {
  alive,
  childrenCell,
  fieldCell,
  hasCell,
  queryCell,
  queryFirstCell,
  sortedQueryCell,
  sortedQueryFirstCell,
  targetCell,
  traitCell,
  type Cell,
} from '../reactive/cell';
import { setFlush, type Flush } from '../reactive/scheduler';

const WorldContext = createContext<World>();

/** Required. Every factory reads the world from here (§C.4.1). */
export function WorldProvider(props: {
  world: World;
  /** Per world, defaults to `'frame'` (§C.3.3). */
  flush?: Flush;
  children: JSX.Element;
}): JSX.Element {
  createRenderEffect(() => {
    setFlush(props.world, props.flush ?? 'frame');
  });
  // What the Solid JSX transform emits, written out: the getters keep the
  // world and the children lazy, so the provider forces neither at creation.
  return createComponent(WorldContext.Provider, {
    get value() {
      return props.world;
    },
    get children() {
      return props.children;
    },
  });
}

/**
 * The provider's world. Throws when there is none — unconditionally, since
 * assertion bodies are stripped from the published build and a missing provider
 * must fail legibly there too (§C.5.1).
 */
export function useWorld(): World {
  const world = useContext(WorldContext);
  if (world === undefined) {
    throw new Error('apecs: no WorldProvider — every hook needs one above it');
  }
  return world;
}

/**
 * Subscribing first is deliberate: it is what computes the cell's fresh value,
 * and a listener never fires inside `subscribe`, so `set` is assigned by the
 * time one can.
 */
function signalOf<V>(cell: Cell<V>): () => V {
  const unsubscribe = cell.subscribe(() => set(() => cell.value()));
  const [get, set] = createSignal(cell.value(), { equals: false });
  onCleanup(unsubscribe);
  return get;
}

/** One field of one entity, read through a memoised accessor. */
export function createField<V>(entity: Entity, field: Field<V>): () => V | undefined;
export function createField<V>(field: Field<V>): () => V | undefined;
export function createField<V>(a: Entity | Field<V>, b?: Field<V>): () => V | undefined {
  const world = useWorld();
  return typeof a === 'number'
    ? signalOf(fieldCell(world, a, b!))
    : signalOf(fieldCell(world, world.entity, a));
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
  const world = useWorld();
  return typeof a === 'number'
    ? signalOf(traitCell(world, a, b!))
    : signalOf(traitCell(world, world.entity, a));
}

function has(a: Entity | TraitLike, b: TraitLike | undefined): () => boolean {
  const world = useWorld();
  return typeof a === 'number'
    ? signalOf(hasCell(world, a, b!))
    : signalOf(hasCell(world, world.entity, a));
}

/** Whether the trait is held. */
export function createHas(entity: Entity, trait: TraitLike): () => boolean;
export function createHas(trait: TraitLike): () => boolean;
export function createHas(a: Entity | TraitLike, b?: TraitLike): () => boolean {
  return has(a, b);
}

/** `createHas` for traits that carry no data; dev builds assert the tag kind. */
export function createTag(entity: Entity, tag: TraitLike): () => boolean;
export function createTag(tag: TraitLike): () => boolean;
export function createTag(a: Entity | TraitLike, b?: TraitLike): () => boolean {
  if (__DEV__) {
    assert(
      traitOf(typeof a === 'number' ? b! : a)[$kind] === 'tag',
      'createTag reads a trait that carries data — use createHas or createField',
    );
  }
  return has(a, b);
}

/** The match set, recomputed on enter/exit. Order is not stable (§C.4.4). */
export function createQuery(...terms: Term[]): () => readonly Entity[] {
  return signalOf(queryCell(useWorld(), terms));
}

/** `query.first` — commits an entity, so churn behind it costs no update. */
export function createQueryFirst(...terms: Term[]): () => Entity | undefined {
  return signalOf(queryFirstCell(useWorld(), terms));
}

/** `sortBy` behind a cell: the one factory whose order means something (§C.3.6). */
export function createSortedQuery(
  terms: Term[],
  field: Field,
  direction?: 'asc' | 'desc',
): () => readonly Entity[] {
  return signalOf(sortedQueryCell(useWorld(), terms, field, direction));
}

/** The extremum by the key — commits one entity, so reshuffles behind it are free. */
export function createSortedQueryFirst(
  terms: Term[],
  field: Field,
  direction?: 'asc' | 'desc',
): () => Entity | undefined {
  return signalOf(sortedQueryFirstCell(useWorld(), terms, field, direction));
}

/** The target of an exclusive relation; `NULL_ENTITY` maps to `undefined`. */
export function createTarget(entity: Entity, relation: Relation): () => Entity | undefined {
  return signalOf(targetCell(useWorld(), entity, relation));
}

/** `createTarget` under the name the hierarchy case reads better in. */
export function createParent(entity: Entity, relation: Relation): () => Entity | undefined {
  return signalOf(targetCell(useWorld(), entity, relation));
}

/** Its complement: `world.query(relation(entity))`. */
export function createChildren(entity: Entity, relation: Relation): () => readonly Entity[] {
  return signalOf(childrenCell(useWorld(), entity, relation));
}

/** The world's memoised accessor for the field (SPEC §4.5). No subscription. */
export function createAccessor<V>(field: Field<V>): Accessor<V> {
  return useWorld().accessor(field);
}

/** Spawns now and despawns with the owner, unless something else already did. */
export function createEntity(...items: TraitLike[]): Entity {
  const world = useWorld();
  const entity = world.spawn(...items);
  onCleanup(() => {
    if (alive(world, entity)) {
      world.despawn(entity);
    }
  });
  return entity;
}

// Owner-bound mirror of the core observer registry (§C.7): synchronous,
// ungated, uncoalesced, and released with the owner.

export function on(event: TraitEvent, trait: TraitLike, fn: ObserverFn): void;
export function on(event: QueryEvent, terms: Term[], fn: ObserverFn): void;
/** Query events key on the cached `QueryResult` (SPEC §6.2), so a fresh terms array is free. */
export function on(event: WorldEvent, subject: TraitLike | Term[], fn: ObserverFn): void {
  const world = useWorld();
  const key = Array.isArray(subject) ? world.query(...subject) : subject;
  onCleanup(world.on(event as TraitEvent, key as TraitLike, fn));
}
