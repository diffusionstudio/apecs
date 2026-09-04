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
import type { Accessor } from '../core/accessor';
import { assert } from '../core/debug';
import { NULL_ENTITY, entityId, type Entity } from '../core/entity';
import { indexedTarget, type QueryResult } from '../core/query';
import { isExclusive, isRelation, type Pair, type Relation } from '../core/relation';
import type { Field, Plan, Schema } from '../core/schema';
import type { SortedQueryResult } from '../core/sorted';
import {
  $destroyed,
  $index,
  $kind,
  $plan,
  $relation,
  $target,
  $trait,
  $view,
} from '../core/symbols';
import { With, type Term } from '../core/terms';
import type { Trait, TraitInstance } from '../core/trait';
import type { Value } from '../core/types';
import { targetOf, traitOf, type TraitLike } from '../core/value';
import type { World } from '../core/world';
import { schedulerOf, type Dirtyable, type Scheduler } from './scheduler';

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

/** Nothing committed yet; `refresh` never produces it, so any read replaces it. */
const UNSET = Symbol('apecs.unset');
type Unset = typeof UNSET;

const FIELD = 0;
const TRAIT = 1;
const HAS = 2;
const TARGET = 3;
const QUERY = 4;
const FIRST = 5;

const EMPTY: readonly Entity[] = Object.freeze([]);
const NOOP = (): void => {};

/** A dead entity never comes back (SPEC §4.2), so its cells are shared constants. */
class ConstantCell<V> implements Cell<V> {
  public constructor(private readonly held: V) {}

  public value(): V {
    return this.held;
  }

  public subscribe(): () => void {
    return NOOP;
  }
}

const UNDEFINED_CELL = new ConstantCell(undefined);
const FALSE_CELL = new ConstantCell(false);
const EMPTY_CELL = new ConstantCell(EMPTY);

abstract class CellBase<V> implements Cell<V>, Dirtyable {
  public dirty = false;
  protected committed: V | Unset = UNSET;
  private readonly listeners: (() => void)[] = [];

  public value(): V {
    if (this.committed === UNSET) {
      this.refresh();
    }
    return this.committed as V;
  }

  public subscribe(listener: () => void): () => void {
    const listeners = this.listeners;
    if (listeners.length === 0) {
      // Attached first, so a write since an unsubscribed `value()` cannot slip by.
      this.attach();
      this.refresh();
    }
    listeners.push(listener);
    let live = true;
    return () => {
      if (!live) {
        return;
      }
      live = false;
      listeners.splice(listeners.indexOf(listener), 1);
      if (listeners.length === 0) {
        this.detach();
      }
    };
  }

  public flush(): void {
    if (this.listeners.length !== 0 && this.refresh()) {
      this.notify();
    }
  }

  /** A listener may unsubscribe while being notified; the copy keeps the walk honest. */
  private notify(): void {
    const listeners = this.listeners;
    if (listeners.length === 1) {
      listeners[0]();
      return;
    }
    const snapshot = listeners.slice();
    for (let i = 0; i < snapshot.length; i++) {
      snapshot[i]();
    }
  }

  /** Recomputes; commits and reports true only when the value moved. */
  protected abstract refresh(): boolean;
  /** Joins and leaves the world's dispatch tables (§C.3.4). */
  protected abstract attach(): void;
  protected abstract detach(): void;
}

/** A destroyed world holds nothing, and asking it in dev would throw (SPEC §5.5). */
function alive(world: World, entity: Entity): boolean {
  return !world[$destroyed] && world.isAlive(entity);
}

function markAll(scheduler: Scheduler, cells: readonly Dirtyable[] | undefined): void {
  if (cells !== undefined) {
    for (let i = 0; i < cells.length; i++) {
      scheduler.mark(cells[i]);
    }
  }
}

// ------------------------------------------------------------ per-entity cells

