import { describe, expect, test } from 'vitest'

import { Trait, f32 } from '../src/index'
import { $fields, $id, $index, $kind, $options, $trait, $value } from '../src/internal'

describe('declaration (§3.1)', () => {
  test('a struct trait is callable and an instance of Trait', () => {
    const Position = new Trait({ x: f32(0), y: f32(0) })

    expect(typeof Position).toBe('function')
    expect(Position).toBeInstanceOf(Trait)
    expect(Position[$kind]).toBe('struct')
    expect(Position[$fields].map((f) => f.key)).toEqual(['x', 'y'])
  })

  test('a tag trait has no fields and no columns', () => {
    const IsActive = new Trait()

    expect(IsActive).toBeInstanceOf(Trait)
    expect(IsActive[$kind]).toBe('tag')
    expect(IsActive[$fields]).toHaveLength(0)
    expect(Object.keys(IsActive)).toEqual([])
  })

  test('an AoS trait has one column and is its own field', () => {
    const factory = () => ({ id: 1 })
    const Mesh = new Trait(factory)

    expect(Mesh[$kind]).toBe('aos')
    expect(Mesh[$fields]).toHaveLength(1)
    expect(Mesh[$fields][0].factory).toBe(factory)
    expect(Object.keys(Mesh)).toEqual([])
  })

  test('every trait gets a distinct, ascending global id (§5.3)', () => {
    const a = new Trait({ x: 0 })
    const b = new Trait()

    expect(typeof a[$id]).toBe('number')
    expect(b[$id]).toBeGreaterThan(a[$id])
  })
})

describe('fields are values (§3.3)', () => {
  test('string-keyed properties are the fields and nothing else', () => {
    const Position = new Trait({ x: 0, y: 0 })

    expect(Object.keys(Position)).toEqual(['x', 'y'])
  })

  test('a field points back at its trait and its column index', () => {
    const Position = new Trait({ x: 0, y: 0 })

    expect(Position.x[$trait]).toBe(Position)
    expect(Position.x[$index]).toBe(0)
    expect(Position.y[$index]).toBe(1)
  })

  test('nested fields are addressed by their flattened column key', () => {
    const Transform = new Trait({ pos: { x: 0, y: 0 }, scale: 1 })

    expect(Object.keys(Transform)).toEqual(['pos.x', 'pos.y', 'scale'])
    expect(Transform['pos.y'][$index]).toBe(1)
  })

  test('a field name never collides with a function property', () => {
    const Weird = new Trait({ name: '', length: 0, call: 0 })

    expect(Object.keys(Weird)).toEqual(['name', 'length', 'call'])
    expect(Weird.name[$trait]).toBe(Weird)
    expect(Weird.length[$index]).toBe(1)
  })

  test('internals are symbol-keyed so they cannot shadow a schema key', () => {
    const Position = new Trait({ x: 0 })

    expect(Object.getOwnPropertySymbols(Position).length).toBeGreaterThan(0)
    expect(Object.keys(Position)).not.toContain('kind')
  })
})

describe('trait instances (§3.4)', () => {
  test('calling a trait pairs it with an initial value', () => {
    const Position = new Trait({ x: 0, y: 0 })
    const init = { x: 20 }
    const instance = Position(init)

    expect(instance[$trait]).toBe(Position)
    expect(instance[$value]).toBe(init)
  })

  test('an instance is not itself a trait', () => {
    const Position = new Trait({ x: 0 })

    expect(Position({ x: 1 })).not.toBeInstanceOf(Trait)
    expect(typeof Position({ x: 1 })).toBe('object')
  })

  test('an AoS trait adopts the reference it is given', () => {
    const Mesh = new Trait(() => ({ id: 0 }))
    const existing = { id: 7 }

    expect(Mesh(existing)[$value]).toBe(existing)
  })

  test('calling with no value defers entirely to the defaults', () => {
    const Position = new Trait({ x: 0 })

    expect(Position()[$value]).toBeUndefined()
  })

  test('each call produces a fresh instance', () => {
    const Position = new Trait({ x: 0 })

    expect(Position({ x: 1 })).not.toBe(Position({ x: 1 }))
  })

  test.runIf(__DEV__)('dev rejects a key that is not in the schema', () => {
    const Position = new Trait({ x: 0, y: 0 })

    expect(() => Position({ z: 1 } as never)).toThrowError(/apecs/)
    expect(() => Position({ x: 1 })).not.toThrow()
  })
})

describe('options (§3.5)', () => {
  test('tracking defaults to off', () => {
    const Position = new Trait({ x: 0 })

    expect(Position[$options]).toMatchObject({ track: false })
  })

  test('options are parsed off the second argument', () => {
    const Bulky = new Trait({ x: 0 }, { track: true })

    expect(Bulky[$options]).toMatchObject({ track: true })
  })

  test('a tag can carry options too', () => {
    const Flag = new Trait(undefined, { track: true })

    expect(Flag[$kind]).toBe('tag')
    expect(Flag[$options].track).toBe(true)
  })
})
