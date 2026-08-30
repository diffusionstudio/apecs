import { describe, expect, test } from 'vitest'

import { Not, Trait, World, f32 } from '../src/index'
import type { Entity } from '../src/index'

const Position = new Trait({ x: f32(0), y: f32(0) })
const Velocity = new Trait({ x: f32(0), y: f32(0) })
const IsActive = new Trait()

describe('count and isEmpty (§6.3)', () => {
  test('count sums the rows of every matching archetype', () => {
    const world = new World({ pageSize: 4 })
    const query = world.query(Position)

    expect(query.count).toBe(0)
    expect(query.isEmpty).toBe(true)

    world.spawnMany(9, Position)
    world.spawnMany(5, Position, Velocity)
    world.spawn(Velocity)

    expect(query.count).toBe(14)
    expect(query.isEmpty).toBe(false)

    world.destroy()
  })

  test('count follows structural change', () => {
    const world = new World()
    const positions = world.query(Position)
    const still = world.query(Position, Not(Velocity))
    const e = world.spawn(Position)

    expect(positions.count).toBe(1)
    expect(still.count).toBe(1)

    world.add(e, Velocity)

    expect(positions.count).toBe(1)
    expect(still.count).toBe(0)

    world.remove(e, Velocity)
    world.despawn(e)

    expect(positions.count).toBe(0)
    expect(positions.isEmpty).toBe(true)

    world.destroy()
  })

  test('a tag query counts the entities carrying the tag', () => {
    const world = new World()
    world.spawnMany(3, IsActive)
    world.spawn(Position)

    expect(world.query(IsActive).count).toBe(3)

    world.destroy()
  })
})

describe('iteration (§6.4)', () => {
  test('the result is iterable and yields every match exactly once', () => {
    const world = new World({ pageSize: 4 })
    const expected = new Set<Entity>()
    for (let i = 0; i < 9; i++) expected.add(world.spawn(Position))
    for (let i = 0; i < 5; i++) expected.add(world.spawn(Position, Velocity))
    world.spawn(Velocity)

    const seen = [...world.query(Position)]

    expect(seen).toHaveLength(14)
    expect(new Set(seen)).toEqual(expected)

    world.destroy()
  })

  test('an archetype iterates back to front, which is what makes despawn safe (§9)', () => {
    const world = new World()
    const a = world.spawn(Position)
    const b = world.spawn(Position)
    const c = world.spawn(Position)

    expect([...world.query(Position)]).toEqual([c, b, a])

    world.destroy()
  })

  test('the same result iterates again from the start', () => {
    const world = new World()
    world.spawnMany(3, Position)
    const query = world.query(Position)

    expect([...query]).toEqual([...query])

    world.destroy()
  })

  test('an empty result yields nothing', () => {
    const world = new World()
    world.spawn(Velocity)

    expect([...world.query(Position)]).toEqual([])

    world.destroy()
  })

  test('first is the entity iteration starts with, and undefined when empty', () => {
    const world = new World()
    const query = world.query(Position)

    expect(query.first).toBeUndefined()

    world.spawnMany(4, Position)

    expect(query.first).toBe([...query][0])
    expect(world.isAlive(query.first!)).toBe(true)

    world.destroy()
  })
})

describe('entities() snapshots (§6.3)', () => {
  test('the snapshot is a Float64Array holding the whole result', () => {
    const world = new World({ pageSize: 4 })
    world.spawnMany(9, Position)
    world.spawnMany(2, Position, Velocity)
    const query = world.query(Position)

    const snapshot = query.entities()

    expect(snapshot).toBeInstanceOf(Float64Array)
    expect(snapshot).toHaveLength(query.count)
    expect([...snapshot]).toEqual([...query])

    world.destroy()
  })

  test('every call returns a fresh copy', () => {
    const world = new World()
    world.spawnMany(3, Position)
    const query = world.query(Position)

    const first = query.entities()
    const second = query.entities()

    expect(second).not.toBe(first)
    expect([...second]).toEqual([...first])

    world.destroy()
  })

  test('a snapshot survives the mutation it is being used to drive', () => {
    const world = new World()
    const spawned: Entity[] = []
    for (let i = 0; i < 6; i++) spawned.push(world.spawn(Position({ x: i })))
    const query = world.query(Position)

    const snapshot = query.entities()
    for (let i = 0; i < snapshot.length; i++) {
      const entity = snapshot[i] as Entity
      world.despawn(entity)
      world.spawn(Position, Velocity)
    }

    const ascending = (a: number, b: number) => a - b
    expect([...snapshot].sort(ascending)).toEqual([...spawned].sort(ascending))
    expect(spawned.every((e) => !world.isAlive(e))).toBe(true)
    expect(query.count).toBe(6)

    world.destroy()
  })

  test('an empty result snapshots an empty array', () => {
    const world = new World()

    expect(world.query(Position).entities()).toHaveLength(0)

    world.destroy()
  })
})
