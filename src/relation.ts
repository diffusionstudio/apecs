import { assert } from './debug'
import type { Entity } from './entity'
import type { Schema } from './schema'
import { $make, $options, $schema } from './symbols'
import { TraitImpl, makeInstance, validateInit } from './trait'
import type { Trait, TraitInstance, TraitOptions } from './trait'

/** Matches a relation to any target: `world.query(ChildOf('*'))` (SPEC §7.3). */
export const WILDCARD = '*'
export type Wildcard = typeof WILDCARD

export interface RelationOptions extends TraitOptions {
  /** An entity has at most one target, stored in a column rather than the mask (SPEC §7.4). */
  exclusive?: boolean
  onTargetDespawn?: 'remove' | 'despawn' | 'orphan'
}

export interface Relation extends Trait {
  readonly [$options]: Readonly<Required<RelationOptions>>
}

export interface RelationConstructor extends Function {
  new (schema?: Schema, options?: RelationOptions): Relation
  readonly prototype: Relation
}

const RELATION_DEFAULTS = { exclusive: false, onTargetDespawn: 'remove' } as const
const DESPAWN_POLICIES = ['remove', 'despawn', 'orphan']

class RelationImpl extends TraitImpl {
  public constructor(schema?: Schema, options?: RelationOptions) {
    if (__DEV__ && options?.onTargetDespawn !== undefined) {
      const policy = options.onTargetDespawn
      assert(DESPAWN_POLICIES.includes(policy), `unknown onTargetDespawn policy "${policy}"`)
    }
    super(schema, options, RELATION_DEFAULTS)
  }

  public override [$make](target: unknown, value: unknown): TraitInstance {
    if (__DEV__) {
      assert(
        target === WILDCARD || (typeof target === 'number' && target > 0),
        'a relation must be paired with a target entity or the "*" wildcard',
      )
      validateInit(this[$schema], value, '')
    }
    return makeInstance(this as unknown as Trait, target as Entity | Wildcard, value)
  }
}

export const Relation = RelationImpl as unknown as RelationConstructor
