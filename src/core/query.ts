import { snapshotRows, type Archetype, type ArchetypeGraph } from './archetype';
import { Chunks } from './chunk';
import { assert, callSite } from './debug';
import { NULL_ENTITY, type Entity } from './entity';
import type { EntityIndex } from './entity-index';
import type { Frame, Iteration } from './iteration';
import { createMask, maskHas, maskIntersects, maskSuperset, maskWith, type Mask } from './mask';
import { IndexedQueryResult, type View } from './materialized';
import { OrderedQueryResult } from './ordered';
import type { TraitRegistry } from './registry';
import { shapeOf, type Relation } from './relation';
import type { Field } from './schema';
import { SortedQueryResult, type Comparator } from './sorted';
import {
  $archetypes,
  $bind,
  $id,
  $index,
  $options,
  $plan,
  $target,
  $term,
  $terms,
  $trait,
} from './symbols';
import type { Relations } from './targets';
import type { Ticks } from './ticks';
import { With, type Modifier, type Term } from './terms';
import type { EachFn } from './types';
import { Trait, type TraitInstance } from './trait';
import { Binding, RowFilter, termTrait } from './walk';

const HAS = 0;
const NOT = 1;
const OR = 2;
const ANY = 3;

/** One node of the exotic part of a predicate; the plain part rides in two masks. */
interface Node {
  readonly op: number;
  readonly bit: number;
  readonly children: readonly Node[];
}

const NO_CHILDREN: readonly Node[] = [];

function node(op: number, bit: number, children: readonly Node[] = NO_CHILDREN): Node {
  return { op, bit, children };
}

function evaluate(self: Node, mask: Mask): boolean {
  switch (self.op) {
    case HAS:
      return maskHas(mask, self.bit);
    case NOT:
      return !evaluate(self.children[0], mask);
    case OR: {
      const children = self.children;
      for (let i = 0; i < children.length; i++) {
        if (evaluate(children[i], mask)) {
          return true;
        }
      }
      return false;
    }
    default:
      return true;
  }
}

/**
 * The term list as a predicate over archetype masks, evaluated once per
 * archetype at creation. Per-frame matching therefore costs nothing (SPEC §10.4).
 */
export class QueryPlan {
  /** Bits every match must carry, and bits no match may carry. */
  readonly all: Mask;
  readonly none: Mask;
  /** `Or` and nested modifiers — what a pair of masks cannot express. */
  readonly nodes: readonly Node[];

  public constructor(all: Mask, none: Mask, nodes: readonly Node[]) {
    this.all = all;
    this.none = none;
    this.nodes = nodes;
  }

  public test(mask: Mask): boolean {
    if (!maskSuperset(mask, this.all) || maskIntersects(mask, this.none)) {
      return false;
    }
    const nodes = this.nodes;
    for (let i = 0; i < nodes.length; i++) {
      if (!evaluate(nodes[i], mask)) {
        return false;
      }
    }
    return true;
  }
}

/** An exclusive relation aimed at one entity: served by the target index, not the mask (SPEC §7.4). */
export function indexedTarget(term: Term): Entity {
  if (term instanceof Trait) {
    return NULL_ENTITY;
  }
  const instance = term as TraitInstance;
  const trait = instance[$trait];
  const target = instance[$target];
  return trait !== undefined &&
    typeof target === 'number' &&
    target !== NULL_ENTITY &&
    (trait as Relation)[$options].exclusive === true
    ? target
    : NULL_ENTITY;
}

/** Mentioning a trait in a query registers it, so every term owns a mask bit. */
function bitOf(traits: TraitRegistry, term: Term): number {
  if (__DEV__) {
    assert(
      indexedTarget(term) === NULL_ENTITY,
      'an exclusive relation with a target is only matched as a top-level term (SPEC §7.4)',
    );
  }
  const trait = termTrait(term);
  return trait === null ? -1 : traits.register(trait);
}

