/**
 * T7.1 — the public type surface (SPEC §11). Nothing here runs; the `types`
 * project compiles it and every `@ts-expect-error` must be a real error.
 */
import { describe, expectTypeOf, test } from 'vitest'

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
  i32,
  str,
  u8,
} from '../src/index'
import type { Cursor, Entity, Store, Value, Values } from '../src/index'

class Mesh {
  declare public readonly geometry: { dispose(): void }
  public position = { set(_x: number, _y: number, _z: number): void {} }
}

const Position = new Trait({ x: f32(0), y: f32(0) })
const Velocity = new Trait({ x: f32(0), y: f32(0) })
const Stats = new Trait({ hp: 0, name: str(''), alive: bool(false), owner: eid(0) })
const Nested = new Trait({ pos: { x: f32(0), y: f32(0) }, level: u8(0) })
const MeshOf = new Trait(() => new Mesh())
const IsActive = new Trait()
const ChildOf = new Relation(undefined, { exclusive: true })
const Likes = new Relation({ amount: i32(0) })

type PositionSchema = { x: number; y: number }

const world = new World()
const entity = world.spawn()

describe('markers and schemas (§3.2, §11)', () => {
  test('a marker reads as its primitive inside a schema', () => {
    expectTypeOf(f32(0)).toExtend<number>()
    expectTypeOf(str('')).toExtend<string>()
    expectTypeOf(bool(false)).toExtend<boolean>()
    expectTypeOf(eid(0)).toExtend<number>()
    // @ts-expect-error — a field marker takes its own primitive
    f32('nope')
  })

  test('Value strips the markers, Cursor makes them writable', () => {
    expectTypeOf<Value<{ x: ReturnType<typeof f32> }>>().toEqualTypeOf<{ x: number }>()
    expectTypeOf<Cursor<{ hp: number; name: ReturnType<typeof str> }>>().toEqualTypeOf<{
      hp: number
      name: string
    }>()
    expectTypeOf<Value<() => Mesh>>().toEqualTypeOf<Mesh>()
    expectTypeOf<Cursor<() => Mesh>>().toEqualTypeOf<Mesh>()
  })

  test('Store maps every field to the typed array that backs it', () => {
    expectTypeOf<Store<{ x: ReturnType<typeof f32> }>>().toEqualTypeOf<{
      readonly x: Float32Array
    }>()
    expectTypeOf<Store<{ hp: number; on: ReturnType<typeof bool> }>>().toEqualTypeOf<{
      readonly hp: Float64Array
      readonly on: Uint8Array
    }>()
    expectTypeOf<Store<() => Mesh>>().toEqualTypeOf<Mesh[]>()
  })
})

describe('trait instances (§3.4, §11)', () => {
  test('an instance takes a partial of the schema and nothing else', () => {
    Position({ x: 1 })
    Position({ x: 1, y: 2 })
    Position()
    // @ts-expect-error — z is not a field of Position
    Position({ z: 1 })
    // @ts-expect-error — x is a number
    Position({ x: 'far' })
    // @ts-expect-error — a tag carries no value
    IsActive({ x: 1 })
  })

  test('an AoS trait adopts the reference itself', () => {
    MeshOf(new Mesh())
    // @ts-expect-error — an AoS trait takes its own instance
    MeshOf({ x: 1 })
  })

  test('a relation instance takes a target, or the wildcard', () => {
    ChildOf(entity)
    ChildOf('*')
    Likes(entity, { amount: 2 })
    // @ts-expect-error — amount is the only field
    Likes(entity, { level: 2 })
  })
})

describe('fields as values (§3.3, §11)', () => {
  test('a field is addressable and carries its value type', () => {
    expectTypeOf(world.get(entity, Position.x)).toEqualTypeOf<number>()
    expectTypeOf(world.get(entity, Stats.name)).toEqualTypeOf<string>()
    expectTypeOf(world.get(entity, Stats.alive)).toEqualTypeOf<boolean>()
    expectTypeOf(world.get(entity, Stats.owner)).toEqualTypeOf<Entity>()
    expectTypeOf(world.get(entity, Nested['pos.x'])).toEqualTypeOf<number>()
    // @ts-expect-error — Position has no z
    world.get(entity, Position.z)
  })

  test("set takes the field's own type", () => {
    world.set(entity, Position.x, 1)
    world.set(entity, Stats.name, 'hero')
    // @ts-expect-error — x is a number
    world.set(entity, Position.x, 'far')
  })
})

