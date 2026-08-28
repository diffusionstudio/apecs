import { describe, expect, test } from 'vitest'

import { Trait, World, f32 } from '../src/index'
import type { Entity } from '../src/index'
import { $archetypes, $entities, $traits, entityId, maskHas } from '../src/internal'

const Position = new Trait({ x: f32(0), y: f32(0) })
const Velocity = new Trait({ x: f32(0), y: f32(0) })
const IsActive = new Trait()

const archetypeOf = (world: World, e: Entity) =>
  world[$archetypes].list[world[$entities].archetypes[entityId(e)]]
const rowOf = (world: World, e: Entity) => world[$entities].rows[entityId(e)]
const localOf = (world: World, trait: Trait) => world[$traits].localId(trait)

describe('the graph (§10.1)', () => {
  test('a fresh world holds only the root archetype, with the world entity in it', () => {
    const world = new World()
    const { root, list } = world[$archetypes]

    expect(list).toHaveLength(1)
    expect(list[0]).toBe(root)
    expect(root.id).toBe(0)
    expect(root.mask.every((block) => block === 0)).toBe(true)
    expect(root.rows).toBe(1)
    expect(root.entityAt(0)).toBe(world.entity)

    world.destroy()
  })

  test('edges are created lazily, on first traversal', () => {
    const world = new World()
    const { root } = world[$archetypes]
    const e = world.spawn()

    expect(root.add.size).toBe(0)

    world.add(e, Position)
    const withPosition = archetypeOf(world, e)

    expect(root.add.size).toBe(1)
    expect(root.add.get(localOf(world, Position))).toBe(withPosition)
    expect(withPosition.remove.get(localOf(world, Position))).toBe(root)

    world.destroy()
  })

  test('edges are cached, so a repeated add/remove pattern reuses the archetypes', () => {
    const world = new World()
    const { root } = world[$archetypes]
    const e = world.spawn()

    world.add(e, Position)
    const withPosition = archetypeOf(world, e)
    world.remove(e, Position)

    expect(archetypeOf(world, e)).toBe(root)

    world.add(e, Position)

    expect(archetypeOf(world, e)).toBe(withPosition)
    expect(world[$archetypes].list).toHaveLength(2)
    expect(root.add.size).toBe(1)
    expect(withPosition.remove.size).toBe(1)

    world.destroy()
  })

  test('the trait set determines the archetype, not the order it was built in', () => {
    const world = new World()
    const a = world.spawn()
    const b = world.spawn()

    world.add(a, Position)
    world.add(a, Velocity)
    world.add(b, Velocity)
    world.add(b, Position)

    expect(archetypeOf(world, b)).toBe(archetypeOf(world, a))
    // root, {P}, {P,V}, and the {V} way-point the second entity walked through.
    expect(world[$archetypes].list).toHaveLength(4)

    world.destroy()
  })

  test('spawning with the same trait set lands in the same archetype', () => {
    const world = new World()

    const a = world.spawn(Position, Velocity)
    const b = world.spawn(Velocity, Position)

    expect(archetypeOf(world, b)).toBe(archetypeOf(world, a))

    world.destroy()
  })

  test('a mask carries exactly the bits of the traits present', () => {
    const world = new World()
    world.spawn(Velocity)

    const { mask } = archetypeOf(world, world.spawn(Position, IsActive))

    expect(maskHas(mask, localOf(world, Position))).toBe(true)
    expect(maskHas(mask, localOf(world, IsActive))).toBe(true)
    expect(maskHas(mask, localOf(world, Velocity))).toBe(false)

    world.destroy()
  })

  test('an archetype id indexes both the graph and the entity index', () => {
    const world = new World()
    const e = world.spawn(Position)
    const archetype = archetypeOf(world, e)

    expect(world[$archetypes].list[archetype.id]).toBe(archetype)
    expect(world[$entities].archetypes[entityId(e)]).toBe(archetype.id)

    world.destroy()
  })
})