abstract class EntityCell<V> extends CellBase<V> {
  public constructor(
    protected readonly world: World,
    public readonly entity: Entity,
    private readonly watch: TraitWatch,
    public readonly kind: number,
    public readonly subject: object,
    public readonly target: Entity,
  ) {
    super();
  }

  protected attach(): void {
    this.watch.activate(this);
  }

  protected detach(): void {
    this.watch.deactivate(this);
  }
}

class FieldCell extends EntityCell<unknown> {
  private readonly trait: Trait;
  private readonly accessor: Accessor<unknown>;

  public constructor(world: World, entity: Entity, watch: TraitWatch, field: Field) {
    super(world, entity, watch, FIELD, field, NULL_ENTITY);
    this.trait = field[$trait];
    this.accessor = world.accessor(field);
  }

  protected refresh(): boolean {
    const world = this.world;
    const entity = this.entity;
    const next =
      alive(world, entity) && world.has(entity, this.trait) ? this.accessor.get(entity) : undefined;
    if (Object.is(next, this.committed)) {
      return false;
    }
    this.committed = next;
    return true;
  }
}

function sameStruct(plan: Plan, a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  for (const key in plan) {
    const node = plan[key];
    if ($index in node) {
      if (!Object.is(a[key], b[key])) {
        return false;
      }
    } else if (
      !sameStruct(
        node as Plan,
        a[key] as Record<string, unknown>,
        b[key] as Record<string, unknown>,
      )
    ) {
      return false;
    }
  }
  return true;
}

/** Dev only: the committed copy is shared by every reader (§C.4.6). */
function freezeStruct(plan: Plan, value: Record<string, unknown>): Record<string, unknown> {
  for (const key in plan) {
    const node = plan[key];
    if (!($index in node)) {
      freezeStruct(node as Plan, value[key] as Record<string, unknown>);
    }
  }
  return Object.freeze(value);
}

/**
 * Reads into a reusable scratch object and compares field-wise, so the steady
 * state allocates nothing and the committed identity survives an unchanged
 * frame. A commit takes the scratch and replaces it (§C.3.2). An AoS value is
 * the user's reference and is gated on identity alone.
 */
class TraitCell extends EntityCell<unknown> {
  private readonly item: TraitLike;
  private readonly aos: boolean;
  private readonly plan: Plan;
  private scratch: Record<string, unknown> = {};

  public constructor(
    world: World,
    entity: Entity,
    watch: TraitWatch,
    item: TraitLike,
    target: Entity,
  ) {
    super(world, entity, watch, TRAIT, watch.trait, target);
    this.item = item;
    this.aos = watch.trait[$kind] === 'aos';
    this.plan = watch.trait[$plan];
  }

  protected refresh(): boolean {
    const world = this.world;
    const entity = this.entity;
    const committed = this.committed;
    if (!(alive(world, entity) && world.has(entity, this.item))) {
      if (committed === undefined) {
        return false;
      }
      this.committed = undefined;
      return true;
    }
    if (this.aos) {
      const next = world.get(entity, this.item);
      if (Object.is(next, committed)) {
        return false;
      }
      this.committed = next;
      return true;
    }
    const next = world.get(entity, this.item, this.scratch) as Record<string, unknown>;
    if (
      committed !== UNSET &&
      committed !== undefined &&
      sameStruct(this.plan, next, committed as Record<string, unknown>)
    ) {
      return false;
    }
    this.committed = __DEV__ ? freezeStruct(this.plan, next) : next;
    this.scratch = {};
    return true;
  }
}

class HasCell extends EntityCell<boolean> {
  private readonly item: TraitLike;

  public constructor(
    world: World,
    entity: Entity,
    watch: TraitWatch,
    item: TraitLike,
    target: Entity,
  ) {
    super(world, entity, watch, HAS, watch.trait, target);
    this.item = item;
  }

  protected refresh(): boolean {
    const world = this.world;
    const entity = this.entity;
    const next = alive(world, entity) && world.has(entity, this.item);
    if (next === this.committed) {
      return false;
    }
    this.committed = next;
    return true;
  }
}