function compileNode(traits: TraitRegistry, term: Term): Node {
  const trait = termTrait(term);
  if (trait !== null) {
    return node(HAS, bitOf(traits, term));
  }

  const modifier = term as Modifier;
  const operands = modifier[$terms];
  switch (modifier[$term]) {
    case 'not':
      return node(NOT, -1, [compileNode(traits, operands[0])]);
    case 'or': {
      const children: Node[] = new Array(operands.length);
      for (let i = 0; i < operands.length; i++) {
        children[i] = compileNode(traits, operands[i]);
      }
      return node(OR, -1, children);
    }
    case 'with':
    case 'added':
    case 'changed':
      return node(HAS, bitOf(traits, operands[0]));
    default:
      // `Optional` and `Cascade` constrain nothing, and `Removed` reports a
      // trait the archetype no longer carries (SPEC §6.1, §8.3).
      bitOf(traits, operands[0]);
      return node(ANY, -1);
  }
}

export function compileTerms(traits: TraitRegistry, terms: readonly Term[]): QueryPlan {
  let all = createMask();
  let none = createMask();
  const nodes: Node[] = [];

  for (const term of terms) {
    const trait = termTrait(term);
    if (trait !== null) {
      all = maskWith(all, traits.register(trait));
      continue;
    }
    const modifier = term as Modifier;
    const operands = modifier[$terms];
    switch (modifier[$term]) {
      case 'with':
      case 'added':
      case 'changed':
        all = maskWith(all, bitOf(traits, operands[0]));
        break;
      case 'not': {
        const bit = bitOf(traits, operands[0]);
        if (bit >= 0) {
          none = maskWith(none, bit);
        } else {
          nodes.push(compileNode(traits, term));
        }
        break;
      }
      case 'or':
        nodes.push(compileNode(traits, term));
        break;
      default:
        bitOf(traits, operands[0]);
    }
  }
  return new QueryPlan(all, none, nodes);
}

/**
 * Structural, not by identity: a freshly built `Not(Velocity)` hashes the
 * same, and `R('*')` hashes as the bare relation it matches like (SPEC §7.3).
 */
function hash(term: Term): string {
  if (term instanceof Trait) {
    return `${term[$id]}`;
  }
  const instance = term as TraitInstance;
  if (instance[$trait] !== undefined) {
    const target = instance[$target];
    const id = instance[$trait][$id];
    return typeof target === 'number' && target !== NULL_ENTITY ? `${id}#${target}` : `${id}`;
  }
  const modifier = term as Modifier;
  const operands = modifier[$terms];
  let key = `${modifier[$term]}(`;
  for (let i = 0; i < operands.length; i++) {
    key += `${hash(operands[i])},`;
  }
  return `${key})`;
}

export function signatureOf(terms: readonly Term[]): string {
  let key = '';
  for (let i = 0; i < terms.length; i++) {
    key += `${hash(terms[i])};`;
  }
  return key;
}

/** Views memoised on (key, direction); the maps exist only once asked for (SPEC §6.7, §6.8). */
class Memo<K, V extends { dispose(): void }> {
  #asc: Map<K, V> | null = null;
  #desc: Map<K, V> | null = null;