describe('row moves (§10.2)', () => {
  test('a transition appends to the destination and carries the data across', () => {
    const world = new World({ pageSize: 8 })
    const e = world.spawn(Position({ x: 5, y: 6 }))
    const source = archetypeOf(world, e)

    world.add(e, Velocity({ x: 1 }))
    const destination = archetypeOf(world, e)

    expect(destination).not.toBe(source)
    expect(source.rows).toBe(0)
    expect(destination.rows).toBe(1)
    expect(rowOf(world, e)).toBe(0)
    expect(world.get(e, Position)).toEqual({ x: 5, y: 6 })
    expect(destination.entityAt(0)).toBe(e)

    world.destroy()
  })

  test('a departing row is swap-removed with the last row, which is re-indexed', () => {
    const world = new World({ pageSize: 8 })
    const a = world.spawn(Position({ x: 1 }))
    const b = world.spawn(Position({ x: 2 }))
    const c = world.spawn(Position({ x: 3 }))
    const source = archetypeOf(world, a)

    expect([rowOf(world, a), rowOf(world, b), rowOf(world, c)]).toEqual([0, 1, 2])

    world.add(a, IsActive)

    expect(source.rows).toBe(2)
    expect(rowOf(world, c)).toBe(0)
    expect(rowOf(world, b)).toBe(1)
    expect(source.entityAt(0)).toBe(c)
    expect(world.get(c, Position.x)).toBe(3)
    expect(world.get(b, Position.x)).toBe(2)
    expect(world.get(a, Position.x)).toBe(1)

    world.destroy()
  })

  test('removing the last row moves nothing', () => {
    const world = new World({ pageSize: 8 })
    const a = world.spawn(Position({ x: 1 }))
    const b = world.spawn(Position({ x: 2 }))
    const source = archetypeOf(world, a)

    world.add(b, IsActive)

    expect(source.rows).toBe(1)
    expect(rowOf(world, a)).toBe(0)
    expect(source.entityAt(0)).toBe(a)

    world.destroy()
  })

  test('despawn frees the row for the next spawn', () => {
    const world = new World({ pageSize: 8 })
    const a = world.spawn(Position({ x: 1 }))
    const b = world.spawn(Position({ x: 2 }))
    const archetype = archetypeOf(world, a)

    world.despawn(a)

    expect(archetype.rows).toBe(1)
    expect(rowOf(world, b)).toBe(0)

    const c = world.spawn(Position({ x: 3 }))

    expect(rowOf(world, c)).toBe(1)
    expect(archetype.rows).toBe(2)
    expect(world.get(b, Position.x)).toBe(2)

    world.destroy()
  })
})

describe('paging (§10.2)', () => {
  test('columns page at the world page size and never reallocate an existing page', () => {
    const world = new World({ pageSize: 8 })
    const first = world.spawn(Position)
    const column = archetypeOf(world, first).column(Position.x)!

    expect(column.pageSize).toBe(8)

    for (let i = 1; i < 8; i++) world.spawn(Position)
    expect(column.pages).toHaveLength(1)
    const page = column.pages[0]

    world.spawn(Position)

    expect(column.pages).toHaveLength(2)
    expect(column.pages[0]).toBe(page)

    world.destroy()
  })

  test('entity handles page alongside the data columns', () => {
    const world = new World({ pageSize: 4 })
    const spawned: Entity[] = []
    for (let i = 0; i < 9; i++) spawned.push(world.spawn(Position({ x: i })))
    const archetype = archetypeOf(world, spawned[0])

    expect(archetype.rows).toBe(9)
    for (let row = 0; row < 9; row++) {
      expect(archetype.entityAt(row)).toBe(spawned[row])
      expect(world.get(spawned[row], Position.x)).toBe(row)
    }

    world.destroy()
  })

  test('a tag-only archetype stores rows but no columns', () => {
    const world = new World()
    const e = world.spawn(IsActive)
    const archetype = archetypeOf(world, e)

    expect(archetype.columns).toHaveLength(0)
    expect(archetype.rows).toBe(1)
    expect(archetype.entityAt(0)).toBe(e)

    world.destroy()
  })
})