class TargetCell extends EntityCell<Entity | undefined> {
  private readonly relation: Relation;

  public constructor(world: World, entity: Entity, watch: TraitWatch, relation: Relation) {
    super(world, entity, watch, TARGET, relation, NULL_ENTITY);
    this.relation = relation;
  }

  protected refresh(): boolean {
    const world = this.world;
    const entity = this.entity;
    const target =
      alive(world, entity) && world.has(entity, this.relation)
        ? world.target(entity, this.relation)
        : NULL_ENTITY;
    const next = target === NULL_ENTITY ? undefined : target;
    if (next === this.committed) {
      return false;
    }
    this.committed = next;
    return true;
  }
}

/**
 * One core subscription per `(world, trait)`; a write costs one map lookup and
 * a miss returns at once (§C.3.4). Gains come from `onAdd` and losses from the
 * exit boundary of `world.query(trait)`, both of which fire once the world is
 * consistent — which is what lets `'sync'` recompute inside them. `onChange`
 * is taken only while a value cell exists, since subscribing is what promotes
 * the trait to tracked (§C.3.5); `onRemove` only while a target-keyed cell
 * does, since it is the one event that still names the old target.
 */
class TraitWatch {
  public readonly bySource = new Map<number, EntityCell<unknown>[]>();
  /** Query cells over an exclusive `R(target)`, keyed by target (§7.4). */
  public byTarget: Map<number, CellBase<unknown>[]> | null = null;

  private active = 0;
  private valued = 0;
  private targeted = 0;
  private offAdd = NOOP;
  private offExit = NOOP;
  private offChange = NOOP;
  private offRemove = NOOP;

  public constructor(
    private readonly registry: Registry,
    public readonly trait: Trait,
    private readonly item: TraitLike,
  ) {}

  public find(
    id: number,
    kind: number,
    subject: object,
    target: Entity,
  ): EntityCell<unknown> | undefined {
    const bucket = this.bySource.get(id);
    if (bucket !== undefined) {
      for (let i = 0; i < bucket.length; i++) {
        const cell = bucket[i];
        if (cell.kind === kind && cell.subject === subject && cell.target === target) {
          return cell;
        }
      }
    }
    return undefined;
  }

  public put(id: number, cell: EntityCell<unknown>): void {
    const bucket = this.bySource.get(id);
    if (bucket === undefined) {
      this.bySource.set(id, [cell]);
    } else {
      bucket.push(cell);
    }
  }

  public activate(cell: EntityCell<unknown>): void {
    if (++this.active === 1) {
      this.listen();
    }
    if (cell.kind <= TRAIT && ++this.valued === 1) {
      this.offChange = this.registry.world.onChange(this.item, this.onSource);
    }
  }

  public deactivate(cell: EntityCell<unknown>): void {
    const id = entityId(cell.entity);
    const bucket = this.bySource.get(id)!;
    if (bucket.length === 1) {
      this.bySource.delete(id);
    } else {
      bucket.splice(bucket.indexOf(cell), 1);
    }
    if (cell.kind <= TRAIT && --this.valued === 0) {
      this.offChange();
      this.offChange = NOOP;
    }
    this.release();
  }

  public activateTarget(id: number, cell: CellBase<unknown>): void {
    const targets = (this.byTarget ??= new Map());
    const bucket = targets.get(id);
    if (bucket === undefined) {
      targets.set(id, [cell]);
    } else {
      bucket.push(cell);
    }
    if (++this.active === 1) {
      this.listen();
    }
    if (++this.targeted === 1) {
      this.offRemove = this.registry.world.onRemove(this.item, this.onRemove);
    }
  }

  public deactivateTarget(id: number, cell: CellBase<unknown>): void {
    const targets = this.byTarget!;
    const bucket = targets.get(id)!;
    if (bucket.length === 1) {
      targets.delete(id);
    } else {
      bucket.splice(bucket.indexOf(cell), 1);
    }
    if (--this.targeted === 0) {
      this.offRemove();
      this.offRemove = NOOP;
    }
    this.release();
  }

