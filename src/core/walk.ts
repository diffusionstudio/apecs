import type { Archetype } from './archetype';
import type { Column } from './column';
import { CAN_CODEGEN, distinct } from './codegen';
import { cursorClassFor, type Cursor } from './cursor';
import { assert } from './debug';
import { entityId, type Entity } from './entity';
import type { Frame } from './iteration';
import { shapeOf } from './relation';
import { $id, $kind, $options, $poison, $row, $term, $terms, $trait } from './symbols';
import type { Ticks } from './ticks';
import { isDataTerm, type Modifier, type Term } from './terms';
import { Trait, type TraitInstance } from './trait';
import { traitOf } from './value';

/** The trait a term constrains — a pair for a non-exclusive target — or null for a modifier. */
export function termTrait(term: Term): Trait | null {
  if (term instanceof Trait) {
    return term as Trait;
  }
  return $trait in term ? traitOf(term as TraitInstance) : null;
}

/** One data-bearing term — one argument position of the `each` callback. */
class Slot {
  readonly trait: Trait;
  readonly optional: boolean;
  /** `null` for an AoS trait, which yields the stored reference itself. */
  public cursor: Cursor | null;

  public constructor(trait: Trait, optional: boolean) {
    const cls = cursorClassFor(shapeOf(trait), trait[$options].track);
    this.trait = trait;
    this.optional = optional;
    this.cursor = cls === null ? null : new cls();
  }
}

/**
 * The `each` argument list and its binding to one archetype's columns, split
 * so a row loop only walks what actually moves: cursors take a row index,
 * AoS slots take a fresh reference (SPEC §6.5).
 */
export class Binding {
  readonly slots: Slot[] = [];
  readonly args: unknown[];
  readonly cursors: Cursor[] = [];
  readonly cursorColumns: Column[][] = [];
  readonly boxedArg: number[] = [];
  readonly boxedColumn: Column[] = [];
  readonly boxedPage: unknown[][] = [];

  /** The row loop for the layout `bind` last produced (SPEC §6.5). */
  public driver: Driver = genericDriver;
  /** One driver per layout this query has seen — `Optional` is what makes it more than one. */
  readonly #drivers = new Map<number, Driver>();
  #layout = -1;
  readonly #filtered: boolean;

  public constructor(terms: readonly Term[], filtered = false) {
    this.#filtered = filtered;
    for (const term of terms) {
      if (!isDataTerm(term)) {
        continue;
      }
      const optional = !(term instanceof Trait) && (term as Modifier)[$term] === 'optional';
      const subject = optional ? ((term as Modifier)[$terms][0] as Term) : term;
      this.slots.push(new Slot(termTrait(subject)!, optional));
    }
    this.args = new Array(this.slots.length + 1).fill(null);
  }

