import { assert } from './debug'
import { Relation } from './relation'
import { $kind, $options, $term, $terms, $trait } from './symbols'
import { Trait } from './trait'
import type { TraitInstance } from './trait'

export type TermKind =
  'not' | 'or' | 'with' | 'optional' | 'added' | 'removed' | 'changed' | 'cascade'

export interface Modifier<K extends TermKind = TermKind> {
  readonly [$term]: K
  readonly [$terms]: readonly any[]
}

/** A bare trait, a relation pair, or a modifier wrapping either (SPEC §6.1). */
export type Term = Trait | TraitInstance | Modifier

function term<K extends TermKind>(kind: K, operands: readonly Term[]): Modifier<K> {
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

export function Not(operand: Term): Modifier<'not'> {
  return term('not', [operand])
}

export function Or(...operands: Term[]): Modifier<'or'> {
  if (__DEV__) assert(operands.length > 0, 'Or() needs at least one term')
  return term('or', operands)
}

export function With(trait: Term): Modifier<'with'> {
  if (__DEV__) requireTrait('With', trait)
  return term('with', [trait])
}

export function Optional(trait: Term): Modifier<'optional'> {
  if (__DEV__) requireTrait('Optional', trait)
  return term('optional', [trait])
}

export function Added(trait: Term): Modifier<'added'> {
  if (__DEV__) requireTrait('Added', trait)
  return term('added', [trait])
}

export function Removed(trait: Term): Modifier<'removed'> {
  if (__DEV__) requireTrait('Removed', trait)
  return term('removed', [trait])
}

export function Changed(trait: Term): Modifier<'changed'> {
  if (__DEV__) requireTrait('Changed', trait)
  return term('changed', [trait])
}

export function Cascade(relation: Term): Modifier<'cascade'> {
  if (__DEV__) {
    assert(
      relation instanceof Relation && relation[$options].exclusive,
      'Cascade() takes an exclusive relation',
    )
  }
  return term('cascade', [relation])
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