  private listen(): void {
    const world = this.registry.world;
    this.offAdd = world.onAdd(this.item, this.onAdd);
    this.offExit = world.onExit(world.query(this.item), this.onSource);
  }

  private release(): void {
    if (--this.active !== 0) {
      return;
    }
    this.offAdd();
    this.offExit();
    this.offAdd = NOOP;
    this.offExit = NOOP;
    if (this.bySource.size === 0 && (this.byTarget === null || this.byTarget.size === 0)) {
      this.registry.traits.delete(this.trait);
    }
  }

  private readonly onSource = (entity: Entity): void => {
    const scheduler = this.registry.scheduler;
    markAll(scheduler, this.bySource.get(entityId(entity)));
    scheduler.settle();
  };

  private readonly onAdd = (entity: Entity, target?: Entity): void => {
    const scheduler = this.registry.scheduler;
    markAll(scheduler, this.bySource.get(entityId(entity)));
    if (target !== undefined && this.byTarget !== null) {
      markAll(scheduler, this.byTarget.get(entityId(target)));
    }
    scheduler.settle();
  };

  /** Fires before the data goes (SPEC §8.1): mark only, and let the exit that follows settle. */
  private readonly onRemove = (_entity: Entity, target?: Entity): void => {
    if (target !== undefined) {
      markAll(this.registry.scheduler, this.byTarget!.get(entityId(target)));
    }
  };
}

// ----------------------------------------------------------------- query cells

type AnyResult = QueryResult | SortedQueryResult;

abstract class QueryCellBase<V, R extends AnyResult = AnyResult> extends CellBase<V> {
  public constructor(
    protected readonly world: World,
    protected readonly result: R,
    private readonly watch: QueryWatch,
    public readonly kind: number,
    private readonly relation: TraitWatch | null,
    private readonly targetId: number,
  ) {
    super();
  }

  protected attach(): void {
    this.watch.activate();
    if (this.relation !== null) {
      this.relation.activateTarget(this.targetId, this);
    }
  }

  protected detach(): void {
    this.watch.deactivate(this);
    if (this.relation !== null) {
      this.relation.deactivateTarget(this.targetId, this);
    }
  }
}

/** The match set. Length first, then element-wise; a new array only on a difference. */
class QueryCell extends QueryCellBase<readonly Entity[], QueryResult> {
  protected refresh(): boolean {
    const query = this.result;
    const committed = this.committed;
    const count = this.world[$destroyed] ? 0 : query.count;
    if (committed !== UNSET && count === committed.length) {
      let i = 0;
      let same = true;
      for (const entity of query) {
        if (committed[i++] !== entity) {
          same = false;
          break;
        }
      }
      if (same) {
        return false;
      }
    }
    if (count === 0) {
      if (committed === EMPTY) {
        return false;
      }
      this.committed = EMPTY;
      return true;
    }
    const next: Entity[] = new Array(count);
    let i = 0;
    for (const entity of query) {
      next[i++] = entity;
    }
    this.committed = __DEV__ ? Object.freeze(next) : next;
    return true;
  }
}

/**
 * `first`, committed as an entity so churn behind it is free. On a sorted
 * result that entity is the extremum — the leader, the nearest — and every
 * reshuffle behind the winner costs nothing (§C.3.6).
 */
class QueryFirstCell extends QueryCellBase<Entity | undefined> {
  protected refresh(): boolean {
    const next = this.world[$destroyed] ? undefined : this.result.first;
    if (next === this.committed) {
      return false;
    }
    this.committed = next;
    return true;
  }
}

/**
 * The ordered match set (§C.3.6). Reads the view's own buffer — `entities()`
 * slices a copy per call — and lets core's memoisation decide whether a sort
 * is owed; the gate is element-wise, so a key that moved without crossing a
 * neighbour commits nothing.
 */
