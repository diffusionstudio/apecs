/**
 * SPEC §3 — traits: how they are declared, what a field is, and what calling
 * one produces. Public API only.
 */
import { afterEach, describe, expect, test } from 'vitest'

import {
  Changed,
  Trait,
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
} from '../../src/index'
import type { Entity } from '../../src/index'

const worlds: World[] = []

function makeWorld(): World {
  const world = new World()
  worlds.push(world)
  return world
}

afterEach(() => {
  for (const world of worlds.splice(0)) world.destroy()
})

describe('declaration (§3.1)', () => {
  test('a struct trait carries both the shape and the defaults', () => {
    const Position = new Trait({ x: f32(1), y: f32(2) })
    const world = makeWorld()

    expect(world.get(world.spawn(Position), Position)).toEqual({ x: 1, y: 2 })
  })

  test('a tag has no data and is passed bare', () => {
    const IsActive = new Trait()
    const world = makeWorld()
    const entity = world.spawn(IsActive)

    expect(world.has(entity, IsActive)).toBe(true)
    expect(world.query(IsActive).count).toBe(1)
  })

  test('an AoS trait calls its factory once per entity', () => {
    let calls = 0
    const Mesh = new Trait(() => ({ id: calls++ }))
    const world = makeWorld()
    const a = world.spawn(Mesh)
    const b = world.spawn(Mesh)

    expect(calls).toBe(2)
    expect(world.get(a, Mesh)).not.toBe(world.get(b, Mesh))
    expect(world.get(a, Mesh)).toEqual({ id: 0 })
    expect(world.get(b, Mesh)).toEqual({ id: 1 })
  })

  test('an AoS instance adopts the reference it is handed', () => {
    const Mesh = new Trait(() => ({ id: -1 }))
    const world = makeWorld()
    const existing = { id: 7 }

    expect(world.get(world.spawn(Mesh(existing)), Mesh)).toBe(existing)
  })
})

