import { assert, warnOnce } from './debug';
import { NULL_ENTITY, type Entity } from './entity';
import type { Field, Schema } from './schema';
import {
  $fields,
  $id,
  $index,
  $kind,
  $make,
  $options,
  $plan,
  $relation,
  $schema,
  $target,
  $targetField,
  $trait,
} from './symbols';
import { TraitImpl, allocTraitId, makeInstance, validateInit } from './trait';
import type { Trait, TraitBase, TraitInstance, TraitOptions } from './trait';
import type { Init, TraitFields } from './types';

/** Matches a relation to any target: `world.query(ChildOf('*'))` (SPEC §7.3). */
export const WILDCARD = '*';
export type Wildcard = typeof WILDCARD;

export interface RelationOptions extends TraitOptions {
  /** An entity has at most one target, stored in a column rather than the mask (SPEC §7.4). */
  exclusive?: boolean;
  onTargetDespawn?: 'remove' | 'despawn' | 'orphan';
  /** Dev warns once a non-exclusive relation interns more distinct targets than this. Not a cap. */
  maxPairs?: number;
}

/**
 * A relation is a trait whose instances name a target. The bare-value call
 * signature is what keeps a `Relation<S>` usable everywhere a `Trait<S>` is.
 */
export interface RelationBase<S extends Schema = any> extends Omit<TraitBase<S>, never> {
  (target: Entity | Wildcard, value?: Init<S>): TraitInstance<S>;
  (value?: Init<S>): TraitInstance<S>;
  readonly [$options]: Readonly<Required<RelationOptions>>;
  /** The synthetic column holding the target of an exclusive relation (SPEC §7.4). */
  readonly [$targetField]: Field<Entity, 'eid'>;
}

export type Relation<S extends Schema = any> = RelationBase<S> & TraitFields<S>;

export interface RelationConstructor extends Function {
  new <S extends Schema = undefined>(schema?: S, options?: RelationOptions): Relation<S>;
  readonly prototype: Relation;
}

/**
 * One `(relation, target)` of a non-exclusive relation. It stands in for a
 * trait wherever storage is concerned — a mask bit, its own data columns —
 * while sharing the relation's fields, options and cursor shape (SPEC §7.4).
 */
export interface PairBase<S extends Schema = any> extends TraitBase<S> {
  readonly [$relation]: Relation<S>;
  readonly [$target]: Entity;
}

export type Pair<S extends Schema = any> = PairBase<S> & TraitFields<S>;

const RELATION_DEFAULTS = { exclusive: false, onTargetDespawn: 'remove', maxPairs: 64 } as const;
const DESPAWN_POLICIES = ['remove', 'despawn', 'orphan'];

class RelationImpl extends TraitImpl {
  declare readonly [$targetField]: Field<Entity, 'eid'>;

  public constructor(schema?: Schema, options?: RelationOptions) {
    if (__DEV__ && options?.onTargetDespawn !== undefined) {
      const policy = options.onTargetDespawn;
      assert(DESPAWN_POLICIES.includes(policy), `unknown onTargetDespawn policy "${policy}"`);
    }
    super(schema, options, RELATION_DEFAULTS);
    // `super` hands back the callable, so `this` is the relation itself.
    const self = this as unknown as Relation;
    (self as { [$targetField]: Field<Entity, 'eid'> })[$targetField] = {
      key: WILDCARD,
      path: [],
      kind: 'eid',
      array: Float64Array,
      default: NULL_ENTITY,
      factory: null,
      [$index]: self[$fields].length,
      [$trait]: self,
    };
  }

  public override [$make](target: unknown, value: unknown): TraitInstance {
    if (__DEV__) {
      assert(
        target === WILDCARD || (typeof target === 'number' && target > 0),
        'a relation must be paired with a target entity or the "*" wildcard',
      );
      validateInit(this[$schema], value, '');
    }
    return makeInstance(this as unknown as Trait, target as Entity | Wildcard, value);
  }
}

export const Relation = RelationImpl as unknown as RelationConstructor;

export function isRelation(trait: Trait): trait is Relation {
  return trait instanceof RelationImpl;
}

export function isPair(trait: Trait): trait is Pair {
  return (trait as Pair)[$relation] !== undefined;
}

/** Cheaper than `isRelation` on the spawn path: one property load, and pairs read false. */
export function isExclusive(trait: Trait): trait is Relation {
  return (trait[$options] as RelationOptions).exclusive === true;
}

/** The trait whose columns and cursor class `trait` uses: a pair's relation, else itself. */
export function shapeOf(trait: Trait): Trait {
  const relation = (trait as Pair)[$relation];
  return relation === undefined ? trait : relation;
}

/**
 * Pairs are interned globally: a target handle carries its world, so one
 * table serves every world without collision, and a pair keeps one identity
 * for masks, columns and observer keys alike.
 */
const pairs = new Map<Relation, Map<Entity, Pair>>();

export function pairOf(relation: Relation, target: Entity): Pair {
  let byTarget = pairs.get(relation);
  if (byTarget === undefined) {
    pairs.set(relation, (byTarget = new Map()));
  }
  let pair = byTarget.get(target);
  if (pair === undefined) {
    pair = {
      [$id]: allocTraitId(),
      [$kind]: relation[$kind],
      [$fields]: relation[$fields],
      [$schema]: relation[$schema],
      [$options]: relation[$options],
      [$plan]: relation[$plan],
      [$relation]: relation,
      [$target]: target,
    } as unknown as Pair;
    byTarget.set(target, pair);
    if (__DEV__ && byTarget.size > relation[$options].maxPairs) {
      warnOnce(
        `pairs:${relation[$id]}`,
        `a non-exclusive relation has ${byTarget.size} distinct targets, each of them an ` +
          'archetype bit — declare it { exclusive: true } (SPEC §7.4)',
      );
    }
  }
  return pair;
}

/** The pair if it has ever been interned; observer keys must not intern on lookup. */
export function peekPair(relation: Relation, target: Entity): Pair | undefined {
  return pairs.get(relation)?.get(target);
}

/** Every pair of `relation`, across worlds. */
export function pairsOf(relation: Relation): Iterable<Pair> | undefined {
  return pairs.get(relation)?.values();
}

/** Every interned pair aimed at `target`, one per relation; `null` when there is none. */
export function pairsTo(target: Entity): Pair[] | null {
  let found: Pair[] | null = null;
  for (const byTarget of pairs.values()) {
    const pair = byTarget.get(target);
    if (pair !== undefined) {
      (found ??= []).push(pair);
    }
  }
  return found;
}

export function releasePair(pair: Pair): void {
  pairs.get(pair[$relation])?.delete(pair[$target]);
}
