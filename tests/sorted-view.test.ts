import { describe, expect, test } from 'vitest'

import { Changed, Optional, Trait, With, World, f32, str } from '../src/index'
import type { Entity } from '../src/index'
import { $archetypes, $options, $view } from '../src/internal'
import { columnOf } from './support/columns'

const Position = new Trait({ x: f32(0), y: f32(0) })
const SortIndex = new Trait({ value: 0 })
const Name = new Trait({ text: str('') })
const IsActive = new Trait()

function keysOf(world: World, entities: Iterable<number>): number[] {
  return Array.from(entities, (e) => world.get(e as Entity, SortIndex.value) as number)
}

describe('sortBy memoisation (§6.7)', () => {
  test('the same (signature, field, direction) returns the identical object', () => {
    const world = new World()
    const sorted = world.query(Position, SortIndex).sortBy(SortIndex.value)

    expect(world.query(Position, SortIndex).sortBy(SortIndex.value)).toBe(sorted)
    expect(world.query(Position, SortIndex).sortBy(SortIndex.value, 'asc')).toBe(sorted)
    expect(world.createQuery(Position, SortIndex).sortBy(SortIndex.value)).toBe(sorted)

    world.destroy()
  })

  test('direction, field and signature each key a distinct view', () => {
    const world = new World()
    const query = world.query(Position, SortIndex)
    const asc = query.sortBy(SortIndex.value)

    expect(query.sortBy(SortIndex.value, 'desc')).not.toBe(asc)
    expect(query.sortBy(SortIndex.value, 'desc')).toBe(query.sortBy(SortIndex.value, 'desc'))
    expect(query.sortBy(Position.x)).not.toBe(asc)
    expect(world.query(SortIndex, Position).sortBy(SortIndex.value)).not.toBe(asc)

    world.destroy()
  })

  test('a comparator is memoised by identity', () => {
    const world = new World()
    const query = world.query(SortIndex)
    const cmp = (a: Entity, b: Entity) =>
      world.get(a, SortIndex.value) - world.get(b, SortIndex.value)

    expect(query.sortBy(cmp)).toBe(query.sortBy(cmp))
    expect(query.sortBy((a, b) => cmp(a, b))).not.toBe(query.sortBy(cmp))

    world.destroy()
  })

  test('the sorted view is a distinct result and the unsorted query is unaffected', () => {
    const world = new World()
    world.spawn(SortIndex({ value: 3 }))
    world.spawn(SortIndex({ value: 1 }))
    world.spawn(SortIndex({ value: 2 }))
    const query = world.query(SortIndex)
    const before = [...query]

    const sorted = query.sortBy(SortIndex.value)

    expect(sorted).not.toBe(query)
    expect([...query]).toEqual(before)
    expect(keysOf(world, sorted)).toEqual([1, 2, 3])
    expect([...query]).toEqual(before)
    expect(query.count).toBe(3)

    world.destroy()
  })

  test('dispose drops the view from the cache and from the archetypes', () => {
    const world = new World()
    world.spawn(SortIndex)
    const query = world.query(SortIndex)
    const sorted = query.sortBy(SortIndex.value)
    expect([...sorted]).toHaveLength(1)
    const archetype = query[$archetypes][0]
    expect(archetype.sortedViews).toContain(sorted[$view])

    sorted.dispose()

    expect(archetype.sortedViews).not.toContain(sorted[$view])
    expect(query.sortBy(SortIndex.value)).not.toBe(sorted)

    world.destroy()
  })
})

