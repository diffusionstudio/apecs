import { Column } from './column'
import { nextPowerOfTwo } from './entity-index'
import type { Field } from './schema'
import { $fields, $index } from './symbols'
import type { Trait } from './trait'
import { initTrait } from './value'

const NO_SLOT = -1

/**
 * One world-global sparse set for a `storage: 'sparse'` trait. Adding or
 * removing it never touches the archetype graph, so a churning trait costs no
 * row moves — one indirection per access instead (SPEC §3.5).
 */
export class SparseStore {
  readonly trait: Trait
  /** Same layout as an archetype's columns for the trait, indexed by field index. */
  readonly columns: Column[]

  /** Entity id → slot, `NO_SLOT` when absent. */
  private slots = new Int32Array(0)
  /** Slot → entity id, kept dense by swap-remove. */
  private dense = new Uint32Array(8)
  private size = 0
  private capacity = 0
  private readonly pageSize: number

  public constructor(trait: Trait, pageSize: number) {
    const fields = trait[$fields]
    this.trait = trait
    this.pageSize = pageSize
    this.columns = new Array(fields.length)
    for (let i = 0; i < fields.length; i++) this.columns[i] = new Column(fields[i], pageSize)
  }

  public slotOf(id: number): number {
    return id < this.slots.length ? this.slots[id] : NO_SLOT
  }

  public column(field: Field): Column {
    return this.columns[field[$index]]
  }

  /** Returns whether the trait was newly attached, rather than re-seeded. */
  public add(id: number, value: unknown, tick: number): boolean {
    const slot = this.slotOf(id)
    if (slot !== NO_SLOT) {
      if (value !== undefined) initTrait(this.columns, slot, this.trait, value, tick)
      return false
    }
    const fresh = this.size++
    this.reserve(id, this.size)
    this.slots[id] = fresh
    this.dense[fresh] = id
    initTrait(this.columns, fresh, this.trait, value, tick)
    return true
  }

  /** Returns whether the trait was actually present. */
  public remove(id: number): boolean {
    const slot = this.slotOf(id)
    if (slot === NO_SLOT) return false
    const last = --this.size
    const columns = this.columns
    for (let i = 0; i < columns.length; i++) columns[i].swapRemove(slot, last)
    const moved = this.dense[last]
    this.dense[slot] = moved
    this.slots[moved] = slot
    this.slots[id] = NO_SLOT
    return true
  }

  public compact(): void {
    const columns = this.columns
    for (let i = 0; i < columns.length; i++) columns[i].compact(this.size)
    this.capacity = Math.ceil(this.size / this.pageSize) * this.pageSize
  }

  private reserve(id: number, rows: number): void {
    if (id >= this.slots.length) {
      const slots = new Int32Array(nextPowerOfTwo(id + 1)).fill(NO_SLOT)
      slots.set(this.slots)
      this.slots = slots
    }
    if (rows > this.dense.length) {
      const dense = new Uint32Array(this.dense.length * 2)
      dense.set(this.dense)
      this.dense = dense
    }
    if (rows > this.capacity) {
      const columns = this.columns
      for (let i = 0; i < columns.length; i++) columns[i].ensure(rows)
      this.capacity = Math.ceil(rows / this.pageSize) * this.pageSize
    }
  }
}
