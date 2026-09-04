import { assert } from './debug'
import { NULL_ENTITY, type Entity } from './entity'
import { buildPlan, isMarker, isPlainObject, normalizeSchema } from './schema'
import type { Field, Plan, Schema, SchemaKind } from './schema'
import {
  $fields,
  $id,
  $kind,
  $make,
  $options,
  $plan,
  $schema,
  $sparse,
  $target,
  $trait,
  $value,
} from './symbols'
import type { Init, TraitFields } from './types'

export interface TraitOptions {
  /** `'table'` keeps columns inside the archetype; `'sparse'` keeps them outside it (SPEC §3.5). */
  storage?: 'table' | 'sparse'
  /** Force change-tick allocation instead of waiting for a subscriber (SPEC §8.3). */
  track?: boolean
}

/** A trait paired with an initial value, and — for relations — a target (SPEC §3.4, §7.2). */
export interface TraitInstance<S extends Schema = any> {
  readonly [$trait]: Trait<S>
  readonly [$target]: Entity | '*'
  readonly [$value]: unknown
}

/**
 * The declaration slots every trait carries. `S` is the schema as it was
 * written, which is what the mappings of SPEC §11 read; the fields it declares
 * come from `TraitFields`, so `Position.x` is a `Field<number>` and
 * `Position.z` does not exist.
 */
export interface TraitBase<S extends Schema = any> {
  (value?: Init<S>): TraitInstance<S>
  readonly [$id]: number
  readonly [$kind]: SchemaKind
  readonly [$fields]: readonly Field[]
  readonly [$schema]: S
  readonly [$options]: Readonly<Required<TraitOptions>>
  /** Nested key tree over the flattened fields, for `get` / `set` (SPEC §4.4). */
  readonly [$plan]: Plan
  /** `storage === 'sparse'`, hoisted off the options for the per-entity paths. */
  readonly [$sparse]: boolean
}

export type Trait<S extends Schema = any> = TraitBase<S> & TraitFields<S>

export interface TraitConstructor extends Function {
  new <S extends Schema = undefined>(schema?: S, options?: TraitOptions): Trait<S>
  readonly prototype: Trait
}

/** The mutable view the constructor builds before the object is frozen into a `Trait`. */
interface TraitState {
  (...args: any[]): TraitInstance
  [$id]: number
  [$kind]: SchemaKind
  [$fields]: readonly Field[]
  [$schema]: Schema
  [$options]: Required<TraitOptions> & Record<string, unknown>
  [$plan]: Plan
  [$sparse]: boolean
  [$make](a: unknown, b: unknown): TraitInstance
}

const DEFAULT_OPTIONS = { storage: 'table', track: false } as const

/** Ids start at 1 so a zeroed slot never names a trait. */
let nextTraitId = 1

/** Relation pairs draw from the same id space as traits, since they own columns like one. */
export function allocTraitId(): number {
  return nextTraitId++
}

export function makeInstance(trait: Trait, target: Entity | '*', value: unknown): TraitInstance {
  return { [$trait]: trait, [$target]: target, [$value]: value }
}

/** Rejects init keys the schema does not declare. Dev only — the walk is not free. */
export function validateInit(schema: Schema, value: unknown, prefix: string): void {
  if (value === undefined || value === null) return
  const declared = isPlainObject(schema) ? schema : {}
  for (const key of Object.keys(value as object)) {
    assert(Object.hasOwn(declared, key), `"${prefix}${key}" is not a field of this trait`)
    const sub = declared[key]
    if (isPlainObject(sub) && !isMarker(sub)) {
      validateInit(sub, (value as Record<string, unknown>)[key], `${prefix}${key}.`)
    }
  }
}

export class TraitImpl {
  declare readonly [$id]: number
  declare readonly [$kind]: SchemaKind
  declare readonly [$fields]: readonly Field[]
  declare readonly [$schema]: Schema
  declare readonly [$options]: Required<TraitOptions> & Record<string, unknown>
  declare readonly [$plan]: Plan
  declare readonly [$sparse]: boolean

  public constructor(schema?: Schema, options?: TraitOptions, defaults?: object) {
    const { kind, fields } = normalizeSchema(schema)

    // A trait is callable (SPEC §3.4); the prototype makes `instanceof` hold and lets
    // `Relation` override how a call is interpreted.
    const self = ((a?: unknown, b?: unknown) => self[$make](a, b)) as unknown as TraitState
    Object.setPrototypeOf(self, new.target.prototype)

    self[$id] = allocTraitId()
    self[$kind] = kind
    self[$fields] = fields
    self[$schema] = schema
    self[$plan] = buildPlan(fields)
    self[$options] = { ...DEFAULT_OPTIONS, ...defaults, ...options }
    self[$sparse] = self[$options].storage === 'sparse'

    if (__DEV__) {
      const { storage } = self[$options]
      assert(storage === 'table' || storage === 'sparse', `unknown storage mode "${storage}"`)
    }

    for (const field of fields) {
      field[$trait] = self as unknown as Trait
      if (field.key === '') continue
      // `length` and `name` exist on every function; deleting first puts the schema's
      // own keys back in declaration order.
      if (Object.hasOwn(self, field.key))
        delete (self as unknown as Record<string, unknown>)[field.key]
      Object.defineProperty(self, field.key, {
        value: field,
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }

    return self as unknown as TraitImpl
  }

  public [$make](value: unknown, _unused: unknown): TraitInstance {
    if (__DEV__ && this[$kind] !== 'aos') validateInit(this[$schema], value, '')
    return makeInstance(this as unknown as Trait, NULL_ENTITY, value)
  }
}

export const Trait = TraitImpl as unknown as TraitConstructor

/** Flips the trait tracked; columns born afterwards allocate tick storage (SPEC §8.3). */
export function setTracked(trait: Trait): void {
  ;(trait[$options] as { track: boolean }).track = true
}