  public get(key: K, descending: boolean): V | undefined {
    return (descending ? this.#desc : this.#asc)?.get(key);
  }

  public set(key: K, descending: boolean, view: V): void {
    let map = descending ? this.#desc : this.#asc;
    if (map === null) {
      map = new Map();
      if (descending) {
        this.#desc = map;
      } else {
        this.#asc = map;
      }
    }
    map.set(key, view);
  }

  public forget(key: K, descending: boolean): void {
    (descending ? this.#desc : this.#asc)?.delete(key);
  }

  /** Each view drops its own entry as it goes; deleting under `forEach` is defined. */
  public dispose(): void {
    this.#asc?.forEach((view) => view.dispose());
    this.#desc?.forEach((view) => view.dispose());
  }
}

/**
 * The three access tiers over one matching-archetype list. Every walk runs
 * archetypes and rows back to front over row counts fixed when it started,
 * which is what makes mutating or despawning the current entity safe (SPEC §9).
 */
export class QueryResult<T extends readonly Term[] = readonly Term[]> {
  declare readonly [$plan]: QueryPlan;
  declare readonly [$terms]: readonly Term[];
  declare readonly [$archetypes]: Archetype[];

  readonly #cache: QueryCache;
  readonly #key: string;
  readonly #binding: Binding;
  readonly #filter: RowFilter | null;
  readonly #ticks: Ticks;
  readonly #iteration: Iteration;
  #caps: Uint32Array = new Uint32Array(0);
  #chunks: Chunks | undefined;

  /** Sorted views by (field, direction) or comparator identity; ordered views by (field, direction). */
  readonly #sorted = new Memo<Field | Comparator, SortedQueryResult>();
  readonly #ordered = new Memo<Field, OrderedQueryResult>();
  /** Results layered over this archetype list; told about every archetype that joins. */
  readonly #views: View[] = [];

  public constructor(cache: QueryCache, key: string, plan: QueryPlan, terms: readonly Term[]) {
    this.#cache = cache;
    this.#key = key;
    this.#filter = RowFilter.of(terms);
    this.#binding = new Binding(terms, this.#filter !== null);
    this.#ticks = cache.ticks;
    this.#iteration = cache.iteration;
    this[$plan] = plan;
    this[$terms] = terms;
    this[$archetypes] = [];
  }

  public get count(): number {
    const archetypes = this[$archetypes];
    let total = 0;
    for (let i = 0; i < archetypes.length; i++) {
      total += archetypes[i].rows;
    }
    return total;
  }

  public get isEmpty(): boolean {
    const archetypes = this[$archetypes];
    for (let i = 0; i < archetypes.length; i++) {
      if (archetypes[i].rows !== 0) {
        return false;
      }
    }
    return true;
  }

  public get first(): Entity | undefined {
    const archetypes = this[$archetypes];
    for (let i = archetypes.length - 1; i >= 0; i--) {
      const archetype = archetypes[i];
      if (archetype.rows !== 0) {
        return archetype.entityAt(archetype.rows - 1);
      }
    }
    return undefined;
  }

  public [Symbol.iterator](): Iterator<Entity> {
    return new EntityIterator(this[$archetypes]);
  }

  /** A copy, so it survives the structural change it is being used to drive (SPEC §9). */
  public entities(): Float64Array {
    const archetypes = this[$archetypes];
    const out = new Float64Array(this.count);
    let at = 0;
    for (let a = archetypes.length - 1; a >= 0; a--) {
      const archetype = archetypes[a];
      for (let row = archetype.rows - 1; row >= 0; row--) {
        out[at++] = archetype.entityAt(row);
      }
    }
    return out;
  }

  public each(fn: EachFn<T>): void {
    const iteration = this.#iteration;
    const frame = iteration.enter();
    try {
      if (this.#filter === null) {
        this.#eachAll(fn, frame);
      } else {
        this.#eachFiltered(fn, frame, this.#filter);
      }
    } finally {
      if (__DEV__) {
        this.#binding.poison();
      }
      iteration.exit();
    }
  }

  #eachAll(fn: (...args: any[]) => void, frame: Frame): void {
    const archetypes = this[$archetypes];
    const caps = (this.#caps = snapshotRows(archetypes, this.#caps));
    const binding = this.#binding;
    const { cursors, cursorColumns, boxedColumn, boxedPage } = binding;
    const tick = this.#ticks.tick;

    for (let a = archetypes.length - 1; a >= 0; a--) {
      const archetype = archetypes[a];
      const rows = Math.min(archetype.rows, caps[a]);
      if (rows === 0 || !binding.bind(archetype)) {
        continue;
      }
      if (__DEV__) {
        frame.archetype = archetype;
      }

      const { pageShift, pageMask } = archetype;
      const cursorCount = cursors.length;
      const boxedCount = boxedColumn.length;
      const driver = binding.driver;

      for (let page = (rows - 1) >>> pageShift, i = (rows - 1) & pageMask; page >= 0; page--) {
        for (let c = 0; c < cursorCount; c++) {
          cursors[c][$bind](cursorColumns[c], page, tick);
        }
        for (let b = 0; b < boxedCount; b++) {
          boxedPage[b] = boxedColumn[b].pages[page] as unknown[];
        }

        driver(fn, binding, archetype.entities[page], i, frame, page << pageShift, null, page);
        i = pageMask;
      }
    }
  }

  /**
   * The same walk with a per-row tick predicate. A separate loop so the
   * unfiltered path carries none of it (SPEC §8.3).
   */
  #eachFiltered(fn: (...args: any[]) => void, frame: Frame, filter: RowFilter): void {
    const ticks = this.#ticks;
    if (!filter.begin(ticks)) {
      return;
    }
    const tick = ticks.tick;

    const archetypes = this[$archetypes];
    const caps = (this.#caps = snapshotRows(archetypes, this.#caps));
    const binding = this.#binding;
    const { cursors, cursorColumns, boxedColumn, boxedPage } = binding;

    for (let a = archetypes.length - 1; a >= 0; a--) {
      const archetype = archetypes[a];
      const rows = Math.min(archetype.rows, caps[a]);
      if (rows === 0 || !binding.bind(archetype)) {
        continue;
      }
      if (__DEV__) {
        frame.archetype = archetype;
      }
      filter.bind(archetype);

      const { pageShift, pageMask } = archetype;
      const cursorCount = cursors.length;
      const boxedCount = boxedColumn.length;
      const driver = binding.driver;

      for (let page = (rows - 1) >>> pageShift, i = (rows - 1) & pageMask; page >= 0; page--) {
        for (let c = 0; c < cursorCount; c++) {
          cursors[c][$bind](cursorColumns[c], page, tick);
        }
        for (let b = 0; b < boxedCount; b++) {
          boxedPage[b] = boxedColumn[b].pages[page] as unknown[];
        }

        driver(fn, binding, archetype.entities[page], i, frame, page << pageShift, filter, page);
        i = pageMask;
      }
    }
  }

  public chunks(): Chunks {
    return (this.#chunks ??= new Chunks(this[$archetypes], this.#ticks, this.#iteration));
  }

  /**
   * The memoised order (SPEC §6.7). A field keys on itself and the direction,
   * a comparator on its identity — hoist the comparator to get the cached view.
   */
  public sortBy(field: Field, direction?: 'asc' | 'desc'): SortedQueryResult<T>;
  public sortBy(compare: Comparator): SortedQueryResult<T>;
  public sortBy(by: Field | Comparator, direction: 'asc' | 'desc' = 'asc'): SortedQueryResult<T> {
    const descending = typeof by !== 'function' && direction === 'desc';
    let sorted = this.#sorted.get(by, descending);
    if (sorted === undefined) {
      sorted = this.#cache.sortBy(this, by, descending, () => this.#sorted.forget(by, descending));
      this.#sorted.set(by, descending, sorted);
    }
    return sorted;
  }

  /**
   * The rows themselves in key order, memoised like `sortBy` (SPEC §6.8).
   * Dev remembers the call site, so the warnings this can raise name it.
   */
  public orderBy(field: Field, direction: 'asc' | 'desc' = 'asc'): OrderedQueryResult<T> {
    const descending = direction === 'desc';
    let ordered = this.#ordered.get(field, descending);
    if (ordered === undefined) {
      ordered = this.#cache.orderBy(this, field, descending, __DEV__ ? callSite(1) : '', () =>
        this.#ordered.forget(field, descending),
      );
      this.#ordered.set(field, descending, ordered);
    }
    return ordered as OrderedQueryResult<T>;
  }

  public dispose(): void {
    this.#cache.release(this.#key, this);
    // Views over a dead list would never learn of new archetypes.
    this.#sorted.dispose();
    this.#ordered.dispose();
    for (const view of this.#views.slice()) {
      view.dispose();
    }
  }

  /** @internal An archetype the plan accepted; the views over this list learn of it. */
  public admit(archetype: Archetype): void {
    this[$archetypes].push(archetype);
    const views = this.#views;
    for (let i = 0; i < views.length; i++) {
      views[i].admit(archetype);
    }
  }

  /** @internal */
  public attach(view: View): void {
    this.#views.push(view);
  }

  /** @internal */
  public detach(view: View): void {
    const at = this.#views.indexOf(view);
    if (at >= 0) {
      this.#views.splice(at, 1);
    }
  }

  /** @internal Swaps in tracked cursors after a promotion (SPEC §8.3). */
  public retrack(trait: Trait): void {
    this.#binding.retrack(trait);
    const views = this.#views;
    for (let i = 0; i < views.length; i++) {
      views[i].retrack(trait);
    }
  }
}

/** Tier 1. A plain object rather than a generator, so iteration allocates once. */
class EntityIterator implements Iterator<Entity> {
  readonly #archetypes: readonly Archetype[];
  readonly #caps: Uint32Array;
  readonly #result: IteratorResult<Entity> = { done: false, value: 0 as Entity };

  #index: number;
  #row = -1;

  public constructor(archetypes: readonly Archetype[]) {
    this.#archetypes = archetypes;
    this.#caps = snapshotRows(archetypes, new Uint32Array(archetypes.length));
    this.#index = archetypes.length;
  }

  public next(): IteratorResult<Entity> {
    const archetypes = this.#archetypes;
    const result = this.#result;

    while (this.#row < 0) {
      const index = --this.#index;
      if (index < 0) {
        result.done = true;
        result.value = undefined as unknown as Entity;
        return result;
      }
      this.#row = Math.min(archetypes[index].rows, this.#caps[index]) - 1;
    }

    result.value = archetypes[this.#index].entityAt(this.#row--);
    return result;
  }
}

/**
 * Per-world query cache. A signature is hashed once; the same `QueryResult`
 * comes back for the same term list, and it keeps its matching-archetype list
 * up to date through the graph's creation hook (SPEC §6.2, §10.4).
 */
export class QueryCache {
  readonly live: QueryResult[] = [];
  readonly graph: ArchetypeGraph;
  readonly entities: EntityIndex;
  readonly ticks: Ticks;
  readonly iteration: Iteration;

  readonly #traits: TraitRegistry;
  readonly #relations: Relations;
  /** Plain results and the materialised ones — `Cascade`, target queries — by signature. */
  readonly #byKey = new Map<string, QueryResult | SortedQueryResult | IndexedQueryResult>();

  public constructor(
    traits: TraitRegistry,
    relations: Relations,
    graph: ArchetypeGraph,
    entities: EntityIndex,
    ticks: Ticks,
    iteration: Iteration,
  ) {
    this.#traits = traits;
    this.#relations = relations;
    this.graph = graph;
    this.entities = entities;
    this.ticks = ticks;
    this.iteration = iteration;
    graph.onCreate = (archetype) => this.#offer(archetype);
  }

  /**
   * The public surface stays `QueryResult`-shaped until the type work of
   * stage 7; a `Cascade` term or an exclusive relation aimed at one entity
   * yields a materialised result behind that shape (SPEC §7.4, §7.6).
   */
  public get(terms: readonly Term[]): QueryResult {
    const key = signatureOf(terms);
    let query = this.#byKey.get(key);
    if (query === undefined) {
      query = this.#build(terms, key);
      this.#byKey.set(key, query);
    }
    return query as QueryResult;
  }

  #build(
    terms: readonly Term[],
    key: string,
  ): QueryResult | SortedQueryResult | IndexedQueryResult {
    const forget = () => void this.#byKey.delete(key);
    for (let i = 0; i < terms.length; i++) {
      const term = terms[i];
      const target = indexedTarget(term);
      if (target !== NULL_ENTITY) {
        const relation = (term as TraitInstance)[$trait] as Relation;
        const base = this.get(terms.toSpliced(i, 1, relation));
        const list = this.#relations.stateOf(relation).listFor(target);
        return new IndexedQueryResult(base, list, terms, this, forget);
      }
      if (term instanceof Trait || (term as Modifier)[$term] !== 'cascade') {
        continue;
      }
      const relation = (term as Modifier)[$terms][0] as Relation;
      const base = this.get(terms.toSpliced(i, 1));
      const state = this.#relations.stateOf(relation);
      if (state.depths === null) {
        state.enableDepths(this.entities, this.ticks.tick);
      }
      return new SortedQueryResult(base, terms, state, false, this, forget);
    }

    // Before the binding picks its cursor classes: `Changed` promotes its
    // trait to tracked and `Added` allocates the gain table (SPEC §8.3).
    for (const term of terms) {
      if (termTrait(term) !== null) {
        continue;
      }
      const modifier = term as Modifier;
      const trait = termTrait(modifier[$terms][0] as Term);
      if (trait === null) {
        continue;
      }
      if (modifier[$term] === 'changed') {
        this.track(trait);
      } else if (modifier[$term] === 'added') {
        this.ticks.trackAdded(trait[$id]);
      }
    }

    const query = new QueryResult(this, key, compileTerms(this.#traits, terms), terms);
    this.live.push(query);
    const existing = this.graph.list;
    const plan = query[$plan];
    for (let i = 0; i < existing.length; i++) {
      if (plan.test(existing[i].mask)) {
        query.admit(existing[i]);
      }
    }
    return query;
  }

  /**
   * Builds the view for `parent`. A field's trait is marked tracked, and when
   * the parent does not already require it the view runs over the parent
   * narrowed by `With(trait)`: an entity without the key trait has no key.
   */
  public sortBy(
    parent: QueryResult,
    by: Field | Comparator,
    descending: boolean,
    forget: () => void,
  ): SortedQueryResult {
    let base = parent;
    if (typeof by === 'function') {
      if (__DEV__) {
        assert(!(by instanceof Trait), 'sortBy() takes a field or a comparator');
      }
    } else {
      if (__DEV__) {
        assert($index in by, 'sortBy() takes a field or a comparator');
        assert(
          by.array !== null,
          `sortBy() needs a numeric key and "${by.key}" is not one — use the comparator overload`,
        );
      }
      base = this.#keyed(parent, by);
    }
    return new SortedQueryResult(base, parent[$terms], by, descending, this, forget);
  }

  /** As `sortBy`, for a field only: a comparator has no column to watch (SPEC §6.8). */
  public orderBy(
    parent: QueryResult,
    field: Field,
    descending: boolean,
    site: string,
    forget: () => void,
  ): OrderedQueryResult {
    if (__DEV__) {
      assert(
        typeof field !== 'function' && $index in field,
        'orderBy() takes a field — a comparator has no column to watch and would permute every frame (SPEC §6.8)',
      );
      assert(field.array !== null, `orderBy() needs a numeric key and "${field.key}" is not one`);
    }
    return new OrderedQueryResult(
      this.#keyed(parent, field),
      field,
      descending,
      this,
      site,
      forget,
    );
  }

  /** Marks the key's trait tracked, and narrows `parent` to the entities that carry it. */
  #keyed(parent: QueryResult, field: Field): QueryResult {
    const trait = field[$trait];
    this.track(trait);
    return maskHas(parent[$plan].all, this.#traits.register(trait))
      ? parent
      : this.get([...parent[$terms], With(trait)]);
  }

  /**
   * Promotes a trait to tracked. Queries built before the promotion carry
   * untracked cursors, so they are re-slotted here. A pair promotes its
   * relation, and every pair with it (SPEC §8.3).
   */
  public track(trait: Trait): void {
    trait = shapeOf(trait);
    if (trait[$options].track) {
      return;
    }
    this.graph.track(trait);
    const live = this.live;
    for (let i = 0; i < live.length; i++) {
      live[i].retrack(trait);
    }
  }

  public release(key: string, query: QueryResult): void {
    if (!this.#byKey.delete(key)) {
      return;
    }
    const at = this.live.indexOf(query);
    if (at >= 0) {
      this.live.splice(at, 1);
    }
  }

  public clear(): void {
    this.#byKey.clear();
    this.live.length = 0;
    this.graph.onCreate = null;
  }

  #offer(archetype: Archetype): void {
    const live = this.live;
    const mask = archetype.mask;
    for (let i = 0; i < live.length; i++) {
      const query = live[i];
      if (query[$plan].test(mask)) {
        query.admit(archetype);
      }
    }
  }
}
