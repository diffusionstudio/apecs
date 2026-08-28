import { describe, expect, test } from 'vitest'

import { Relation, Trait } from '../src/index'
import {
  $fields,
  $id,
  $index,
  $kind,
  $options,
  $target,
  $trait,
  $value,
  WILDCARD,
  packEntity,
} from '../src/internal'

const parent = packEntity(2, 1, 0)
const other = packEntity(3, 1, 0)

describe('declaration (§7.1)', () => {
  test('a relation is a trait', () => {
    const ChildOf = new Relation()

    expect(ChildOf).toBeInstanceOf(Relation)
    expect(ChildOf).toBeInstanceOf(Trait)
    expect(typeof ChildOf).toBe('function')
  })

  test('a bare relation is a tag relation', () => {
    const ChildOf = new Relation()

    expect(ChildOf[$kind]).toBe('tag')
    expect(ChildOf[$fields]).toHaveLength(0)
  })

  test('a relation with a schema exposes fields like any trait', () => {
    const Likes = new Relation({ amount: 0 })

    expect(Likes[$kind]).toBe('struct')
    expect(Object.keys(Likes)).toEqual(['amount'])
    expect(Likes.amount[$trait]).toBe(Likes)
    expect(Likes.amount[$index]).toBe(0)
  })

  test('relations draw from the same global id space as traits (§5.3)', () => {
    const T = new Trait({ x: 0 })
    const R = new Relation()

    expect(R[$id]).toBeGreaterThan(T[$id])
  })
})

describe('options (§7.1)', () => {
  test('defaults: non-exclusive, remove on target despawn', () => {
    const ChildOf = new Relation()

    expect(ChildOf[$options]).toMatchObject({
      exclusive: false,
      onTargetDespawn: 'remove',
      storage: 'table',
      track: false,
    })
  })

  test('options are parsed off the second argument', () => {
    const ChildOf = new Relation(undefined, { exclusive: true, onTargetDespawn: 'despawn' })

    expect(ChildOf[$options]).toMatchObject({ exclusive: true, onTargetDespawn: 'despawn' })
  })

  test.each(['remove', 'despawn', 'orphan'] as const)('accepts onTargetDespawn %s', (policy) => {
    expect(new Relation(undefined, { onTargetDespawn: policy })[$options].onTargetDespawn).toBe(
      policy,
    )
  })

  test.runIf(__DEV__)('dev rejects an unknown despawn policy', () => {
    expect(() => new Relation(undefined, { onTargetDespawn: 'nuke' as never })).toThrowError(
      /apecs/,
    )
  })
})

describe('pair instances (§7.2)', () => {
  test('calling a relation pairs it with a target', () => {
    const ChildOf = new Relation()
    const pair = ChildOf(parent)

    expect(pair[$trait]).toBe(ChildOf)
    expect(pair[$target]).toBe(parent)
    expect(pair[$value]).toBeUndefined()
  })

  test('a data relation takes the target first and the value second', () => {
    const Likes = new Relation({ amount: 0 })
    const init = { amount: 5 }
    const pair = Likes(other, init)

    expect(pair[$target]).toBe(other)
    expect(pair[$value]).toBe(init)
  })

  test("'*' is the wildcard target", () => {
    const ChildOf = new Relation()

    expect(WILDCARD).toBe('*')
    expect(ChildOf('*')[$target]).toBe(WILDCARD)
  })

  test('each call produces a fresh pair', () => {
    const ChildOf = new Relation()

    expect(ChildOf(parent)).not.toBe(ChildOf(parent))
  })

  test.runIf(__DEV__)('dev requires a target', () => {
    const ChildOf = new Relation()

    expect(() => (ChildOf as () => unknown)()).toThrowError(/apecs/)
    expect(() => ChildOf(0 as never)).toThrowError(/apecs/)
  })
})
