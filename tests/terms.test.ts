import { describe, expect, test } from 'vitest'

import {
  Added,
  Cascade,
  Changed,
  Not,
  Optional,
  Or,
  Relation,
  Removed,
  Trait,
  With,
} from '../src/index'
import { $term, $terms, isDataTerm } from '../src/internal'

const Position = new Trait({ x: 0, y: 0 })
const Velocity = new Trait({ x: 0, y: 0 })
const IsActive = new Trait()
const Mesh = new Trait(() => ({ id: 0 }))
const ChildOf = new Relation(undefined, { exclusive: true })

describe('construction (§6.1)', () => {
  test.each([
    ['not', Not(Position)],
    ['with', With(IsActive)],
    ['optional', Optional(Velocity)],
    ['added', Added(Velocity)],
    ['removed', Removed(Velocity)],
    ['changed', Changed(Position)],
    ['cascade', Cascade(ChildOf)],
  ])('%s tags its term and wraps one operand', (kind, term) => {
    expect(term[$term]).toBe(kind)
    expect(term[$terms]).toHaveLength(1)
  })

  test('Or wraps all of its operands, in order', () => {
    const term = Or(Velocity, Mesh, IsActive)

    expect(term[$term]).toBe('or')
    expect(term[$terms]).toEqual([Velocity, Mesh, IsActive])
  })

  test('a term is a plain object, distinct per call', () => {
    expect(Not(Position)).not.toBe(Not(Position))
    expect(Not(Position)).not.toBeInstanceOf(Trait)
    expect(typeof Not(Position)).toBe('object')
  })

  test('a bare trait carries no term tag', () => {
    expect((Position as { [$term]?: string })[$term]).toBeUndefined()
  })
})

describe('nesting (§6.1)', () => {
  test('modifiers nest', () => {
    const term = Or(Not(Position), Velocity)

    expect(term[$terms][0][$term]).toBe('not')
    expect(term[$terms][0][$terms][0]).toBe(Position)
    expect(term[$terms][1]).toBe(Velocity)
  })

  test('Not composes with itself and with Or', () => {
    const term = Not(Or(Position, Velocity))

    expect(term[$term]).toBe('not')
    expect(term[$terms][0][$term]).toBe('or')
    expect(Not(Not(Position))[$terms][0][$term]).toBe('not')
  })
})

describe('data-bearing classification (§6.1)', () => {
  test('struct and AoS traits contribute an argument', () => {
    expect(isDataTerm(Position)).toBe(true)
    expect(isDataTerm(Mesh)).toBe(true)
  })

  test('tags contribute nothing', () => {
    expect(isDataTerm(IsActive)).toBe(false)
  })

  test('Optional contributes for data traits only', () => {
    expect(isDataTerm(Optional(Position))).toBe(true)
    expect(isDataTerm(Optional(IsActive))).toBe(false)
  })

  test.each([
    ['not', Not(Position)],
    ['with', With(Position)],
    ['or', Or(Position, Velocity)],
    ['added', Added(Position)],
    ['removed', Removed(Position)],
    ['changed', Changed(Position)],
    ['cascade', Cascade(ChildOf)],
  ])('%s contributes nothing', (_kind, term) => {
    expect(isDataTerm(term)).toBe(false)
  })
})

describe('dev validation (§12.2)', () => {
  test.runIf(__DEV__)('modifiers that need a trait reject a nested term', () => {
    expect(() => With(Not(Position) as never)).toThrowError(/apecs/)
    expect(() => Changed(Not(Position) as never)).toThrowError(/apecs/)
    expect(() => Added(Or(Position, Velocity) as never)).toThrowError(/apecs/)
    expect(() => Removed(Optional(Position) as never)).toThrowError(/apecs/)
    expect(() => Optional(With(Position) as never)).toThrowError(/apecs/)
  })

  test.runIf(__DEV__)('Cascade requires a relation', () => {
    expect(() => Cascade(Position as never)).toThrowError(/apecs/)
  })

  test.runIf(__DEV__)('Or requires at least one operand', () => {
    expect(() => Or()).toThrowError(/apecs/)
  })

  test.runIf(!__DEV__)('the checks are compiled out in prod', () => {
    expect(() => Or()).not.toThrow()
    expect(() => Cascade(Position as never)).not.toThrow()
  })
})