class SortedQueryCell extends QueryCellBase<readonly Entity[], SortedQueryResult> {
  protected refresh(): boolean {
    const committed = this.committed;
    if (this.world[$destroyed]) {
      if (committed === EMPTY) {
        return false;
      }
      this.committed = EMPTY;
      return true;
    }
    const view = this.result[$view];
    const entities = view.ensure();
    const count = view.length;
    if (committed !== UNSET && count === committed.length) {
      let i = 0;
      while (i < count && committed[i] === entities[i]) {
        i++;
      }
      if (i === count) {
        return false;
      }
    }
    if (count === 0) {
      if (committed === EMPTY) {
        return false;
      }
      this.committed = EMPTY;
      return true;
    }
    const next: Entity[] = new Array(count);
    for (let i = 0; i < count; i++) {
      next[i] = entities[i] as Entity;
    }
    this.committed = __DEV__ ? Object.freeze(next) : next;
    return true;
  }
}

/**
 * One enter/exit boundary per result, shared by its match and first cells. A
 * sorted result adds `onChange` on its key trait (§C.3.6): a key that moves an
 * entity past a neighbour crosses no boundary. That subscription promotes no
 * trait that `sortBy` had not already promoted (SPEC §6.7).
 */
class QueryWatch {
  public readonly cells: QueryCellBase<unknown>[] = [];

  private active = 0;
  private offEnter = NOOP;
  private offExit = NOOP;
  private offChange = NOOP;

  /**
   * `boundary` is the query whose enter/exit delimit the match set — for a
   * sorted result over a query that does not require its key trait, the
   * narrowed base (SPEC §6.7) rather than the query itself.
   */
  public constructor(
    private readonly registry: Registry,
    public readonly result: AnyResult,
    private readonly boundary: QueryResult,
    private readonly key: Trait | null,
  ) {}

  public find(kind: number): QueryCellBase<unknown> | undefined {
    const cells = this.cells;
    for (let i = 0; i < cells.length; i++) {
      if (cells[i].kind === kind) {
        return cells[i];
      }
    }
    return undefined;
  }

  public activate(): void {
    if (++this.active === 1) {
      const world = this.registry.world;
      this.offEnter = world.onEnter(this.boundary, this.onCross);
      this.offExit = world.onExit(this.boundary, this.onCross);
      if (this.key !== null) {
        this.offChange = world.onChange(this.key, this.onCross);
      }
    }
  }

  public deactivate(cell: QueryCellBase<unknown>): void {
    this.cells.splice(this.cells.indexOf(cell), 1);
    if (--this.active === 0) {
      this.offEnter();
      this.offExit();
      this.offChange();
      this.offEnter = NOOP;
      this.offExit = NOOP;
      this.offChange = NOOP;
      if (this.cells.length === 0) {
        this.registry.queries.delete(this.result);
      }
    }
  }

  private readonly onCross = (): void => {
    const scheduler = this.registry.scheduler;
    markAll(scheduler, this.cells);
    scheduler.settle();
  };
}

// -------------------------------------------------------------------- registry

/** What core's observers take: the trait itself, or `R(target)` for an interned pair. */
function canonical(trait: Trait): TraitLike {
  if (typeof trait === 'function') {
    return trait;
  }
  const pair = trait as unknown as Pair;
  return pair[$relation](pair[$target]);
}

class Registry {
  public readonly scheduler: Scheduler;
  public readonly traits = new Map<Trait, TraitWatch>();
  public readonly queries = new Map<AnyResult, QueryWatch>();

  public constructor(public readonly world: World) {
    this.scheduler = schedulerOf(world);
  }

  public watchOf(trait: Trait): TraitWatch {
    let watch = this.traits.get(trait);
    if (watch === undefined) {
      this.traits.set(trait, (watch = new TraitWatch(this, trait, canonical(trait))));
    }
    return watch;
  }

  public queryWatchOf(query: QueryResult): QueryWatch {
    let watch = this.queries.get(query);
    if (watch === undefined) {
      this.queries.set(query, (watch = new QueryWatch(this, query, query, null)));
    }
    return watch;
  }

