import type { Column } from './column'
import { assert } from './debug'
import type { Field, Plan } from './schema'
import { $fields, $index, $kind, $plan, $trait, $value } from './symbols'
import type { Trait, TraitInstance } from './trait'

/** A trait passed bare, or paired with an initial value (SPEC §3.4). */
export type TraitLike = Trait | TraitInstance

export function traitOf(item: TraitLike): Trait {
  return typeof item === 'function' ? item : item[$trait]
}

export function valueOf(item: TraitLike): unknown {
  return typeof item === 'function' ? undefined : item[$value]
}

/** Columns hold `0`/`1`; the declared type is `boolean` (SPEC §3.2). */
function decode(field: Field, raw: unknown): unknown {
  return field.kind === 'bool' ? raw !== 0 : raw
}

/** Rebuilds the declared shape into `out`, reusing the nested objects it already has. */
export function readStruct(
  plan: Plan,
  columns: Column[],
  row: number,
  out: Record<string, unknown>,
): Record<string, unknown> {
  for (const key in plan) {
    const node = plan[key]
    if ($index in node) {
      const field = node as Field
      out[key] = decode(field, columns[field[$index]].get(row))
    } else {
      const nested = out[key]
      out[key] = readStruct(
        node as Plan,
        columns,
        row,
        typeof nested === 'object' && nested !== null ? (nested as Record<string, unknown>) : {},
      )
    }
  }
  return out
}

/** Writes only the fields `value` carries; each written column is tick-stamped. */
export function writeStruct(
  plan: Plan,
  columns: Column[],
  row: number,
  value: Record<string, unknown>,
  tick: number,
): void {
  for (const key in value) {
    const node = plan[key]
    if (node === undefined) {
      if (__DEV__) assert(false, `"${key}" is not a field of this trait`)
      continue
    }
    if ($index in node) {
      const column = columns[(node as Field)[$index]]
      column.set(row, value[key])
      column.stamp(row, tick)
    } else writeStruct(node as Plan, columns, row, value[key] as Record<string, unknown>, tick)
  }
}

/**
 * Seeds a freshly occupied row: schema defaults first, then the instance value.
 * An AoS value is adopted outright, so the factory never runs for it (SPEC §3.4).
 */
export function initTrait(
  columns: Column[] | undefined,
  row: number,
  trait: Trait,
  value: unknown,
  tick: number,
): void {
  if (columns === undefined) return
  if (trait[$kind] === 'aos') {
    columns[0].set(row, value === undefined ? trait[$fields][0].factory!() : value)
    columns[0].stamp(row, tick)
    return
  }
  for (let i = 0; i < columns.length; i++) {
    columns[i].init(row)
    columns[i].stamp(row, tick)
  }
  if (value !== undefined)
    writeStruct(trait[$plan], columns, row, value as Record<string, unknown>, tick)
}
