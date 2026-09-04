import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react';

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

const WorldContext = createContext<World | null>(null);

/**
 * Required. Every hook reads the world from here (§C.4.1).
 *
 * The flush mode is applied in an effect, not during render: switching to
 * `'sync'` drains pending cells, and their listeners must not fire mid-render.
 */
export function WorldProvider(props: {
  world: World;
  /** Per world, defaults to `'frame'` (§C.3.3). */
  flush?: Flush;
  children: ReactNode;
}): ReactElement {
  const { world, flush = 'frame' } = props;
  useEffect(() => {
    setFlush(world, flush);
  }, [world, flush]);
  return createElement(WorldContext.Provider, { value: world }, props.children);
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

function useCell<V>(cell: Cell<V>): V {
  return useSyncExternalStore(cell.subscribe, cell.value, cell.value);
}

/** One field of one entity, read through a memoised accessor. */
export function useField<V>(entity: Entity, field: Field<V>): V | undefined;
export function useField<V>(field: Field<V>): V | undefined;
export function useField<V>(a: Entity | Field<V>, b?: Field<V>): V | undefined {
  const world = useWorld();
  return useCell(
    typeof a === 'number' ? fieldCell(world, a, b!) : fieldCell(world, world.entity, a),
  );
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
  const world = useWorld();
  return useCell(
    typeof a === 'number' ? traitCell(world, a, b!) : traitCell(world, world.entity, a),
  );
}

function has(a: Entity | TraitLike, b: TraitLike | undefined): boolean {
  const world = useWorld();
  return useCell(typeof a === 'number' ? hasCell(world, a, b!) : hasCell(world, world.entity, a));
}

/** Whether the trait is held. */
export function useHas(entity: Entity, trait: TraitLike): boolean;
export function useHas(trait: TraitLike): boolean;
export function useHas(a: Entity | TraitLike, b?: TraitLike): boolean {
  return has(a, b);
}

/** `useHas` for traits that carry no data; dev builds assert the tag kind. */
export function useTag(entity: Entity, tag: TraitLike): boolean;
export function useTag(tag: TraitLike): boolean;
export function useTag(a: Entity | TraitLike, b?: TraitLike): boolean {
  if (__DEV__) {
    assert(
      traitOf(typeof a === 'number' ? b! : a)[$kind] === 'tag',
      'useTag reads a trait that carries data — use useHas or useField',
    );
  }
  return has(a, b);
}

/** The match set, recomputed on enter/exit. Order is not stable (§C.4.4). */
export function useQuery(...terms: Term[]): readonly Entity[] {
  return useCell(queryCell(useWorld(), terms));
}

/** `query.first` — commits an entity, so churn behind it costs no render. */
export function useQueryFirst(...terms: Term[]): Entity | undefined {
  return useCell(queryFirstCell(useWorld(), terms));
}

/** `sortBy` behind a cell: the one hook whose order means something (§C.3.6). */
export function useSortedQuery(
  terms: Term[],
  field: Field,
  direction?: 'asc' | 'desc',
): readonly Entity[] {
  return useCell(sortedQueryCell(useWorld(), terms, field, direction));
}

/** The extremum by the key — commits one entity, so reshuffles behind it are free. */
export function useSortedQueryFirst(
  terms: Term[],
  field: Field,
  direction?: 'asc' | 'desc',
): Entity | undefined {
  return useCell(sortedQueryFirstCell(useWorld(), terms, field, direction));
}

/** The target of an exclusive relation; `NULL_ENTITY` maps to `undefined`. */
export function useTarget(entity: Entity, relation: Relation): Entity | undefined {
  return useCell(targetCell(useWorld(), entity, relation));
}

/** `useTarget` under the name the hierarchy case reads better in. */
export function useParent(entity: Entity, relation: Relation): Entity | undefined {
  return useCell(targetCell(useWorld(), entity, relation));
}

/** Its complement: `world.query(relation(entity))`. */
export function useChildren(entity: Entity, relation: Relation): readonly Entity[] {
  return useCell(childrenCell(useWorld(), entity, relation));
}

/** The world's memoised accessor for the field (SPEC §4.5). No subscription. */
export function useAccessor<V>(field: Field<V>): Accessor<V> {
  return useWorld().accessor(field);
}

/**
 * Spawns on mount and despawns on unmount; `undefined` until the mount effect
 * has run. The items are read once, at spawn. Under StrictMode the effect runs
 * twice on mount, which spawns, despawns and spawns again — one entity id per
 * mounted component (§C.5.3, §C.11.4).
 */
export function useEntity(...items: TraitLike[]): Entity | undefined {
  const world = useWorld();
  const [entity, setEntity] = useState<Entity | undefined>(undefined);
  useEffect(() => {
    const spawned = world.spawn(...items);
    setEntity(spawned);
    return () => {
      if (alive(world, spawned)) {
        world.despawn(spawned);
      }
    };
  }, [world]);
  return entity;
}

// Lifetime-bound mirror of the core observer registry (§C.7): synchronous,
// ungated, uncoalesced. The observer forwards to the latest `fn`, so an inline
// closure costs no re-subscription and never fires stale.

function useLatest<T>(value: T): { current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

export function useOn(event: TraitEvent, trait: TraitLike, fn: ObserverFn): void;
export function useOn(event: QueryEvent, terms: Term[], fn: ObserverFn): void;
/** Query events key on the cached `QueryResult` (SPEC §6.2), so a fresh terms array per render is free. */
export function useOn(event: WorldEvent, subject: TraitLike | Term[], fn: ObserverFn): void {
  const world = useWorld();
  const key = Array.isArray(subject) ? world.query(...subject) : subject;
  const latest = useLatest(fn);
  useEffect(
    () =>
      world.on(event as TraitEvent, key as TraitLike, (entity, target) =>
        latest.current(entity, target),
      ),
    [world, event, key],
  );
}