  /** Points every slot at this archetype's columns; false when a required trait is absent. */
  public bind(archetype: Archetype): boolean {
    const { slots, args, cursors, cursorColumns, boxedArg, boxedColumn } = this;
    cursors.length = 0;
    cursorColumns.length = 0;
    boxedArg.length = 0;
    boxedColumn.length = 0;
    let layout = 0;

    for (let s = 0; s < slots.length; s++) {
      const slot = slots[s];
      const columns = archetype.columnsOf.get(slot.trait[$id]);
      if (columns === undefined) {
        if (!slot.optional) {
          return false;
        }
        args[s] = null;
      } else if (slot.cursor !== null) {
        args[s] = slot.cursor;
        cursors.push(slot.cursor);
        cursorColumns.push(columns);
        layout |= CURSOR << (s << 1);
      } else {
        boxedArg.push(s);
        boxedColumn.push(columns[0]);
        layout |= BOXED << (s << 1);
      }
    }

    // Archetypes of one query almost always share a layout; only `Optional`
    // makes it vary, and then only between two or three shapes.
    if (layout !== this.#layout) {
      this.#layout = layout;
      let driver = this.#drivers.get(layout);
      if (driver === undefined) {
        driver = driverFor(layout, slots.length, this.#filtered);
        this.#drivers.set(layout, driver);
      }
      this.driver = driver;
    }
    return true;
  }

  /** Swaps in the tracked cursor class once its trait is promoted (SPEC §8.3). */
  public retrack(trait: Trait): void {
    const slots = this.slots;
    for (let s = 0; s < slots.length; s++) {
      const slot = slots[s];
      if (shapeOf(slot.trait) === trait && slot.cursor !== null) {
        slot.cursor = new (cursorClassFor(trait, true)!)();
      }
    }
  }

  public poison(): void {
    const slots = this.slots;
    for (let s = 0; s < slots.length; s++) {
      slots[s].cursor?.[$poison]();
    }
  }
}

/**
 * The row loop of one page: advance every cursor, read the boxed slots, call
 * the callback. `frame` and `base` are the dev-only iteration cursor.
 *
 * Returns false when the callback asked to stop, which the walk above it takes
 * as `break`. The test is `=== false`, so a bare `return` does not stop a walk
 * and neither does the number an arrow body like `(p, v) => (p.x += v.x)`
 * evaluates to (SPEC §6.5).
 */
export type Driver = (
  fn: (...args: any[]) => unknown,
  binding: Binding,
  handles: Float64Array,
  start: number,
  frame: Frame,
  base: number,
  filter: RowFilter | null,
  page: number,
) => boolean;

const CURSOR = 1;
const BOXED = 2;
/** Two layout bits per slot, so wider argument lists take the generic loop. */
const MAX_GENERATED_SLOTS = 15;

/**
 * The dispatch, generated per argument layout: cursor row stores and the call
 * itself are written out, so a row costs the callback and nothing around it
 * (SPEC §6.5, §12.2).
 *
 * One driver per query, not one per layout: the call to the callback is the
 * hottest site in the library, and sharing a driver between queries is what
 * would make it megamorphic (SPEC §12.2, rule 2). Falls back to the reflective
 * loop where `new Function` is unavailable.
 */
export function driverFor(layout: number, arity: number, filtered: boolean): Driver {
  if (!CAN_CODEGEN || arity > MAX_GENERATED_SLOTS) {
    return filtered ? genericFiltered : genericDriver;
  }
  return generateDriver(layout, arity, filtered);
}

function generateDriver(layout: number, arity: number, filtered: boolean): Driver {
  let declarations = '';
  let advance = '';
  let call = '';
  let cursors = 0;
  let boxed = 0;

  for (let s = 0; s < arity; s++) {
    switch ((layout >>> (s << 1)) & 3) {
      case CURSOR:
        declarations += `const a${s}=c[${cursors++}];`;
        advance += `a${s}[R]=i;`;
        call += `a${s},`;
        break;
      case BOXED:
        declarations += `const p${s}=g[${boxed++}];`;
        call += `p${s}[i],`;
        break;
      default:
        call += 'null,';
    }
  }

  const accept = filtered ? 'if(!q.accept(h[i],y,i))continue;' : '';
  const source =
    distinct() +
    `const c=b.cursors,g=b.boxedPage;${declarations}` +
    `for(let i=s;i>=0;i--){${accept}${advance}${__DEV__ ? 'f.row=k|i;' : ''}` +
    `if(n(${call}h[i])===false)return false}return true`;
  return new Function('R', `return function(n,b,h,s,f,k,q,y){${source}}`)($row) as Driver;
}

/** The same loop, reading the argument array — the CSP fallback (SPEC §6.5). */
const genericDriver: Driver = (fn, binding, handles, start, frame, base) => {
  const { args, cursors, boxedArg, boxedPage } = binding;
  const arity = args.length - 1;
  const cursorCount = cursors.length;
  const boxedCount = boxedArg.length;

  for (let i = start; i >= 0; i--) {
    for (let c = 0; c < cursorCount; c++) {
      cursors[c][$row] = i;
    }
    for (let b = 0; b < boxedCount; b++) {
      args[boxedArg[b]] = boxedPage[b][i];
    }
    if (__DEV__) {
      frame.row = base | i;
    }
    if (invoke(fn, args, arity, handles[i] as Entity) === false) {
      return false;
    }
  }
  return true;
};

const genericFiltered: Driver = (fn, binding, handles, start, frame, base, filter, page) => {
  const { args, cursors, boxedArg, boxedPage } = binding;
  const arity = args.length - 1;
  const cursorCount = cursors.length;
  const boxedCount = boxedArg.length;

  for (let i = start; i >= 0; i--) {
    const entity = handles[i] as Entity;
    if (!filter!.accept(entity, page, i)) {
      continue;
    }
    for (let c = 0; c < cursorCount; c++) {
      cursors[c][$row] = i;
    }
    for (let b = 0; b < boxedCount; b++) {
      args[boxedArg[b]] = boxedPage[b][i];
    }
    if (__DEV__) {
      frame.row = base | i;
    }
    if (invoke(fn, args, arity, entity) === false) {
      return false;
    }
  }
  return true;
};

/** The callback call, with the common arities spelled out so no `apply` is needed. */
export function invoke(
  fn: (...args: any[]) => unknown,
  args: unknown[],
  arity: number,
  entity: Entity,
): unknown {
  switch (arity) {
    case 0:
      return fn(entity);
    case 1:
      return fn(args[0], entity);
    case 2:
      return fn(args[0], args[1], entity);
    case 3:
      return fn(args[0], args[1], args[2], entity);
    default:
      args[arity] = entity;
      return fn.apply(undefined, args);
  }
}

const NO_TRAITS: readonly Trait[] = [];
const NO_IDS: readonly number[] = [];

/**
 * The tick-based terms of a query and the scratch their per-row test needs,
 * reused so a filtered walk allocates nothing. Each filter keeps its own
 * horizon, so two systems watching one trait see the same events (SPEC §8.3).
 */
export class RowFilter {
  /** Per-row tick columns. */
  readonly #changed: readonly Trait[];
  /** Entity-indexed gain tables, by global trait id. */
  readonly #added: readonly number[];
  /** The removal log, by global trait id. */
  readonly #removed: readonly number[];

