/**
 * T7.6 — every entry of the SPEC §14 surface is exported, with the shape the
 * spec gives it, and nothing internal leaks out of the public entry point.
 */
import { describe, expect, test } from 'vitest'

import * as apecs from '../src/index'
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
  World,
  bool,
  eid,
  f32,
  f64,
  i8,
  i16,
  i32,
  str,
  u8,
  u16,
  u32,
} from '../src/index'

const MARKERS = { f32, f64, i8, i16, i32, u8, u16, u32, bool, str, eid }

const MODIFIERS = { Not, Or, With, Optional, Added, Removed, Changed, Cascade }

const WORLD_METHODS = [
  'step',
  'destroy',
  'clear',
  'compact',
  'spawn',
  'spawnMany',
  'despawn',
  'despawnMany',
  'isAlive',
  'add',
  'addMany',
  'remove',
  'removeMany',
  'has',
  'get',
  'set',
  'accessor',
  'changed',
  'target',
  'targets',
  'query',
  'createQuery',
  'queryFirst',
  'onAdd',
  'onRemove',
  'onChange',
  'onEnter',
  'onExit',
  'defer',
  'flush',
] as const

const QUERY_METHODS = ['each', 'chunks', 'entities', 'sortBy', 'dispose'] as const

describe('exports (§14)', () => {
  test('the entry point exports exactly the documented surface', () => {
    const expected = [
      'VERSION',
      'Trait',
      'Relation',
      ...Object.keys(MARKERS),
      ...Object.keys(MODIFIERS),
      'World',
    ].sort()

    expect(Object.keys(apecs).sort()).toEqual(expected)
  })

  test('Trait and Relation are constructors that produce callable traits', () => {
    const Position = new Trait({ x: f32(0) })
    const ChildOf = new Relation(undefined, { exclusive: true })

    expect(Position).toBeInstanceOf(Trait)
    expect(ChildOf).toBeInstanceOf(Relation)
    expect(ChildOf).toBeInstanceOf(Trait)
    expect(typeof Position).toBe('function')
    expect(typeof ChildOf).toBe('function')
  })

  test('every field marker is a function that a schema accepts', () => {
    for (const [name, marker] of Object.entries(MARKERS)) {
      expect(typeof marker, name).toBe('function')
    }

    const trait = new Trait({
      a: i8(0),
      b: i16(0),
      c: i32(0),
      d: u8(0),
      e: u16(0),
      f: u32(0),
      g: f32(0),
      h: f64(0),
      i: bool(false),
      j: str(''),
      k: eid(0),
    })
    const world = new World()
    const entity = world.spawn(trait)

    expect(Object.keys(world.get(entity, trait))).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
      'h',
      'i',
      'j',
      'k',
    ])

    world.destroy()
  })

  test('every modifier is a function producing a term', () => {
    const Position = new Trait({ x: f32(0) })
    const ChildOf = new Relation(undefined, { exclusive: true })

    for (const [name, modifier] of Object.entries(MODIFIERS)) {
      expect(typeof modifier, name).toBe('function')
    }

    const world = new World()
    const terms = [
      Not(Position),
      Or(Position),
      With(Position),
      Optional(Position),
      Added(Position),
      Removed(Position),
      Changed(Position),
      Cascade(ChildOf),
    ]

    for (const term of terms) expect(typeof world.query(term).count).toBe('number')

    world.destroy()
  })
})

describe('world surface (§14)', () => {
  test('every world method lives on the prototype', () => {
    for (const name of WORLD_METHODS) {
      expect(typeof World.prototype[name], name).toBe('function')
    }
  })

  test('an accessor carries get and set and nothing else (§4.5)', () => {
    const world = new World()
    const Position = new Trait({ x: f32(0) })
    const entity = world.spawn(Position({ x: 2 }))
    const px = world.accessor(Position.x)

    expect(typeof px.get).toBe('function')
    expect(typeof px.set).toBe('function')
    expect(px.get(entity)).toBe(2)
    expect(Object.keys(px).filter((key) => key === 'get' || key === 'set')).toEqual([])

    world.destroy()
  })

  test('entity and tick are accessors, not methods', () => {
    const world = new World()

    const start = world.tick

    expect(typeof world.entity).toBe('number')
    expect(Number.isInteger(start)).toBe(true)
    world.step()
    expect(world.tick).toBe(start + 1)

    world.destroy()
  })
})

describe('query surface (§14)', () => {
  const Position = new Trait({ x: f32(0) })

  test('a query result carries the tier-1 accessors and the tier-2/3 walks', () => {
    const world = new World()
    world.spawn(Position({ x: 1 }))
    const query = world.query(Position)

    expect(query.count).toBe(1)
    expect(query.isEmpty).toBe(false)
    expect(typeof query.first).toBe('number')
    expect(typeof query[Symbol.iterator]).toBe('function')
    for (const name of QUERY_METHODS) {
      expect(typeof (query as unknown as Record<string, unknown>)[name], name).toBe('function')
    }
    expect(query.entities()).toBeInstanceOf(Float64Array)

    world.destroy()
  })

  test('createQuery hoists the same object and queryFirst is sugar for first', () => {
    const world = new World()

    expect(world.query(Position)).toBe(world.query(Position))
    expect(world.createQuery(Position)).toBe(world.query(Position))
    expect(world.queryFirst(Position)).toBeUndefined()

    const entity = world.spawn(Position)

    expect(world.queryFirst(Position)).toBe(entity)

    world.destroy()
  })

  test('sortBy takes a field or a comparator and exposes the escape hatches', () => {
    const world = new World()
    world.spawn(Position({ x: 2 }))
    world.spawn(Position({ x: 1 }))
    world.step()
    const byField = world.query(Position).sortBy(Position.x)
    const byComparator = world.query(Position).sortBy((a, b) => a - b)

    for (const sorted of [byField, byComparator]) {
      expect(typeof sorted.invalidate).toBe('function')
      expect(typeof sorted.rebuild).toBe('function')
      expect(sorted.count).toBe(2)
      expect([...sorted]).toHaveLength(2)
    }

    // A field key is watched; a comparator can read anything, so it never settles.
    expect(byField.isDirty).toBe('clean')
    expect(byComparator.isDirty).toBe('resort')

    world.destroy()
  })
})

describe('observers and deferral (§14)', () => {
  const Position = new Trait({ x: f32(0) })

  test('every subscription returns an unsubscribe function', () => {
    const world = new World()
    const noop = () => {}
    const query = world.query(Position)
    const offs = [
      world.onAdd(Position, noop),
      world.onRemove(Position, noop),
      world.onChange(Position, noop),
      world.onEnter(query, noop),
      world.onExit(query, noop),
    ]

    for (const off of offs) expect(typeof off).toBe('function')
    for (const off of offs) off()

    world.destroy()
  })

  test('defer queues and flush drains', () => {
    const world = new World()
    const order: number[] = []

    world.defer(() => order.push(1))
    world.defer(() => order.push(2))

    expect(order).toEqual([])

    world.flush()

    expect(order).toEqual([1, 2])

    world.destroy()
  })
})
