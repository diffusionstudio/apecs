import { describe, expect, test } from 'vitest'

import { Trait, World, f32 } from '../src/index'
import type { Entity } from '../src/index'

const Position = new Trait({ x: f32(0), y: f32(0) })
const Velocity = new Trait({ x: f32(0), y: f32(0) })
const Marked = new Trait()

const PAGE = 4

/** Spawns in order, so `spawned[0]` is the row the walk reaches last. */
function spawnRows(world: World, n: number): Entity[] {
  const out: Entity[] = []
  for (let i = 0; i < n; i++) out.push(world.spawn(Position({ x: i })))
  return out
}

describe.runIf(__DEV__)('dev structural guard (§9)', () => {
  test('despawning an entity the walk has not reached throws', () => {
    const world = new World()
    const spawned = spawnRows(world, 3)

    expect(() =>
      world.query(Position).each(() => {
        world.despawn(spawned[0])
      }),
    ).toThrowError(/apecs/)

    world.destroy()
  })

  test('the guard fires before anything changes', () => {
    const world = new World()
    const spawned = spawnRows(world, 3)

    expect(() =>
      world.query(Position).each(() => {
        world.despawn(spawned[0])
      }),
    ).toThrowError(/apecs/)

    expect(spawned.every((e) => world.isAlive(e))).toBe(true)
    expect(world.query(Position).count).toBe(3)

    world.destroy()
  })

  test('moving an entity the walk has not reached throws', () => {
    const world = new World()
    const spawned = spawnRows(world, 3)

    expect(() =>
      world.query(Position).each(() => {
        world.add(spawned[0], Marked)
      }),
    ).toThrowError(/apecs/)

    world.destroy()
  })

  test('the current entity may be despawned, moved out, or moved back', () => {
    const world = new World()
    spawnRows(world, 3)

    expect(() =>
      world.query(Position).each((p, entity: Entity) => {
        if (p.x === 0) world.despawn(entity)
        else if (p.x === 1) world.add(entity, Marked)
        else {
          world.add(entity, Velocity)
          world.remove(entity, Velocity)
        }
      }),
    ).not.toThrow()

    world.destroy()
  })

  test('the same change deferred is fine', () => {
    const world = new World()
    const spawned = spawnRows(world, 3)

    world.query(Position).each(() => {
      world.defer(() => {
        if (world.isAlive(spawned[0])) world.despawn(spawned[0])
      })
    })

    expect(world.isAlive(spawned[0])).toBe(false)

    world.destroy()
  })

  test('a walk over another query is not disturbed by changes to archetypes it does not cover', () => {
    const world = new World()
    spawnRows(world, 2)
    const others = [world.spawn(Velocity), world.spawn(Velocity)]

    expect(() =>
      world.query(Position).each(() => {
        world.despawn(others.pop()!)
      }),
    ).not.toThrow()

    world.destroy()
  })

  test('an inner walk that despawns below the outer cursor throws for the outer walk', () => {
    const world = new World()
    for (let i = 0; i < 3; i++) world.spawn(Position({ x: i }), Velocity)
    const inner = world.query(Position, Velocity)

    expect(() =>
      world.query(Position).each((p) => {
        // The outer's first visit is the tail row; the inner reaches the rows ahead of it.
        if (p.x === 2) inner.each((_p, _v, entity: Entity) => world.despawn(entity))
      }),
    ).toThrowError(/apecs/)

    world.destroy()
  })

  test('chunks: despawning into a page the walk has not reached throws', () => {
    const world = new World({ pageSize: PAGE })
    const spawned = spawnRows(world, PAGE + 1)

    expect(() => {
      for (const _chunk of world.query(Position).chunks()) world.despawn(spawned[0])
    }).toThrowError(/apecs/)

    world.destroy()
  })

  test('chunks: rows of the current page are the caller’s to mutate', () => {
    const world = new World({ pageSize: PAGE })
    spawnRows(world, PAGE + 1)

    expect(() => {
      for (const chunk of world.query(Position).chunks()) {
        for (let i = chunk.length - 1; i >= 0; i--) world.despawn(chunk.entity(i))
      }
    }).not.toThrow()

    expect(world.query(Position).count).toBe(0)

    world.destroy()
  })

  test('the guard does not outlive the walk', () => {
    const world = new World()
    const spawned = spawnRows(world, 3)

    world.query(Position).each(() => {})
    expect(() => world.despawn(spawned[0])).not.toThrow()

    for (const _chunk of world.query(Position).chunks()) break
    expect(() => world.despawn(spawned[1])).not.toThrow()

    world.destroy()
  })
})

describe.runIf(!__DEV__)('production omits the guard (§9, §12.2)', () => {
  test('an unsafe despawn during each does not throw', () => {
    const world = new World()
    const spawned = spawnRows(world, 3)

    expect(() =>
      world.query(Position).each(() => {
        if (world.isAlive(spawned[0])) world.despawn(spawned[0])
      }),
    ).not.toThrow()

    world.destroy()
  })
})