  readonly #changedColumns: Column[][] = [];
  readonly #addedTables: Uint32Array[] = [];
  readonly #removedSets: Set<number>[] = [];
  #lastSeen = -1;
  /** `#lastSeen` as it stood when the current run began. */
  #horizon = -1;

  private constructor(
    changed: readonly Trait[],
    added: readonly number[],
    removed: readonly number[],
  ) {
    this.#changed = changed;
    this.#added = added;
    this.#removed = removed;
  }

  /** The filter for a term list, or null when it has no tick-based terms. */
  public static of(terms: readonly Term[]): RowFilter | null {
    let changed: Trait[] | null = null;
    let added: number[] | null = null;
    let removed: number[] | null = null;

    for (const term of terms) {
      if (termTrait(term) !== null) {
        continue;
      }
      const modifier = term as Modifier;
      const trait = termTrait(modifier[$terms][0] as Term);
      if (trait === null) {
        continue;
      }
      switch (modifier[$term]) {
        case 'changed':
          if (__DEV__) {
            assert(trait[$kind] !== 'tag', 'Changed() needs a data-bearing trait');
          }
          (changed ??= []).push(trait);
          break;
        case 'added':
          (added ??= []).push(trait[$id]);
          break;
        case 'removed':
          (removed ??= []).push(trait[$id]);
          break;
      }
    }

    if (changed === null && added === null && removed === null) {
      return null;
    }
    return new RowFilter(changed ?? NO_TRAITS, added ?? NO_IDS, removed ?? NO_IDS);
  }

  /**
   * Opens a run: fixes its horizon and resolves the removal records to handle
   * sets. Returns false when a set is empty, so the conjunction cannot match
   * and the walk is skipped outright.
   */
  public begin(ticks: Ticks): boolean {
    this.#horizon = this.#lastSeen;
    this.#lastSeen = ticks.tick;

    const removed = this.#removed;
    const removedSets = this.#removedSets;
    for (let r = 0; r < removed.length; r++) {
      const set = (removedSets[r] ??= new Set());
      set.clear();
      ticks.collectRemoved(removed[r], this.#horizon, set);
      if (set.size === 0) {
        return false;
      }
    }
    const added = this.#added;
    const addedTables = this.#addedTables;
    for (let a = 0; a < added.length; a++) {
      addedTables[a] = ticks.added.get(added[a])!;
    }
    return true;
  }

  public bind(archetype: Archetype): void {
    const changed = this.#changed;
    const changedColumns = this.#changedColumns;
    for (let t = 0; t < changed.length; t++) {
      changedColumns[t] = archetype.columnsOf.get(changed[t][$id])!;
    }
  }

  public accept(entity: Entity, page: number, i: number): boolean {
    const horizon = this.#horizon;
    const changedColumns = this.#changedColumns;
    for (let t = 0; t < changedColumns.length; t++) {
      const columns = changedColumns[t];
      let hit = false;
      for (let c = 0; c < columns.length && !hit; c++) {
        hit = columns[c].ticks![page][i] > horizon;
      }
      if (!hit) {
        return false;
      }
    }

    const addedTables = this.#addedTables;
    if (addedTables.length !== 0) {
      const id = entityId(entity);
      for (let a = 0; a < addedTables.length; a++) {
        const table = addedTables[a];
        // A row the table has never reached carries the zero tick, which is
        // exactly what lets a query's first run see pre-existing entities.
        if ((id < table.length ? table[id] : 0) <= horizon) {
          return false;
        }
      }
    }

    const removedSets = this.#removedSets;
    for (let r = 0; r < removedSets.length; r++) {
      if (!removedSets[r].has(entity)) {
        return false;
      }
    }
    return true;
  }
}