  /** A view over a narrowed base shares that base's plan, and its boundary is the base (SPEC §6.7). */
  public sortedWatchOf(
    query: QueryResult,
    terms: readonly Term[],
    sorted: SortedQueryResult,
    field: Field,
  ): QueryWatch {
    let watch = this.queries.get(sorted);
    if (watch === undefined) {
      const trait = field[$trait];
      const boundary =
        sorted[$plan] === query[$plan] ? query : this.world.query(...terms, With(trait));
      this.queries.set(sorted, (watch = new QueryWatch(this, sorted, boundary, trait)));
    }
    return watch;
  }
}

const registries = new WeakMap<World, Registry>();

function registryOf(world: World): Registry {
  let registry = registries.get(world);
  if (registry === undefined) {
    registries.set(world, (registry = new Registry(world)));
  }
  return registry;
}

/** The entity an item names, or `NULL_ENTITY`; a wildcard names none. */
function targetEntity(item: TraitLike): Entity {
  const target = targetOf(item);
  return typeof target === 'number' ? target : NULL_ENTITY;
}

// ------------------------------------------------------------------- factories

/** One field of one entity, read through the world's memoised accessor. `Object.is` gated. */
export function fieldCell<V>(world: World, entity: Entity, field: Field<V>): Cell<V | undefined> {
  if (!alive(world, entity)) {
    return UNDEFINED_CELL as Cell<V | undefined>;
  }
  const watch = registryOf(world).watchOf(field[$trait]);
  const id = entityId(entity);
  let cell = watch.find(id, FIELD, field, NULL_ENTITY);
  if (cell === undefined) {
    watch.put(id, (cell = new FieldCell(world, entity, watch, field)));
  }
  return cell as Cell<V | undefined>;
}

/**
 * A whole trait as an object, or `undefined` while the entity lacks it. Pass
 * `world.entity` for a world trait; the entity-less hook overloads resolve it
 * themselves (§C.4.6).
 */
export function traitCell<S extends Schema>(
  world: World,
  entity: Entity,
  item: TraitLike<S>,
): Cell<Value<S> | undefined> {
  const trait = traitOf(item);
  if (__DEV__) {
    assert(trait[$kind] !== 'tag', 'a tag carries no value to read — use a has cell');
    assert(
      !isRelation(trait) || isExclusive(trait),
      'a non-exclusive relation is read through a target: traitCell(e, Likes(target))',
    );
  }
  if (!alive(world, entity)) {
    return UNDEFINED_CELL as Cell<Value<S> | undefined>;
  }
  const watch = registryOf(world).watchOf(trait);
  const id = entityId(entity);
  const target = targetEntity(item);
  let cell = watch.find(id, TRAIT, trait, target);
  if (cell === undefined) {
    watch.put(id, (cell = new TraitCell(world, entity, watch, item, target)));
  }
  return cell as Cell<Value<S> | undefined>;
}

/** Whether the entity holds the item — target included, as `world.has` checks it (SPEC §7.2). */
export function hasCell(world: World, entity: Entity, item: TraitLike): Cell<boolean> {
  if (!alive(world, entity)) {
    return FALSE_CELL;
  }
  const trait = traitOf(item);
  const watch = registryOf(world).watchOf(trait);
  const id = entityId(entity);
  const target = targetEntity(item);
  let cell = watch.find(id, HAS, trait, target);
  if (cell === undefined) {
    watch.put(id, (cell = new HasCell(world, entity, watch, item, target)));
  }
  return cell as Cell<boolean>;
}

