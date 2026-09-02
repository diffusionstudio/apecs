import type { Archetype } from './archetype'
import type { Column } from './column'
import { cursorClassFor, type Cursor } from './cursor'
import { assert } from './debug'
import { entityId, type Entity } from './entity'
import { shapeOf } from './relation'
import { $id, $kind, $options, $poison, $term, $terms, $trait } from './symbols'
import type { Ticks } from './ticks'
import { isDataTerm, type Modifier, type Term } from './terms'
import { Trait, type TraitInstance } from './trait'
import { traitOf } from './value'

/** The trait a term constrains — a pair for a non-exclusive target — or null for a modifier. */
export function termTrait(term: Term): Trait | null {
  if (term instanceof Trait) return term as Trait
  return $trait in term ? traitOf(term as TraitInstance) : null
}

/** One data-bearing term — one argument position of the `each` callback. */
class Slot {
  readonly trait: Trait
  readonly optional: boolean
  /** `null` for an AoS trait, which yields the stored reference itself. */
  public cursor: Cursor | null

  public constructor(trait: Trait, optional: boolean) {
    const cls = cursorClassFor(shapeOf(trait), trait[$options].track)
    this.trait = trait
    this.optional = optional
    this.cursor = cls === null ? null : new cls()
  }
}

/**
 * The `each` argument list and its binding to one archetype's columns, split
 * so a row loop only walks what actually moves: cursors take a row index,
 * AoS slots take a fresh reference (SPEC §6.5).
 */
export class Binding {
  readonly slots: Slot[] = []
  readonly args: unknown[]
  readonly cursors: Cursor[] = []
  readonly cursorColumns: Column[][] = []
  readonly boxedArg: number[] = []
  readonly boxedColumn: Column[] = []
  readonly boxedPage: unknown[][] = []

  public constructor(terms: readonly Term[]) {
    for (const term of terms) {
      if (!isDataTerm(term)) continue
      const optional = !(term instanceof Trait) && (term as Modifier)[$term] === 'optional'
      const subject = optional ? ((term as Modifier)[$terms][0] as Term) : term
      this.slots.push(new Slot(termTrait(subject)!, optional))
    }
    this.args = new Array(this.slots.length + 1).fill(null)
  }

  /**
   * Points every slot at this archetype's columns. Returns false when a
   * required trait is not stored here at all — a sparse trait carries no mask
   * bit, so no archetype can satisfy it (SPEC §3.5).
   */
  public bind(archetype: Archetype): boolean {
    const { slots, args, cursors, cursorColumns, boxedArg, boxedColumn } = this
    cursors.length = 0
    cursorColumns.length = 0
    boxedArg.length = 0
    boxedColumn.length = 0

    for (let s = 0; s < slots.length; s++) {
      const slot = slots[s]
      const columns = archetype.columnsOf.get(slot.trait[$id])
      if (columns === undefined) {
        if (!slot.optional) return false
        args[s] = null
      } else if (slot.cursor !== null) {
        args[s] = slot.cursor
        cursors.push(slot.cursor)
        cursorColumns.push(columns)
      } else {
        boxedArg.push(s)
        boxedColumn.push(columns[0])
      }
    }
    return true
  }

  /** Swaps in the tracked cursor class once its trait is promoted (SPEC §8.3). */
  public retrack(trait: Trait): void {
    const slots = this.slots
    for (let s = 0; s < slots.length; s++) {
      const slot = slots[s]
      if (shapeOf(slot.trait) === trait && slot.cursor !== null)
        slot.cursor = new (cursorClassFor(trait, true)!)()
    }
  }

  public poison(): void {
    const slots = this.slots
    for (let s = 0; s < slots.length; s++) slots[s].cursor?.[$poison]()
  }
}

/** The callback call, with the common arities spelled out so no `apply` is needed. */
export function invoke(
  fn: (...args: any[]) => void,
  args: unknown[],
  arity: number,
  entity: Entity,
): void {
  switch (arity) {
    case 0:
      fn(entity)
      break
    case 1:
      fn(args[0], entity)
      break
    case 2:
      fn(args[0], args[1], entity)
      break
    case 3:
      fn(args[0], args[1], args[2], entity)
      break
    default:
      args[arity] = entity
      fn.apply(undefined, args)
  }
}

