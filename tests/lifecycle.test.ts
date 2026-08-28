import { describe, expect, test } from 'vitest'

import { Trait, World, f32 } from '../src/index'
import type { Entity } from '../src/index'
import {
  $id,
  FIRST_ENTITY_ID,
  GENERATION_COUNT,
  MAX_GENERATION,
  NULL_ENTITY,
  entityGeneration,
  entityId,
  entityWorld,
} from '../src/internal'

const Position = new Trait({ x: f32(0), y: f32(0) })
const Velocity = new Trait({ x: f32(0), y: f32(0) })
const IsActive = new Trait()

describe('spawn (§4.1, §4.2)', () => {
  test('the first user entity is id 2, generation 1, stamped with the world', () => {
    const world = new World()

    const e = world.spawn()

    expect(entityId(e)).toBe(FIRST_ENTITY_ID)
    expect(entityGeneration(e)).toBe(1)
    expect(entityWorld(e)).toBe(world[$id])
    expect(world.isAlive(e)).toBe(true)

    world.destroy()
  })

  test('fresh ids ascend while nothing has been recycled', () => {
    const world = new World()

    const ids = [world.spawn(), world.spawn(), world.spawn()].map(entityId)

    expect(ids).toEqual([FIRST_ENTITY_ID, FIRST_ENTITY_ID + 1, FIRST_ENTITY_ID + 2])

    world.destroy()
  })

  test('spawn takes instances, bare traits and tags in one call', () => {
    const world = new World()

    const e = world.spawn(Position({ x: 20 }), Velocity, IsActive)

    expect(world.get(e, Position)).toEqual({ x: 20, y: 0 })
    expect(world.get(e, Velocity)).toEqual({ x: 0, y: 0 })
    expect(world.has(e, IsActive)).toBe(true)

    world.destroy()
  })

  test('spawn with no traits still yields a live entity', () => {
    const world = new World()

    const e = world.spawn()

    expect(world.isAlive(e)).toBe(true)
    expect(world.has(e, Position)).toBe(false)

    world.destroy()
  })
})

describe('despawn (§4.2)', () => {
  test('despawn takes effect immediately', () => {
    const world = new World()
    const e = world.spawn(Position)

    world.despawn(e)

    expect(world.isAlive(e)).toBe(false)

    world.destroy()
  })

  test('a stale handle fails the liveness check instead of aliasing', () => {
    const world = new World()
    const stale = world.spawn(Position({ x: 1 }))

    world.despawn(stale)
    const fresh = world.spawn(Position({ x: 2 }))

    expect(entityId(fresh)).toBe(entityId(stale))
    expect(world.isAlive(stale)).toBe(false)
    expect(world.isAlive(fresh)).toBe(true)

    world.destroy()
  })

  test('NULL_ENTITY is never alive', () => {
    const world = new World()

    expect(world.isAlive(NULL_ENTITY)).toBe(false)

    world.destroy()
  })

  test.runIf(__DEV__)('dev rejects operations on a dead handle', () => {
    const world = new World()
    const e = world.spawn(Position)
    world.despawn(e)

    expect(() => world.despawn(e)).toThrowError(/apecs/)
    expect(() => world.add(e, Velocity)).toThrowError(/apecs/)
    expect(() => world.get(e, Position)).toThrowError(/apecs/)

    world.destroy()
  })
})

describe('id recycling (§4.2)', () => {
  test('ids recycle FIFO, so a freed id is not immediately reissued', () => {
    const world = new World()
    const first = world.spawn()
    const second = world.spawn()
    const third = world.spawn()

    world.despawn(first)
    world.despawn(second)
    world.despawn(third)

    expect(entityId(world.spawn())).toBe(entityId(first))
    expect(entityId(world.spawn())).toBe(entityId(second))
    expect(entityId(world.spawn())).toBe(entityId(third))

    world.destroy()
  })

  test('fresh ids are minted only once the recycle queue is empty', () => {
    const world = new World()
    const e = world.spawn()
    world.despawn(e)

    const recycled = world.spawn()
    const minted = world.spawn()

    expect(entityId(recycled)).toBe(entityId(e))
    expect(entityId(minted)).toBe(entityId(e) + 1)

    world.destroy()
  })

  test('a recycled id comes back with a bumped generation', () => {
    const world = new World()
    const before = world.spawn()

    world.despawn(before)
    const after = world.spawn()

    expect(entityId(after)).toBe(entityId(before))
    expect(entityGeneration(after)).toBe(entityGeneration(before) + 1)
    expect(after).not.toBe(before)

    world.destroy()
  })

  test('an id is retired rather than reused once its generation wraps', () => {
    const world = new World()
    let e = world.spawn()
    const id = entityId(e)

    for (let i = 0; i < GENERATION_COUNT && entityGeneration(e) < MAX_GENERATION; i++) {
      world.despawn(e)
      e = world.spawn()
    }

    expect(entityId(e)).toBe(id)
    expect(entityGeneration(e)).toBe(MAX_GENERATION)

    world.despawn(e)
    const next = world.spawn()

    expect(entityId(next)).toBe(id + 1)
    expect(world.isAlive(e)).toBe(false)
    expect(world.isAlive(next)).toBe(true)

    world.destroy()
  })
})

describe('foreign handles (§4.1)', () => {
  test('a handle whose world field is not ours is never alive', () => {
    const a = new World()
    const b = new World()
    const e = a.spawn()
    // Same id and generation in `b`; only the world field separates the handles.
    const twin = b.spawn()

    expect(entityId(twin)).toBe(entityId(e))
    expect(entityGeneration(twin)).toBe(entityGeneration(e))
    expect(a.isAlive(e)).toBe(true)
    expect(b.isAlive(e)).toBe(false)
    expect(a.isAlive(twin)).toBe(false)

    a.destroy()
    b.destroy()
  })

  test.runIf(__DEV__)('dev rejects a foreign handle instead of corrupting a row', () => {
    const a = new World()
    const b = new World()
    const e = a.spawn(Position({ x: 1 }))
    b.spawn(Position({ x: 2 }))

    expect(() => b.despawn(e)).toThrowError(/apecs/)
    expect(() => b.get(e, Position)).toThrowError(/apecs/)
    expect(() => b.add(e, IsActive)).toThrowError(/apecs/)

    expect(a.get(e, Position.x)).toBe(1)

    a.destroy()
    b.destroy()
  })
})

describe('lifecycle and storage together (§4.2, §10.2)', () => {
  test('a recycled entity starts from the defaults, not the previous occupant data', () => {
    const world = new World()
    const before = world.spawn(Position({ x: 7, y: 8 }))

    world.despawn(before)
    const after = world.spawn(Position)

    expect(entityId(after)).toBe(entityId(before))
    expect(world.get(after, Position)).toEqual({ x: 0, y: 0 })

    world.destroy()
  })

  test('despawning mid-batch leaves every survivor readable', () => {
    const world = new World({ pageSize: 4 })
    const spawned: Entity[] = []
    for (let i = 0; i < 10; i++) spawned.push(world.spawn(Position({ x: i })))

    for (let i = 0; i < 10; i += 2) world.despawn(spawned[i])

    for (let i = 1; i < 10; i += 2) {
      expect(world.isAlive(spawned[i])).toBe(true)
      expect(world.get(spawned[i], Position.x)).toBe(i)
    }
    for (let i = 0; i < 10; i += 2) expect(world.isAlive(spawned[i])).toBe(false)

    world.destroy()
  })
})