describe('get and set (§4.4, §11)', () => {
  test('a trait reads back as its declared shape', () => {
    expectTypeOf(world.get(entity, Position)).toEqualTypeOf<PositionSchema>()
    expectTypeOf(world.get(entity, Nested)).toEqualTypeOf<{
      pos: { x: number; y: number }
      level: number
    }>()
    expectTypeOf(world.get(entity, MeshOf)).toEqualTypeOf<Mesh>()
    expectTypeOf(world.get(entity, Position, { x: 0, y: 0 })).toEqualTypeOf<PositionSchema>()
  })

  test('a world trait resolves without an entity', () => {
    expectTypeOf(world.get(Position)).toEqualTypeOf<PositionSchema>()
    expectTypeOf(world.get(Position.x)).toEqualTypeOf<number>()
    world.set(Position, { x: 1 })
    world.set(Position.x, 1)
  })

  test('set writes a partial', () => {
    world.set(entity, Position, { x: 1 })
    world.set(entity, MeshOf, new Mesh())
    // @ts-expect-error — z is not a field
    world.set(entity, Position, { z: 1 })
  })
})

describe('entity handles (§4.1, §11)', () => {
  test('arithmetic on a handle produces a number a handle position rejects', () => {
    expectTypeOf(entity).toExtend<number>()
    expectTypeOf(entity + 1).toEqualTypeOf<number>()
    // @ts-expect-error — a number is not a handle
    world.despawn(entity + 1)
    // @ts-expect-error — nor is a literal
    world.isAlive(7)
    expectTypeOf(world.spawn()).toEqualTypeOf<Entity>()
    expectTypeOf(world.spawnMany(2, Position)).toEqualTypeOf<Float64Array>()
    expectTypeOf(world.target(entity, ChildOf)).toEqualTypeOf<Entity>()
    expectTypeOf(world.targets(entity, ChildOf)).toEqualTypeOf<Entity[]>()
    expectTypeOf(world.queryFirst(Position)).toEqualTypeOf<Entity | undefined>()
  })
})

describe('query argument extraction (§6.1, §11)', () => {
  test('Values keeps data terms in order and drops the rest', () => {
    expectTypeOf<Values<[typeof Position, typeof IsActive, typeof Velocity]>>().toEqualTypeOf<
      [Cursor<{ x: number; y: number }>, Cursor<{ x: number; y: number }>]
    >()
    expectTypeOf<
      Values<[typeof Position, ReturnType<typeof Not<typeof Velocity>>]>
    >().toEqualTypeOf<[Cursor<PositionSchema>]>()
    expectTypeOf<Values<[typeof MeshOf]>>().toEqualTypeOf<[Mesh]>()
    expectTypeOf<Values<[ReturnType<typeof Optional<typeof Position>>]>>().toEqualTypeOf<
      [Cursor<PositionSchema> | null]
    >()
  })

  test('each parameters are positional, with the entity last', () => {
    world.query(Position, IsActive, Velocity).each((p, v, e) => {
      expectTypeOf(p).toEqualTypeOf<Cursor<PositionSchema>>()
      expectTypeOf(v).toEqualTypeOf<Cursor<PositionSchema>>()
      expectTypeOf(e).toEqualTypeOf<Entity>()
      p.x = v.x + 1
    })

    world.query(Position, MeshOf, Changed(Position)).each((p, mesh, e) => {
      expectTypeOf(mesh).toEqualTypeOf<Mesh>()
      mesh.position.set(p.x, p.y, 0)
      expectTypeOf(e).toEqualTypeOf<Entity>()
    })

    world.query(Nested, Optional(Velocity), Not(IsActive), With(Position)).each((n, v, e) => {
      expectTypeOf(n.pos.x).toEqualTypeOf<number>()
      expectTypeOf(v).toEqualTypeOf<Cursor<PositionSchema> | null>()
      expectTypeOf(e).toEqualTypeOf<Entity>()
    })

    // A callback may ignore the trailing arguments it does not need.
    world.query(Position, Velocity).each((p) => p.x)
    world.query(Or(Position, Velocity), Added(Position), Removed(Velocity)).each((e) => {
      expectTypeOf(e).toEqualTypeOf<Entity>()
    })
    world.query(Cascade(ChildOf), Position).each((p, e) => {
      expectTypeOf(p).toEqualTypeOf<Cursor<PositionSchema>>()
      expectTypeOf(e).toEqualTypeOf<Entity>()
    })
    // @ts-expect-error — the first argument is a Position cursor
    world.query(Position).each((p: string) => p)
  })

  test('a relation pair contributes its data, a tag relation nothing', () => {
    world.query(Likes(entity)).each((likes, e) => {
      expectTypeOf(likes.amount).toEqualTypeOf<number>()
      expectTypeOf(e).toEqualTypeOf<Entity>()
    })
    world.query(ChildOf('*'), Position).each((p, e) => {
      expectTypeOf(p).toEqualTypeOf<Cursor<PositionSchema>>()
      expectTypeOf(e).toEqualTypeOf<Entity>()
    })
  })
})

