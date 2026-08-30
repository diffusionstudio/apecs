import { describe, expect, test } from 'vitest'

import { Trait, World, f32, str } from '../src/index'
import type { Entity } from '../src/index'
import {
  $archetypes,
  $bind,
  $entities,
  $id,
  $poison,
  $row,
  cursorClassFor,
  entityId,
  type Column,
} from '../src/internal'

const Position = new Trait({ x: f32(0), y: f32(0) })
const Velocity = new Trait({ x: f32(0), y: f32(0) })
const Stats = new Trait({ hp: 0, alive: false, name: str('') })
const Mesh = new Trait(() => ({ id: 0 }))
const IsActive = new Trait()

/** The generated accessors are typed in stage 7; here the shape is the point. */
type Cursor = Record<string, any> & {
  [$bind](columns: Column[], page: number): void
  [$row]: number
  [$poison](): void
}

const cursorFor = (trait: Trait, tracked = false): Cursor => new (cursorClassFor(trait, tracked)!)()

const columnsOf = (world: World, e: Entity, trait: Trait): Column[] =>
  world[$archetypes].list[world[$entities].archetypes[entityId(e)]].columnsOf.get(trait[$id])!

describe('one accessor class per trait (§6.5, §12.2)', () => {
  test('a struct trait has a cursor class; a tag and an AoS trait have none', () => {
    expect(cursorClassFor(Position, false)).not.toBeNull()
    expect(cursorClassFor(IsActive, false)).toBeNull()
    expect(cursorClassFor(Mesh, false)).toBeNull()
  })

  test('classes are built once and memoised', () => {
    expect(cursorClassFor(Position, false)).toBe(cursorClassFor(Position, false))
    expect(cursorClassFor(Position, true)).toBe(cursorClassFor(Position, true))
  })

  test('tracked and untracked are separate classes, so untracked writes pay nothing', () => {
    expect(cursorClassFor(Position, true)).not.toBe(cursorClassFor(Position, false))
  })

  test('traits with identical schemas still get their own class', () => {
    expect(cursorClassFor(Velocity, false)).not.toBe(cursorClassFor(Position, false))
  })

  test('the schema keys are prototype accessors, and nothing else is', () => {
    const proto = cursorClassFor(Stats, false)!.prototype
    const keys = Object.getOwnPropertyNames(proto).filter((key) => key !== 'constructor')

    expect(keys).toEqual(['hp', 'alive', 'name'])
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, key)!
      expect(descriptor.get).toBeTypeOf('function')
      expect(descriptor.set).toBeTypeOf('function')
    }
  })
})

describe('page binding and row advance (§6.5)', () => {
  test('a bound cursor reads the row it is parked on', () => {
    const world = new World({ pageSize: 4 })
    const entities: Entity[] = []
    for (let i = 0; i < 6; i++) entities.push(world.spawn(Position({ x: i, y: i * 2 })))

    const columns = columnsOf(world, entities[0], Position)
    const cursor = cursorFor(Position)
    cursor[$bind](columns, 0)

    for (let row = 0; row < 4; row++) {
      cursor[$row] = row
      expect(cursor.x).toBe(row)
      expect(cursor.y).toBe(row * 2)
    }

    world.destroy()
  })

  test('rebinding moves the cursor to the next page', () => {
    const world = new World({ pageSize: 4 })
    const entities: Entity[] = []
    for (let i = 0; i < 6; i++) entities.push(world.spawn(Position({ x: i })))

    const cursor = cursorFor(Position)
    cursor[$bind](columnsOf(world, entities[0], Position), 1)

    cursor[$row] = 0
    expect(cursor.x).toBe(4)
    cursor[$row] = 1
    expect(cursor.x).toBe(5)

    world.destroy()
  })

  test('a write through the cursor lands in the column page', () => {
    const world = new World({ pageSize: 4 })
    const a = world.spawn(Position({ x: 1 }))
    const b = world.spawn(Position({ x: 2 }))

    const cursor = cursorFor(Position)
    cursor[$bind](columnsOf(world, a, Position), 0)
    cursor[$row] = 1
    cursor.x = 20
    cursor.y = 21

    expect(world.get(b, Position)).toEqual({ x: 20, y: 21 })
    expect(world.get(a, Position.x)).toBe(1)

    world.destroy()
  })

  test('a bool field decodes on read and stores 0 or 1', () => {
    const world = new World()
    const e = world.spawn(Stats({ hp: 1, alive: true, name: 'a' }))
    const columns = columnsOf(world, e, Stats)

    const cursor = cursorFor(Stats)
    cursor[$bind](columns, 0)
    cursor[$row] = 0

    expect(cursor.alive).toBe(true)
    cursor.alive = false

    expect(cursor.alive).toBe(false)
    expect(columns[1].page(0)[0]).toBe(0)
    expect(world.get(e, Stats.alive)).toBe(false)

    world.destroy()
  })

  test('a boxed field passes the reference through', () => {
    const world = new World()
    const e = world.spawn(Stats({ name: 'hero' }))

    const cursor = cursorFor(Stats)
    cursor[$bind](columnsOf(world, e, Stats), 0)
    cursor[$row] = 0

    expect(cursor.name).toBe('hero')
    cursor.name = 'ghost'

    expect(world.get(e, Stats.name)).toBe('ghost')

    world.destroy()
  })
})

describe('borrowed cursors (§6.5)', () => {
  test.runIf(__DEV__)('a poisoned cursor throws on read and on write', () => {
    const world = new World()
    const e = world.spawn(Position({ x: 1 }))

    const cursor = cursorFor(Position)
    cursor[$bind](columnsOf(world, e, Position), 0)
    cursor[$row] = 0
    expect(cursor.x).toBe(1)

    cursor[$poison]()

    expect(() => cursor.x).toThrowError(/apecs/)
    expect(() => {
      cursor.x = 2
    }).toThrowError(/apecs/)

    world.destroy()
  })

  test.skipIf(__DEV__)('poisoning costs nothing in production', () => {
    const world = new World()
    const e = world.spawn(Position({ x: 1 }))

    const cursor = cursorFor(Position)
    cursor[$bind](columnsOf(world, e, Position), 0)
    cursor[$row] = 0
    cursor[$poison]()

    expect(cursor.x).toBe(1)

    world.destroy()
  })
})
