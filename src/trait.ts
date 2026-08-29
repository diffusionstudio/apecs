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
  $target,
  $trait,
  $value,
} from './symbols'

export interface TraitOptions {
  /** `'table'` keeps columns inside the archetype; `'sparse'` keeps them outside it (SPEC §3.5). */
  storage?: 'table' | 'sparse'
  /** Force change-tick allocation instead of waiting for a subscriber (SPEC §8.3). */
  track?: boolean
}

/** A trait paired with an initial value, and — for relations — a target (SPEC §3.4, §7.2). */
export interface TraitInstance {
  readonly [$trait]: Trait
  readonly [$target]: Entity | '*'
  readonly [$value]: unknown
}

// The call signature stays loose until the public type surface lands in stage 7 (SPEC §11).
export interface Trait {
  (...args: any[]): TraitInstance
  readonly [$id]: number
  readonly [$kind]: SchemaKind
  readonly [$fields]: readonly Field[]
  readonly [$schema]: Schema
  readonly [$options]: Readonly<Required<TraitOptions>>
  /** Nested key tree over the flattened fields, for `get` / `set` (SPEC §4.4). */
  readonly [$plan]: Plan
  /**
   * Fields, and nothing else, are the string-keyed properties (SPEC §3.3). The
   * `Function` members are redeclared because a trait's prototype is swapped away
   * from `Function.prototype`, so a field may legally be named `call` or `name`.
   */
  readonly length: Field
  readonly name: Field
  readonly prototype: Field
  readonly apply: Field
  readonly call: Field
  readonly bind: Field
  readonly toString: Field
  readonly arguments: Field
  readonly caller: Field
  readonly [key: string]: Field
}

export interface TraitConstructor extends Function {
  new (schema?: Schema, options?: TraitOptions): Trait
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
  [$make](a: unknown, b: unknown): TraitInstance
}

const DEFAULT_OPTIONS = { storage: 'table', track: false } as const

/** Ids start at 1 so a zeroed slot never names a trait. */
let nextTraitId = 1

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

  public constructor(schema?: Schema, options?: TraitOptions, defaults?: object) {
    const { kind, fields } = normalizeSchema(schema)

    // A trait is callable (SPEC §3.4); the prototype makes `instanceof` hold and lets
    // `Relation` override how a call is interpreted.
    const self = ((a?: unknown, b?: unknown) => self[$make](a, b)) as unknown as TraitState
    Object.setPrototypeOf(self, new.target.prototype)

    self[$id] = nextTraitId++
    self[$kind] = kind
    self[$fields] = fields
    self[$schema] = schema
    self[$plan] = buildPlan(fields)
    self[$options] = { ...DEFAULT_OPTIONS, ...defaults, ...options }

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
