import { describe, expect, test } from 'vitest'

import { Trait, World, f32 } from '../src/index'
import type { Entity } from '../src/index'
import { $archetypes, $entities, $traits, entityId } from '../src/internal'

const Position = new Trait({ x: f32(0), y: f32(0) })
const IsActive = new Trait()

const Health = new Trait({ hp: 100, shield: 0 }, { storage: 'sparse' })
const Inventory = new Trait(() => ({ items: [] as string[] }), { storage: 'sparse' })
const IsFrozen = new Trait(undefined, { storage: 'sparse' })

const archetypeOf = (world: World, e: Entity) =>
  world[$archetypes].list[world[$entities].archetypes[entityId(e)]]
const rowOf = (world: World, e: Entity) => world[$entities].rows[entityId(e)]

describe('sparse traits stay out of the archetype graph (§3.5)', () => {
  test('adding one creates no archetype and moves no row', () => {
    const world = new World()
    const e = world.spawn(Position)
    const archetype = archetypeOf(world, e)
    const row = rowOf(world, e)
    const count = world[$archetypes].list.length

    world.add(e, Health({ hp: 50 }))

    expect(world[$archetypes].list).toHaveLength(count)
    expect(archetypeOf(world, e)).toBe(archetype)
    expect(rowOf(world, e)).toBe(row)
    expect(archetype.column(Health.hp)).toBeUndefined()

    world.destroy()
  })

  test('removing one moves no row either', () => {
    const world = new World()
    const e = world.spawn(Position, Health)
    const archetype = archetypeOf(world, e)
    const row = rowOf(world, e)

    world.remove(e, Health)

    expect(world.has(e, Health)).toBe(false)
    expect(archetypeOf(world, e)).toBe(archetype)
    expect(rowOf(world, e)).toBe(row)

    world.destroy()
  })

  test('a sparse tag behaves the same way', () => {
    const world = new World()
    const e = world.spawn(Position)
    const archetype = archetypeOf(world, e)

    world.add(e, IsFrozen)

    expect(world.has(e, IsFrozen)).toBe(true)
    expect(archetypeOf(world, e)).toBe(archetype)

    world.remove(e, IsFrozen)

    expect(world.has(e, IsFrozen)).toBe(false)
    expect(archetypeOf(world, e)).toBe(archetype)

    world.destroy()
  })

  test('entities with and without the trait share one archetype', () => {
    const world = new World()
    const with_ = world.spawn(Position, Health)
    const without = world.spawn(Position)

    expect(archetypeOf(world, with_)).toBe(archetypeOf(world, without))
    expect(world.has(with_, Health)).toBe(true)
    expect(world.has(without, Health)).toBe(false)

    world.destroy()
  })

  test('a sparse trait still registers so it can be named in a mask-free way', () => {
    const world = new World()

    world.spawn(Health)

    expect(world[$traits].localId(Health)).toBeGreaterThanOrEqual(0)

    world.destroy()
  })
})

describe('sparse values use the same API (§3.5, §4.4)', () => {
  test('defaults, get, set and field access all behave as they do for table traits', () => {
    const world = new World()
    const e = world.spawn(Health)

    expect(world.get(e, Health)).toEqual({ hp: 100, shield: 0 })

    world.set(e, Health, { hp: 40 })
    expect(world.get(e, Health)).toEqual({ hp: 40, shield: 0 })

    world.set(e, Health.shield, 5)
    expect(world.get(e, Health.shield)).toBe(5)

    const out = { hp: 0, shield: 0 }
    expect(world.get(e, Health, out)).toBe(out)
    expect(out).toEqual({ hp: 40, shield: 5 })

    world.destroy()
  })

  test('an AoS sparse trait calls its factory once per entity', () => {
    const world = new World()
    const a = world.spawn(Inventory)
    const b = world.spawn(Inventory)

    world.get(a, Inventory).items.push('sword')

    expect(world.get(b, Inventory).items).toEqual([])
    expect(world.get(a, Inventory)).not.toBe(world.get(b, Inventory))

    world.destroy()
  })

  test('values are per entity and survive a table transition', () => {
    const world = new World()
    const a = world.spawn(Position, Health({ hp: 10 }))
    const b = world.spawn(Position, Health({ hp: 20 }))

    world.add(a, IsActive)

    expect(world.get(a, Health.hp)).toBe(10)
    expect(world.get(b, Health.hp)).toBe(20)

    world.destroy()
  })

  test('a swap-remove in the archetype leaves sparse values with their owners', () => {
    const world = new World({ pageSize: 8 })
    const entities: Entity[] = []
    for (let i = 0; i < 6; i++) entities.push(world.spawn(Position, Health({ hp: i })))

    world.despawn(entities[0])
    world.despawn(entities[2])

    for (const i of [1, 3, 4, 5]) expect(world.get(entities[i], Health.hp)).toBe(i)

    world.destroy()
  })

  test('re-adding after a remove starts from the defaults again', () => {
    const world = new World()
    const e = world.spawn(Health({ hp: 1 }))

    world.remove(e, Health)
    world.add(e, Health)

    expect(world.get(e, Health)).toEqual({ hp: 100, shield: 0 })

    world.destroy()
  })

  test('two sparse traits on one entity stay independent', () => {
    const world = new World()
    const e = world.spawn(Health({ hp: 3 }), IsFrozen)

    world.remove(e, IsFrozen)

    expect(world.has(e, IsFrozen)).toBe(false)
    expect(world.get(e, Health.hp)).toBe(3)

    world.destroy()
  })
})

describe('sparse traits and the entity lifecycle (§3.5, §4.2)', () => {
  test('despawn releases the sparse entry so a recycled id starts clean', () => {
    const world = new World()
    const before = world.spawn(Health({ hp: 7 }))

    world.despawn(before)
    const after = world.spawn()

    expect(entityId(after)).toBe(entityId(before))
    expect(world.has(after, Health)).toBe(false)

    world.destroy()
  })

  test('bulk operations reach sparse traits too', () => {
    const world = new World()
    const batch = Array.from(world.spawnMany(10, Position)) as Entity[]

    world.addMany(batch, Health({ hp: 30 }))

    for (const e of batch) expect(world.get(e, Health.hp)).toBe(30)

    world.removeMany(batch, Health)

    for (const e of batch) expect(world.has(e, Health)).toBe(false)

    world.destroy()
  })

  test.runIf(__DEV__)('reading an absent sparse trait throws', () => {
    const world = new World()
    const e = world.spawn(Position)

    expect(() => world.get(e, Health)).toThrowError(/apecs/)
    expect(() => world.set(e, Health.hp, 1)).toThrowError(/apecs/)

    world.destroy()
  })
})