describe('chunks (§6.6, §11)', () => {
  test('a chunk hands out the pages themselves', () => {
    for (const chunk of world.query(Position, MeshOf).chunks()) {
      expectTypeOf(chunk.length).toEqualTypeOf<number>()
      expectTypeOf(chunk.entities).toEqualTypeOf<Float64Array>()
      expectTypeOf(chunk.entity(0)).toEqualTypeOf<Entity>()
      expectTypeOf(chunk.get(Position)).toEqualTypeOf<{
        readonly x: Float32Array
        readonly y: Float32Array
      }>()
      expectTypeOf(chunk.get(Position).x).toEqualTypeOf<Float32Array>()
      expectTypeOf(chunk.get(MeshOf)).toEqualTypeOf<Mesh[]>()
      expectTypeOf(chunk.column(Position.x)).toEqualTypeOf<Float32Array>()
      expectTypeOf(chunk.column(Stats.hp)).toEqualTypeOf<Float64Array>()
      chunk.markChanged(Position)
    }
  })
})

describe('sorted queries (§6.7, §11)', () => {
  test('a sorted result keeps the tier-1 and tier-2 surface, minus chunks', () => {
    const sorted = world.query(Position, Velocity).sortBy(Position.x, 'desc')

    expectTypeOf(sorted.count).toEqualTypeOf<number>()
    expectTypeOf(sorted.first).toEqualTypeOf<Entity | undefined>()
    expectTypeOf(sorted.entities()).toEqualTypeOf<Float64Array>()
    expectTypeOf(sorted.isDirty).toEqualTypeOf<'clean' | 'resort' | 'rebuild'>()
    sorted.each((p, v, e) => {
      expectTypeOf(p).toEqualTypeOf<Cursor<PositionSchema>>()
      expectTypeOf(v).toEqualTypeOf<Cursor<PositionSchema>>()
      expectTypeOf(e).toEqualTypeOf<Entity>()
    })
    for (const e of sorted) expectTypeOf(e).toEqualTypeOf<Entity>()

    world.query(Position).sortBy((a, b) => a - b)
    // @ts-expect-error — a sorted query is materialised and has no chunks
    sorted.chunks()
  })
})

describe('observers (§8.1, §11)', () => {
  test('a handler takes a handle and, for relations, a target', () => {
    const off = world.onAdd(Position, (e, target) => {
      expectTypeOf(e).toEqualTypeOf<Entity>()
      expectTypeOf(target).toEqualTypeOf<Entity | undefined>()
    })
    expectTypeOf(off).toEqualTypeOf<() => void>()
    world.onEnter(world.query(Position), (e) => expectTypeOf(e).toEqualTypeOf<Entity>())
  })
})
