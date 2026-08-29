import { warn } from './debug'
import type { Entity } from './entity'
import { $index, $mark, $trait } from './symbols'
import type { Trait } from './trait'

export type FieldKind =
  | 'i8'
  | 'i16'
  | 'i32'
  | 'u8'
  | 'u16'
  | 'u32'
  | 'f32'
  | 'f64'
  | 'bool'
  | 'str'
  | 'eid'
  | 'boxed'
  | 'aos'

export type TypedArrayConstructor =
  | Int8ArrayConstructor
  | Int16ArrayConstructor
  | Int32ArrayConstructor
  | Uint8ArrayConstructor
  | Uint16ArrayConstructor
  | Uint32ArrayConstructor
  | Float32ArrayConstructor
  | Float64ArrayConstructor

export type Schema = Record<string, unknown> | (() => unknown) | undefined

export type SchemaKind = 'tag' | 'struct' | 'aos'

/** One column of a trait, addressable as a value: `Position.x` (SPEC §3.3). */
export interface Field<V = unknown> {
  /** Flattened column key — `'pos.x'`. Empty for the single column of an AoS trait. */
  readonly key: string
  readonly path: readonly string[]
  readonly kind: FieldKind
  /** `null` for boxed columns, which page into plain arrays. */
  readonly array: TypedArrayConstructor | null
  readonly default: V
  readonly factory: (() => V) | null
  readonly [$index]: number
  [$trait]: Trait
}

export interface NormalizedSchema {
  readonly kind: SchemaKind
  readonly fields: Field[]
}

interface Marker {
  readonly [$mark]: FieldKind
  readonly value: unknown
}

const ARRAY_FOR: Record<FieldKind, TypedArrayConstructor | null> = {
  i8: Int8Array,
  i16: Int16Array,
  i32: Int32Array,
  u8: Uint8Array,
  u16: Uint16Array,
  u32: Uint32Array,
  f32: Float32Array,
  f64: Float64Array,
  bool: Uint8Array,
  eid: Float64Array,
  str: null,
  boxed: null,
  aos: null,
}

/** Markers type as their underlying primitive so schemas read as plain values (SPEC §3.2). */
const mark =
  <In, Out = In>(kind: FieldKind) =>
  (value: In): Out =>
    ({ [$mark]: kind, value }) as unknown as Out

export const i8 = mark<number>('i8')
export const i16 = mark<number>('i16')
export const i32 = mark<number>('i32')
export const u8 = mark<number>('u8')
export const u16 = mark<number>('u16')
export const u32 = mark<number>('u32')
export const f32 = mark<number>('f32')
export const f64 = mark<number>('f64')
export const bool = mark<boolean>('bool')
export const str = mark<string>('str')
export const eid = mark<Entity | 0, Entity>('eid')

export function isMarker(value: unknown): value is Marker {
  return typeof value === 'object' && value !== null && $mark in value
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function inferKind(value: unknown): FieldKind {
  switch (typeof value) {
    case 'number':
      return 'f64'
    case 'boolean':
      return 'bool'
    case 'string':
      return 'str'
    default:
      return 'boxed'
  }
}

function pushField(
  out: Field[],
  path: readonly string[],
  kind: FieldKind,
  value: unknown,
  factory: (() => unknown) | null,
): void {
  const key = path.join('.')
  if (__DEV__ && kind === 'boxed') {
    warn(
      `field "${key}" holds a boxed value; declare an AoS trait (new Trait(() => ...)) ` +
        'for reference payloads, or a typed field for hot data',
    )
  }
  out.push({
    key,
    path: path.slice(),
    kind,
    array: ARRAY_FOR[kind],
    default: value,
    factory,
    [$index]: out.length,
    [$trait]: null as unknown as Trait,
  })
}

function flatten(source: Record<string, unknown>, path: string[], out: Field[]): void {
  for (const name of Object.keys(source)) {
    const value = source[name]
    path.push(name)
    if (isMarker(value)) pushField(out, path, value[$mark], value.value, null)
    else if (isPlainObject(value)) flatten(value, path, out)
    else pushField(out, path, inferKind(value), value, null)
    path.pop()
  }
}

/** Declaration order is column order, and it is part of the serialization contract. */
export function normalizeSchema(schema: Schema): NormalizedSchema {
  if (schema === undefined || schema === null) return { kind: 'tag', fields: [] }

  const fields: Field[] = []
  if (typeof schema === 'function') {
    pushField(fields, [], 'aos', undefined, schema)
    return { kind: 'aos', fields }
  }

  flatten(schema, [], fields)
  return { kind: 'struct', fields }
}

/** A nested key tree over the flattened fields; leaves are `Field`s (SPEC §4.4). */
export interface Plan {
  [key: string]: Field | Plan
}

/**
 * Mirrors the declared shape so `get` and `set` walk plain objects instead of
 * joining strings. Null-prototype nodes keep `__proto__` and friends inert.
 */
export function buildPlan(fields: readonly Field[]): Plan {
  const root: Plan = Object.create(null)
  for (const field of fields) {
    const { path } = field
    if (path.length === 0) continue
    let node = root
    for (let i = 0; i < path.length - 1; i++) {
      const next = node[path[i]]
      node = next === undefined ? ((node[path[i]] = Object.create(null)) as Plan) : (next as Plan)
    }
    node[path[path.length - 1]] = field
  }
  return root
}