const NO_TRAITS: readonly Trait[] = []
const NO_IDS: readonly number[] = []

/**
 * The tick-based terms of a query and the scratch their per-row test needs,
 * reused so a filtered walk allocates nothing. Each filter keeps its own
 * horizon, so two systems watching one trait see the same events (SPEC §8.3).
 */
export class RowFilter {
  /** Per-row tick columns. */
  readonly #changed: readonly Trait[]
  /** Entity-indexed gain tables, by global trait id. */
  readonly #added: readonly number[]
  /** The removal log, by global trait id. */
  readonly #removed: readonly number[]

  readonly #changedColumns: Column[][] = []
  readonly #addedTables: Uint32Array[] = []
  readonly #removedSets: Set<number>[] = []
  #lastSeen = -1
  /** `#lastSeen` as it stood when the current run began. */
  #horizon = -1

  private constructor(
    changed: readonly Trait[],
    added: readonly number[],
    removed: readonly number[],
  ) {
    this.#changed = changed
    this.#added = added
    this.#removed = removed
  }

  /** The filter for a term list, or null when it has no tick-based terms. */
  public static of(terms: readonly Term[]): RowFilter | null {
    let changed: Trait[] | null = null
    let added: number[] | null = null
    let removed: number[] | null = null

    for (const term of terms) {
      if (termTrait(term) !== null) continue
      const modifier = term as Modifier
      const trait = termTrait(modifier[$terms][0] as Term)
      if (trait === null) continue
      switch (modifier[$term]) {
        case 'changed':
          if (__DEV__) assert(trait[$kind] !== 'tag', 'Changed() needs a data-bearing trait')
          ;(changed ??= []).push(trait)
          break
        case 'added':
          ;(added ??= []).push(trait[$id])
          break
        case 'removed':
          ;(removed ??= []).push(trait[$id])
          break
      }
    }

    if (changed === null && added === null && removed === null) return null
    return new RowFilter(changed ?? NO_TRAITS, added ?? NO_IDS, removed ?? NO_IDS)
  }

  /**
   * Opens a run: fixes its horizon and resolves the removal records to handle
   * sets. Returns false when a set is empty, so the conjunction cannot match
   * and the walk is skipped outright.
   */
  public begin(ticks: Ticks): boolean {
    this.#horizon = this.#lastSeen
    this.#lastSeen = ticks.tick

    const removed = this.#removed
    const removedSets = this.#removedSets
    for (let r = 0; r < removed.length; r++) {
      const set = (removedSets[r] ??= new Set())
      set.clear()
      ticks.collectRemoved(removed[r], this.#horizon, set)
      if (set.size === 0) return false
    }
    const added = this.#added
    const addedTables = this.#addedTables
    for (let a = 0; a < added.length; a++) addedTables[a] = ticks.added.get(added[a])!
    return true
  }

  public bind(archetype: Archetype): void {
    const changed = this.#changed
    const changedColumns = this.#changedColumns
    for (let t = 0; t < changed.length; t++)
      changedColumns[t] = archetype.columnsOf.get(changed[t][$id])!
  }

  public accept(entity: Entity, page: number, i: number): boolean {
    const horizon = this.#horizon
    const changedColumns = this.#changedColumns
    for (let t = 0; t < changedColumns.length; t++) {
      const columns = changedColumns[t]
      let hit = false
      for (let c = 0; c < columns.length && !hit; c++) hit = columns[c].ticks![page][i] > horizon
      if (!hit) return false
    }

    const addedTables = this.#addedTables
    if (addedTables.length !== 0) {
      const id = entityId(entity)
      for (let a = 0; a < addedTables.length; a++) {
        const table = addedTables[a]
        // A row the table has never reached carries the zero tick, which is
        // exactly what lets a query's first run see pre-existing entities.
        if ((id < table.length ? table[id] : 0) <= horizon) return false
      }
    }

    const removedSets = this.#removedSets
    for (let r = 0; r < removedSets.length; r++) if (!removedSets[r].has(entity)) return false
    return true
  }
}