/** The target of an exclusive relation; `NULL_ENTITY` maps to `undefined`. */
export function targetCell(
  world: World,
  entity: Entity,
  relation: Relation,
): Cell<Entity | undefined> {
  if (__DEV__) {
    assert(
      isExclusive(relation),
      'a target cell reads an exclusive relation — a query cell over R(target) lists the rest',
    );
  }
  if (!alive(world, entity)) {
    return UNDEFINED_CELL as Cell<Entity | undefined>;
  }
  const watch = registryOf(world).watchOf(relation);
  const id = entityId(entity);
  let cell = watch.find(id, TARGET, relation, NULL_ENTITY);
  if (cell === undefined) {
    watch.put(id, (cell = new TargetCell(world, entity, watch, relation)));
  }
  return cell as Cell<Entity | undefined>;
}

/**
 * Interned on the `QueryResult`, which core already hashes from the terms
 * (SPEC §6.2). An exclusive `R(target)` term is served by the target index and
 * a retarget crosses no archetype (SPEC §7.4), so such a cell also keys on the
 * target in the relation's watch.
 */
function internQuery(
  world: World,
  terms: readonly Term[],
  kind: number,
  field: Field | null,
  direction: 'asc' | 'desc',
): QueryCellBase<unknown> {
  const query = world.query(...terms);
  const registry = registryOf(world);
  let watch: QueryWatch;
  let sorted: SortedQueryResult | null = null;
  if (field === null) {
    watch = registry.queryWatchOf(query);
  } else {
    sorted = query.sortBy(field, direction);
    watch = registry.sortedWatchOf(query, terms, sorted, field);
  }
  let cell = watch.find(kind);
  if (cell === undefined) {
    let relation: TraitWatch | null = null;
    let target = NULL_ENTITY;
    for (let i = 0; i < terms.length && target === NULL_ENTITY; i++) {
      target = indexedTarget(terms[i]);
      if (target !== NULL_ENTITY) {
        relation = registry.watchOf((terms[i] as TraitInstance)[$trait]);
      }
    }
    const id = entityId(target);
    cell =
      kind === FIRST
        ? new QueryFirstCell(world, sorted ?? query, watch, kind, relation, id)
        : sorted === null
          ? new QueryCell(world, query, watch, kind, relation, id)
          : new SortedQueryCell(world, sorted, watch, kind, relation, id);
    watch.cells.push(cell);
  }
  return cell;
}

/** The match set, recomputed on enter/exit only. Order is not stable (§C.4.4). */
export function queryCell(world: World, terms: readonly Term[]): Cell<readonly Entity[]> {
  return internQuery(world, terms, QUERY, null, 'asc') as Cell<readonly Entity[]>;
}

/** `query.first`, committed as an entity so membership churn behind it is free. */
export function queryFirstCell(world: World, terms: readonly Term[]): Cell<Entity | undefined> {
  return internQuery(world, terms, FIRST, null, 'asc') as Cell<Entity | undefined>;
}

/**
 * `world.query(...terms).sortBy(field, direction)`, interned on the sorted
 * result core memoises (SPEC §6.7). The one cell whose order means something
 * (§C.3.6); a key written through `chunk.markChanged` fires no observer and
 * does not wake it (§C.11.1).
 */
export function sortedQueryCell(
  world: World,
  terms: readonly Term[],
  field: Field,
  direction: 'asc' | 'desc' = 'asc',
): Cell<readonly Entity[]> {
  return internQuery(world, terms, QUERY, field, direction) as Cell<readonly Entity[]>;
}

/** The first entity in sorted order — the extremum by the key. */
export function sortedQueryFirstCell(
  world: World,
  terms: readonly Term[],
  field: Field,
  direction: 'asc' | 'desc' = 'asc',
): Cell<Entity | undefined> {
  return internQuery(world, terms, FIRST, field, direction) as Cell<Entity | undefined>;
}

/** The entities whose exclusive `relation` targets `entity`: `world.query(relation(entity))`. */
export function childrenCell(
  world: World,
  entity: Entity,
  relation: Relation,
): Cell<readonly Entity[]> {
  if (__DEV__) {
    assert(isExclusive(relation), 'a children cell reads an exclusive relation (SPEC §7.3)');
  }
  if (!alive(world, entity)) {
    return EMPTY_CELL;
  }
  return queryCell(world, [relation(entity)]);
}