describe('field types (§3.2)', () => {
  test('every marker round-trips through its column', () => {
    const All = new Trait({
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
    const world = makeWorld()
    const other = world.spawn()
    const entity = world.spawn(
      All({
        a: -8,
        b: -300,
        c: -70000,
        d: 8,
        e: 300,
        f: 70000,
        g: 0.5,
        h: 0.1,
        i: true,
        j: 'hello',
        k: other,
      }),
    )

    expect(world.get(entity, All)).toEqual({
      a: -8,
      b: -300,
      c: -70000,
      d: 8,
      e: 300,
      f: 70000,
      g: 0.5,
      h: 0.1,
      i: true,
      j: 'hello',
      k: other,
    })
  })

  test('markers narrow the storage — f32 loses precision f64 keeps', () => {
    const Narrow = new Trait({ v: f32(0) })
    const Wide = new Trait({ v: f64(0) })
    const world = makeWorld()
    const entity = world.spawn(Narrow({ v: 0.1 }), Wide({ v: 0.1 }))

    expect(world.get(entity, Narrow.v)).toBe(Math.fround(0.1))
    expect(world.get(entity, Narrow.v)).not.toBe(0.1)
    expect(world.get(entity, Wide.v)).toBe(0.1)
  })

  test('integer markers wrap at their width', () => {
    const Bytes = new Trait({ signed: i8(0), unsigned: u8(0) })
    const world = makeWorld()
    const entity = world.spawn(Bytes({ signed: 200, unsigned: 300 }))

    expect(world.get(entity, Bytes.signed)).toBe(-56)
    expect(world.get(entity, Bytes.unsigned)).toBe(44)
  })

  test('bare values infer their column: number is f64, false is bool, string is boxed', () => {
    const Bare = new Trait({ n: 0, b: false, s: '' })
    const world = makeWorld()
    const entity = world.spawn(Bare({ n: 0.1, b: true, s: 'x' }))

    expect(world.get(entity, Bare.n)).toBe(0.1)
    expect(world.get(entity, Bare.b)).toBe(true)
    expect(world.get(entity, Bare.s)).toBe('x')
  })

  test('a bool column reads back as a boolean, never as 0 or 1', () => {
    const Flags = new Trait({ on: false })
    const world = makeWorld()
    const entity = world.spawn(Flags)

    expect(world.get(entity, Flags.on)).toBe(false)
    world.set(entity, Flags.on, true)
    expect(world.get(entity, Flags.on)).toBe(true)
  })

  test('a plain object nests and flattens to dotted column names', () => {
    const Body = new Trait({ pos: { x: f32(1), y: f32(2) }, mass: 3 })
    const world = makeWorld()
    const entity = world.spawn(Body)

    expect(world.get(entity, Body)).toEqual({ pos: { x: 1, y: 2 }, mass: 3 })
    expect(world.get(entity, Body['pos.x'])).toBe(1)

    world.set(entity, Body['pos.y'], 9)

    expect(world.get(entity, Body)).toEqual({ pos: { x: 1, y: 9 }, mass: 3 })
  })

  test('field order in the schema is the column order and is stable', () => {
    const Ordered = new Trait({ z: 0, a: 0, m: 0 })
    const world = makeWorld()

    expect(Object.keys(world.get(world.spawn(Ordered), Ordered))).toEqual(['z', 'a', 'm'])
  })
})

describe('fields are values (§3.3)', () => {
  test('a trait exposes its fields and nothing else as string keys', () => {
    const Position = new Trait({ x: f32(0), y: f32(0) })

    expect(Object.keys(Position).sort()).toEqual(['x', 'y'])
  })

  test('no schema key can collide with an operation — operations live on World', () => {
    const Shadow = new Trait({ get: 0, set: 0, add: 0, remove: 0, query: 0, spawn: 0 })
    const world = makeWorld()
    const entity = world.spawn(Shadow({ get: 1, set: 2, add: 3, remove: 4, query: 5, spawn: 6 }))

    expect(world.get(entity, Shadow.get)).toBe(1)
    expect(world.get(entity, Shadow.spawn)).toBe(6)
  })

  test('a field is accepted anywhere a single value is wanted', () => {
    const Position = new Trait({ x: f32(0), y: f32(0) })
    const world = makeWorld()
    const entity = world.spawn(Position({ x: 1, y: 2 }))

    expect(world.get(entity, Position.x)).toBe(1)
    world.set(entity, Position.x, 20)
    expect(world.get(entity, Position.x)).toBe(20)
    expect(world.get(entity, Position)).toEqual({ x: 20, y: 2 })
  })

  test('an AoS trait is its own field', () => {
    const Mesh = new Trait(() => ({ n: 0 }))
    const world = makeWorld()
    const entity = world.spawn(Mesh)
    const replacement = { n: 5 }

    world.set(entity, Mesh, replacement)

    expect(world.get(entity, Mesh)).toBe(replacement)
  })

  test('the same field object is handed out on every property read', () => {
    const Position = new Trait({ x: f32(0) })

    expect(Position.x).toBe(Position.x)
  })
})

describe('trait instances (§3.4)', () => {
  test('a trait is callable and calling it does not mutate the trait', () => {
    const Position = new Trait({ x: f32(0), y: f32(0) })

    expect(typeof Position).toBe('function')
    expect(Position({ x: 1 })).not.toBe(Position)
    expect(Position instanceof Trait).toBe(true)
  })

  test('an init is partial — unspecified fields take the declared default', () => {
    const Position = new Trait({ x: f32(3), y: f32(4) })
    const world = makeWorld()

    expect(world.get(world.spawn(Position({ x: 1 })), Position)).toEqual({ x: 1, y: 4 })
  })

  test('an init nests to match a nested schema', () => {
    const Body = new Trait({ pos: { x: 0, y: 0 }, mass: 1 })
    const world = makeWorld()

    expect(world.get(world.spawn(Body({ pos: { y: 9 } })), Body)).toEqual({
      pos: { x: 0, y: 9 },
      mass: 1,
    })
  })

  test('a trait instance is reusable across spawns without sharing storage', () => {
    const Position = new Trait({ x: f32(0), y: f32(0) })
    const world = makeWorld()
    const init = Position({ x: 1, y: 1 })
    const a = world.spawn(init)
    const b = world.spawn(init)

    world.set(a, Position.x, 99)

    expect(world.get(b, Position.x)).toBe(1)
  })

  test.runIf(__DEV__)('an init key the schema does not declare is rejected', () => {
    const Position = new Trait({ x: f32(0) })

    expect(() => Position({ z: 1 } as never)).toThrow()
  })
})

describe('options (§3.5)', () => {
  test('track: true makes Changed work without any other opt-in', () => {
    const Tracked = new Trait({ v: 0 }, { track: true })
    const world = makeWorld()
    const entity = world.spawn(Tracked)
    const changed = world.query(Tracked, Changed(Tracked))
    const seen: number[] = []
    const drain = () => {
      seen.length = 0
      changed.each((_c, e) => seen.push(e))
    }

    drain() // consume the initial state

    world.step()
    world.set(entity, Tracked.v, 1)
    drain()

    expect(seen).toEqual([entity])

    world.step()
    drain()

    expect(seen).toEqual([])
  })

  test('options are optional — a bare schema is a valid declaration', () => {
    const Plain = new Trait({ v: 0 })
    const world = makeWorld()

    expect(world.get(world.spawn(Plain), Plain.v)).toBe(0)
  })
})

describe('traits are global (§3.1, §5.3)', () => {
  test('one declaration works in any number of worlds with no collision', () => {
    const Position = new Trait({ x: f32(0) })
    const a = makeWorld()
    const b = makeWorld()
    const ea: Entity = a.spawn(Position({ x: 1 }))
    const eb: Entity = b.spawn(Position({ x: 2 }))

    expect(a.get(ea, Position.x)).toBe(1)
    expect(b.get(eb, Position.x)).toBe(2)
    expect(a.query(Position).count).toBe(1)
    expect(b.query(Position).count).toBe(1)
  })
})