describe('sorted access tiers (§6.3, §6.7)', () => {
  test('Tier 1 yields the entities in key order', () => {
    const world = new World({ pageSize: 4 })
    const values = [9, 2, 7, 4, 5, 6, 3, 8, 1]
    for (const value of values) world.spawn(Position, SortIndex({ value }))
    const sorted = world.query(Position, SortIndex).sortBy(SortIndex.value)

    expect(keysOf(world, sorted)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(keysOf(world, world.query(Position, SortIndex).sortBy(SortIndex.value, 'desc'))).toEqual(
      [9, 8, 7, 6, 5, 4, 3, 2, 1],
    )

    world.destroy()
  })

  test('count, isEmpty and first follow the sorted order', () => {
    const world = new World()
    const sorted = world.query(SortIndex).sortBy(SortIndex.value, 'desc')
    expect(sorted.count).toBe(0)
    expect(sorted.isEmpty).toBe(true)
    expect(sorted.first).toBeUndefined()

    world.spawn(SortIndex({ value: 1 }))
    const top = world.spawn(SortIndex({ value: 5 }))
    world.spawn(SortIndex({ value: 3 }))

    expect(sorted.count).toBe(3)
    expect(sorted.isEmpty).toBe(false)
    expect(sorted.first).toBe(top)

    world.destroy()
  })

  test('entities() is an ordered snapshot copy', () => {
    const world = new World()
    const b = world.spawn(SortIndex({ value: 2 }))
    const a = world.spawn(SortIndex({ value: 1 }))
    const sorted = world.query(SortIndex).sortBy(SortIndex.value)

    const snapshot = sorted.entities()
    expect(snapshot).toBeInstanceOf(Float64Array)
    expect(Array.from(snapshot)).toEqual([a, b])
    expect(sorted.entities()).not.toBe(snapshot)

    snapshot[0] = 0
    expect(Array.from(sorted.entities())).toEqual([a, b])

    world.destroy()
  })

  test('each receives the same arguments as the unsorted query, in key order', () => {
    const world = new World({ pageSize: 2 })
    for (const value of [5, 3, 4, 1, 2])
      world.spawn(Position({ x: value * 10 }), SortIndex({ value }))
    const sorted = world.query(Position, SortIndex).sortBy(SortIndex.value)

    const seen: Array<[number, number, Entity]> = []
    sorted.each((p, s, entity: Entity) => seen.push([p.x, s.value, entity]))

    expect(seen.map(([x]) => x)).toEqual([10, 20, 30, 40, 50])
    expect(seen.map(([, value]) => value)).toEqual([1, 2, 3, 4, 5])
    expect(seen.map(([, , e]) => e)).toEqual([...sorted])

    world.destroy()
  })

  test('each spans archetypes and pages in one ordered walk', () => {
    const world = new World({ pageSize: 2 })
    for (let value = 0; value < 6; value++) {
      if (value % 2 === 0) world.spawn(SortIndex({ value }), IsActive)
      else world.spawn(SortIndex({ value }), Position)
    }
    const sorted = world.query(SortIndex).sortBy(SortIndex.value, 'desc')

    const seen: number[] = []
    sorted.each((s) => seen.push(s.value))

    expect(seen).toEqual([5, 4, 3, 2, 1, 0])

    world.destroy()
  })

  test('each writes through the cursor and yields Optional as cursor-or-null', () => {
    const world = new World()
    const bare = world.spawn(SortIndex({ value: 2 }))
    const withPosition = world.spawn(SortIndex({ value: 1 }), Position({ x: 4 }))
    const sorted = world.query(SortIndex, Optional(Position)).sortBy(SortIndex.value)

    const seen: Array<number | null> = []
    sorted.each((s, p) => {
      seen.push(p === null ? null : p.x)
      s.value += 10
    })

    expect(seen).toEqual([4, null])
    expect(world.get(withPosition, SortIndex.value)).toBe(11)
    expect(world.get(bare, SortIndex.value)).toBe(12)

    world.destroy()
  })

  test('tick filters apply to a sorted each', () => {
    const world = new World()
    const e1 = world.spawn(SortIndex({ value: 1 }))
    const e3 = world.spawn(SortIndex({ value: 3 }))
    const e2 = world.spawn(SortIndex({ value: 2 }))
    const sorted = world.query(SortIndex, Changed(SortIndex)).sortBy(SortIndex.value)

    const first: Entity[] = []
    sorted.each((_s, entity: Entity) => first.push(entity))
    expect(first).toEqual([e1, e2, e3])

    world.step()
    world.set(e3, SortIndex.value, 0)
    world.set(e2, SortIndex.value, 5)
    const second: Entity[] = []
    sorted.each((_s, entity: Entity) => second.push(entity))
    expect(second).toEqual([e3, e2])

    world.destroy()
  })

  test('chunks is rejected — a sorted result is materialised', () => {
    const world = new World()
    world.spawn(SortIndex)
    const sorted = world.query(SortIndex).sortBy(SortIndex.value)

    expect(() => (sorted as unknown as { chunks(): unknown }).chunks()).toThrowError(/apecs/)

    world.destroy()
  })
})

describe('sorting marks the trait tracked (§6.7, §8.3)', () => {
  test('sortBy promotes the key trait and backfills its tick columns', () => {
    const Lazy = new Trait({ value: 0 })
    const world = new World()
    const e = world.spawn(Lazy)
    expect(Lazy[$options].track).toBe(false)
    expect(columnOf(world, e, Lazy.value).ticks).toBeNull()

    world.query(Lazy).sortBy(Lazy.value)

    expect(Lazy[$options].track).toBe(true)
    expect(columnOf(world, e, Lazy.value).ticks).not.toBeNull()

    world.destroy()
  })

  test('a query created before the promotion stamps ticks through its cursors', () => {
    const Lazy = new Trait({ value: 0 })
    const world = new World()
    const e = world.spawn(Lazy)
    const query = world.query(Lazy)
    query.each(() => {})

    query.sortBy(Lazy.value)
    world.step()
    query.each((l) => {
      l.value = 7
    })

    expect(columnOf(world, e, Lazy.value).lastWriteTick).toBe(world.tick)

    world.destroy()
  })
})

describe('the key trait need not be a query term (§6.7)', () => {
  test('the view covers the query narrowed to entities that carry the key trait', () => {
    const world = new World()
    world.spawn(Position({ x: 1 }))
    const b = world.spawn(Position({ x: 2 }), SortIndex({ value: 2 }))
    const a = world.spawn(Position({ x: 3 }), SortIndex({ value: 1 }))
    const query = world.query(Position)

    const sorted = query.sortBy(SortIndex.value)

    expect([...sorted]).toEqual([a, b])
    expect(sorted.count).toBe(2)
    expect(query.count).toBe(3)

    const seen: number[] = []
    sorted.each((p) => seen.push(p.x))
    expect(seen).toEqual([3, 2])

    world.destroy()
  })

  test('a With() term already satisfies the narrowing', () => {
    const world = new World()
    const query = world.query(Position, With(SortIndex))

    expect(query.sortBy(SortIndex.value)[$view].archetypes).toBe(query[$archetypes])

    world.destroy()
  })
})

describe.runIf(__DEV__)('dev rejects keys that cannot be extracted (§6.7)', () => {
  test('a non-numeric field', () => {
    const world = new World()

    expect(() => world.query(Name).sortBy(Name.text)).toThrowError(/apecs/)

    world.destroy()
  })
})
