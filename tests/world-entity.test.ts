import { describe, expect, test } from 'vitest'

import { Trait, World, f32 } from '../src/index'
import type { Entity } from '../src/index'
import {
  $archetypes,
  $entities,
  $id,
  WORLD_ENTITY_ID,
  entityGeneration,
  entityId,
  entityWorld,
} from '../src/internal'

const Time = new Trait({ delta: 0, current: 0 })
const Position = new Trait({ x: f32(0), y: f32(0) })
const IsPaused = new Trait()

const archetypeOf = (world: World, e: Entity) =>
  world[$archetypes].list[world[$entities].archetypes[entityId(e)]]

describe('the world entity (§5.4)', () => {
  test('id 1 is the world entity and it is alive from construction', () => {
    const world = new World()

    expect(entityId(world.entity)).toBe(WORLD_ENTITY_ID)
    expect(entityGeneration(world.entity)).toBe(1)
    expect(entityWorld(world.entity)).toBe(world[$id])
    expect(world.isAlive(world.entity)).toBe(true)

    world.destroy()
  })

  test('user entities never take id 1', () => {
    const world = new World()

    for (let i = 0; i < 4; i++) expect(entityId(world.spawn())).toBeGreaterThan(WORLD_ENTITY_ID)

    world.destroy()
  })

  test('the world entity is an ordinary entity that moves between archetypes', () => {
    const world = new World()
    const root = archetypeOf(world, world.entity)

    world.add(Time)

    expect(archetypeOf(world, world.entity)).not.toBe(root)
    expect(archetypeOf(world, world.entity).entityAt(0)).toBe(world.entity)

    world.destroy()
  })

  test.runIf(__DEV__)('the world entity cannot be despawned', () => {
    const world = new World()

    expect(() => world.despawn(world.entity)).toThrowError(/apecs/)
    expect(world.isAlive(world.entity)).toBe(true)

    world.destroy()
  })
})

describe('world-target overloads (§5.4)', () => {
  test('a leading trait targets the world, a leading handle targets the entity', () => {
    const world = new World()
    const e = world.spawn()

    world.add(Time)

    expect(world.has(Time)).toBe(true)
    expect(world.has(world.entity, Time)).toBe(true)
    expect(world.has(e, Time)).toBe(false)

    world.add(e, Time({ delta: 1 }))

    expect(world.get(e, Time.delta)).toBe(1)
    expect(world.get(Time.delta)).toBe(0)

    world.destroy()
  })

  test('the whole data surface resolves against the world entity', () => {
    const world = new World()

    world.add(Time)
    world.set(Time, { delta: 0.016 })

    expect(world.get(Time)).toEqual({ delta: 0.016, current: 0 })
    expect(world.get(Time.delta)).toBe(0.016)

    world.set(Time.current, 4)

    expect(world.get(Time.current)).toBe(4)
    expect(world.get(world.entity, Time)).toEqual({ delta: 0.016, current: 4 })

    world.destroy()
  })

  test('get with an out parameter works against the world too', () => {
    const world = new World()
    world.add(Time({ delta: 0.5, current: 2 }))
    const out = { delta: 0, current: 0 }

    expect(world.get(Time, out)).toBe(out)
    expect(out).toEqual({ delta: 0.5, current: 2 })

    world.destroy()
  })

  test('remove targets the world when no handle is given', () => {
    const world = new World()
    world.add(Time, IsPaused)

    expect(world.has(IsPaused)).toBe(true)

    world.remove(Time, IsPaused)

    expect(world.has(Time)).toBe(false)
    expect(world.has(IsPaused)).toBe(false)

    world.destroy()
  })

  test('world traits are independent of the same trait on a user entity', () => {
    const world = new World()
    const e = world.spawn(Position({ x: 1, y: 2 }))

    world.add(Position({ x: 8, y: 9 }))

    expect(world.get(Position)).toEqual({ x: 8, y: 9 })
    expect(world.get(e, Position)).toEqual({ x: 1, y: 2 })

    world.remove(Position)

    expect(world.has(Position)).toBe(false)
    expect(world.get(e, Position.x)).toBe(1)

    world.destroy()
  })
})
