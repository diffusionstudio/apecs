import { describe, expect, test } from 'vitest'

import { Trait, World, f32 } from '../src/index'
import type { Entity } from '../src/index'
import {
  $entities,
  $id,
  $options,
  MAX_WORLDS,
  MAX_WORLD_ID,
  PAGE_SIZE,
  entityWorld,
} from '../src/internal'

const Position = new Trait({ x: f32(0), y: f32(0) })

describe('construction (§5.1)', () => {
  test('a world with no options takes the documented defaults', () => {
    const world = new World()

    expect(world[$options].pageSize).toBe(PAGE_SIZE)
    expect(world[$options].maxEntities).toBe(1 << 20)

    world.destroy()
  })

  test('options are read off the argument', () => {
    const world = new World({ pageSize: 8192, maxEntities: 64 })

    expect(world[$options].pageSize).toBe(8192)
    expect(world[$options].maxEntities).toBe(64)

    world.destroy()
  })

  test('maxEntities pre-sizes the entity index rather than capping it', () => {
    const world = new World({ maxEntities: 4 })

    expect(world[$entities].capacity).toBe(4)
    for (let i = 0; i < 16; i++) world.spawn()
    expect(world[$entities].capacity).toBeGreaterThanOrEqual(18)

    world.destroy()
  })

  test.runIf(__DEV__)('dev rejects a page size that is not a power of two', () => {
    expect(() => new World({ pageSize: 100 })).toThrowError(/apecs/)
    expect(() => new World({ pageSize: 0 })).toThrowError(/apecs/)
  })
})

describe('world ids (§4.1, §5.5)', () => {
  test('live worlds hold distinct ids inside the 8-bit field', () => {
    const a = new World()
    const b = new World()

    expect(a[$id]).not.toBe(b[$id])
    for (const world of [a, b]) {
      expect(Number.isInteger(world[$id])).toBe(true)
      expect(world[$id]).toBeGreaterThanOrEqual(0)
      expect(world[$id]).toBeLessThanOrEqual(MAX_WORLD_ID)
    }

    a.destroy()
    b.destroy()
  })

  test('the world id is packed into every handle the world mints', () => {
    const world = new World()

    expect(entityWorld(world.entity)).toBe(world[$id])
    expect(entityWorld(world.spawn())).toBe(world[$id])

    world.destroy()
  })

  test('destroy releases the id, so create/destroy cycles never exhaust the pool', () => {
    const seen = new Set<number>()

    for (let i = 0; i < MAX_WORLDS * 2; i++) {
      const world = new World()
      seen.add(world[$id])
      world.destroy()
    }

    expect(seen.size).toBeLessThanOrEqual(MAX_WORLDS)
    expect(seen.size).toBeGreaterThan(0)
  })
})

describe('inheritance (§5.2)', () => {
  const METHODS = [
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
    'destroy',
  ] as const

  test('every world method lives on the prototype, not on the instance', () => {
    const world = new World()

    for (const name of METHODS) {
      expect(typeof World.prototype[name]).toBe('function')
      expect(Object.hasOwn(world, name)).toBe(false)
    }

    world.destroy()
  })

  test('a subclass can override a world method and call through to it', () => {
    const seen: Entity[] = []
    class Logged extends World {
      public override despawn(e: Entity): void {
        seen.push(e)
        super.despawn(e)
      }
    }
    const world = new Logged()

    const e = world.spawn()
    world.despawn(e)

    expect(seen).toEqual([e])
    expect(world.isAlive(e)).toBe(false)

    world.destroy()
  })

  test('a subclass may use world methods once super() has returned', () => {
    class GameWorld extends World {
      readonly player: Entity

      public constructor() {
        super({ pageSize: 16 })
        this.player = this.spawn(Position({ x: 3 }))
      }
    }
    const world = new GameWorld()

    expect(world[$options].pageSize).toBe(16)
    expect(world.isAlive(world.player)).toBe(true)
    expect(world.get(world.player, Position.x)).toBe(3)

    world.destroy()
  })

  test('`this` is unusable until super() returns', () => {
    class Early extends World {
      public constructor() {
        // @ts-expect-error `this` is in TDZ before super() — the rule in §5.2
        this.spawn()
        super()
      }
    }

    expect(() => new Early()).toThrow(ReferenceError)
  })

  test('subclass fields never collide with world internals', () => {
    class Shadowed extends World {
      entities = 'mine'
      archetypes = 'mine'
      traits = 'mine'
      options = 'mine'
      id = 'mine'
    }
    const world = new Shadowed()

    const e = world.spawn(Position({ x: 1, y: 2 }))

    expect(world.get(e, Position)).toEqual({ x: 1, y: 2 })
    expect(world[$options].pageSize).toBe(PAGE_SIZE)
    expect(world.entities).toBe('mine')
    expect(world.id).toBe('mine')

    world.destroy()
  })
})
