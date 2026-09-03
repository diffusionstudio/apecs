import { assert } from './debug'
import { Relation } from './relation'
import { $kind, $options, $term, $terms, $trait } from './symbols'
import { Trait } from './trait'
import type { TraitInstance } from './trait'

export type TermKind =
  'not' | 'or' | 'with' | 'optional' | 'added' | 'removed' | 'changed' | 'cascade'

export interface Modifier<K extends TermKind = TermKind, Ops extends readonly Term[] = Term[]> {
  readonly [$term]: K
  readonly [$terms]: Ops
}

/** A bare trait, a relation pair, or a modifier wrapping either (SPEC §6.1). */
export type Term = Trait | TraitInstance | Modifier

function term<K extends TermKind, Ops extends readonly Term[]>(
  kind: K,
  operands: Ops,
): Modifier<K, Ops> {
  return { [$term]: kind, [$terms]: operands }
}

/** True for traits and relation pairs — the things a modifier may wrap directly. */
function isTraitTerm(operand: unknown): boolean {
  return (
    operand instanceof Trait ||
    (typeof operand === 'object' && operand !== null && $trait in operand)
  )
}

function requireTrait(name: string, operand: unknown): void {
  assert(isTraitTerm(operand), `${name}() takes a trait, not a nested term`)
}

export function Not<T extends Term>(operand: T): Modifier<'not', [T]> {
  return term('not', [operand] as [T])
}

export function Or<T extends Term[]>(...operands: T): Modifier<'or', T> {
  if (__DEV__) assert(operands.length > 0, 'Or() needs at least one term')
  return term('or', operands)
}

export function With<T extends Term>(trait: T): Modifier<'with', [T]> {
  if (__DEV__) requireTrait('With', trait)
  return term('with', [trait] as [T])
}

export function Optional<T extends Term>(trait: T): Modifier<'optional', [T]> {
  if (__DEV__) requireTrait('Optional', trait)
  return term('optional', [trait] as [T])
}

export function Added<T extends Term>(trait: T): Modifier<'added', [T]> {
  if (__DEV__) requireTrait('Added', trait)
  return term('added', [trait] as [T])
}

export function Removed<T extends Term>(trait: T): Modifier<'removed', [T]> {
  if (__DEV__) requireTrait('Removed', trait)
  return term('removed', [trait] as [T])
}

export function Changed<T extends Term>(trait: T): Modifier<'changed', [T]> {
  if (__DEV__) requireTrait('Changed', trait)
  return term('changed', [trait] as [T])
}

export function Cascade<T extends Term>(relation: T): Modifier<'cascade', [T]> {
  if (__DEV__) {
    assert(
      relation instanceof Relation && relation[$options].exclusive,
      'Cascade() takes an exclusive relation',
    )
  }
  return term('cascade', [relation] as [T])
}

/**
 * Whether the term contributes an argument to `each` / `chunks`. Tags, `Not` and
 * `With` contribute nothing; `Optional` follows its operand (SPEC §6.1).
 */
export function isDataTerm(operand: Term): boolean {
  if (operand instanceof Trait) return operand[$kind] !== 'tag'

  const modifier = operand as Modifier
  if (modifier[$term] === 'optional') return isDataTerm(modifier[$terms][0])

  const trait = (operand as TraitInstance)[$trait]
  return trait !== undefined && trait[$kind] !== 'tag'
}
