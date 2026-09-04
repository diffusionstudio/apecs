/**
 * SPEC §6.7 — sorted queries: memoisation, the two dirty levels, stability,
 * and the escape hatches. Public API only.
 */
import { afterEach, describe, expect, test } from 'vitest'

import { Trait, World, f32 } from '../../src/index'
import type { Entity, SortedQueryResult } from '../../src/index'

const Position = new Trait({ x: f32(0), y: f32(0) })
const SortIndex = new Trait({ value: 0 })
const IsActive = new Trait()

const worlds: World[] = []

function makeWorld(options?: ConstructorParameters<typeof World>[0]): World {
  const world = new World(options)
  worlds.push(world)
  return world
}

/** Spawns `values.length` entities and returns them in declaration order. */
function populate(world: World, values: readonly number[]): Entity[] {
  return values.map((value) => world.spawn(Position, SortIndex({ value })))
}

function keys(world: World, sorted: SortedQueryResult): number[] {
  return [...sorted].map((entity) => world.get(entity, SortIndex.value))
}

/**
 * Value invalidation is conservative at tick granularity (§6.7): a key written
 * in the tick of the last sort still counts, because the column's scalar
 * cannot tell a write before the sort from one after it. Stepping the clock
 * and then walking is what settles a view to `clean`.
 */
function settle(world: World, sorted: SortedQueryResult): void {
  world.step()
  void [...sorted]
}

afterEach(() => {
  for (const world of worlds.splice(0)) world.destroy()
})

describe('ordering (§6.7)', () => {
  test('sortBy(field) orders ascending by default', () => {
    const world = makeWorld()
    populate(world, [3, 1, 2])

    expect(keys(world, world.query(SortIndex).sortBy(SortIndex.value))).toEqual([1, 2, 3])
  })

  test("'asc' and 'desc' are honoured", () => {
    const world = makeWorld()
    populate(world, [3, 1, 2])

    expect(keys(world, world.query(SortIndex).sortBy(SortIndex.value, 'asc'))).toEqual([1, 2, 3])
    expect(keys(world, world.query(SortIndex).sortBy(SortIndex.value, 'desc'))).toEqual([3, 2, 1])
  })

  test('a comparator sorts by whatever it reads', () => {
    const world = makeWorld()
    const entities = populate(world, [3, 1, 2])
    const sorted = world
      .query(SortIndex)
      .sortBy((a, b) => world.get(b, SortIndex.value) - world.get(a, SortIndex.value))

    expect(keys(world, sorted)).toEqual([3, 2, 1])
    expect([...sorted]).toHaveLength(entities.length)
  })

  test('sorting spans archetypes', () => {
    const world = makeWorld()
    world.spawn(SortIndex({ value: 3 }))
    world.spawn(SortIndex({ value: 1 }), IsActive)
    world.spawn(SortIndex({ value: 2 }), Position)

    expect(keys(world, world.query(SortIndex).sortBy(SortIndex.value))).toEqual([1, 2, 3])
  })

  test('sorting is stable — ties keep their relative order across resorts', () => {
    const world = makeWorld()
    const entities = populate(world, [1, 1, 1, 1])
    const sorted = world.query(SortIndex).sortBy(SortIndex.value)
    const first = [...sorted]

    sorted.invalidate()

    expect([...sorted]).toEqual(first)
    expect(new Set(first)).toEqual(new Set(entities))
  })
})

describe('the result surface (§6.3, §6.7)', () => {
  test('a sorted result carries the tier-1 surface', () => {
    const world = makeWorld()
    populate(world, [2, 1])
    const sorted = world.query(SortIndex).sortBy(SortIndex.value)

    expect(sorted.count).toBe(2)
    expect(sorted.isEmpty).toBe(false)
    expect(sorted.first).toBe([...sorted][0])
    expect(sorted.entities()).toBeInstanceOf(Float64Array)
    expect([...sorted.entities()]).toEqual([...sorted])
  })

  test('each walks in sorted order', () => {
    const world = makeWorld()
    populate(world, [3, 1, 2])
    const seen: number[] = []

    world
      .query(SortIndex)
      .sortBy(SortIndex.value)
      .each((s) => seen.push(s.value))

    expect(seen).toEqual([1, 2, 3])
  })

  test('an empty sorted query has no first and no members', () => {
    const world = makeWorld()
    const sorted = world.query(SortIndex).sortBy(SortIndex.value)

    expect(sorted.count).toBe(0)
    expect(sorted.isEmpty).toBe(true)
    expect(sorted.first).toBeUndefined()
    expect([...sorted]).toEqual([])
  })
})

describe('memoisation (§6.7)', () => {
  test('sortBy on the same key returns the same object', () => {
    const world = makeWorld()
    const query = world.query(SortIndex)

    expect(query.sortBy(SortIndex.value)).toBe(query.sortBy(SortIndex.value))
    expect(query.sortBy(SortIndex.value, 'asc')).toBe(query.sortBy(SortIndex.value))
  })

  test('direction is part of the key', () => {
    const world = makeWorld()
    const query = world.query(SortIndex)

    expect(query.sortBy(SortIndex.value, 'asc')).not.toBe(query.sortBy(SortIndex.value, 'desc'))
  })

  test('the sorted view does not disturb the unsorted query', () => {
    const world = makeWorld()
    populate(world, [3, 1, 2])
    const query = world.query(SortIndex)
    const sorted = query.sortBy(SortIndex.value)

    expect(sorted).not.toBe(query)
    expect(query.count).toBe(sorted.count)
    expect(new Set([...query])).toEqual(new Set([...sorted]))
  })

  test('a hoisted sorted view keeps up with the world', () => {
    const world = makeWorld()
    populate(world, [3, 1])
    const sorted = world.query(SortIndex).sortBy(SortIndex.value)

    expect(keys(world, sorted)).toEqual([1, 3])

    populate(world, [2])

    expect(keys(world, sorted)).toEqual([1, 2, 3])

    world.despawn(sorted.first!)

    expect(keys(world, sorted)).toEqual([2, 3])
  })
})

describe('dirty levels (§6.7)', () => {
  test('a fresh view needs a rebuild and settles to clean', () => {
    const world = makeWorld()
    populate(world, [2, 1])
    const sorted = world.query(SortIndex).sortBy(SortIndex.value)

    expect(sorted.isDirty).toBe('rebuild')

    settle(world, sorted)

    expect(sorted.isDirty).toBe('clean')
  })

  test('a settled view stays clean across walks that change nothing', () => {
    const world = makeWorld()
    populate(world, [2, 1])
    const sorted = world.query(SortIndex).sortBy(SortIndex.value)
    settle(world, sorted)

    expect(keys(world, sorted)).toEqual([1, 2])
    expect(sorted.isDirty).toBe('clean')

    world.step()

    expect(sorted.isDirty).toBe('clean')
  })

  test('a write to the sort key asks for a resort', () => {
    const world = makeWorld()
    const entities = populate(world, [2, 1])
    const sorted = world.query(SortIndex).sortBy(SortIndex.value)
    settle(world, sorted)

    world.set(entities[0], SortIndex.value, 0)

    expect(sorted.isDirty).toBe('resort')
    expect(keys(world, sorted)).toEqual([0, 1])

    settle(world, sorted)

    expect(sorted.isDirty).toBe('clean')
  })

  test('a change to the matching set asks for a rebuild', () => {
    const world = makeWorld()
    populate(world, [2, 1])
    const sorted = world.query(SortIndex).sortBy(SortIndex.value)
    settle(world, sorted)

    populate(world, [3])

    expect(sorted.isDirty).toBe('rebuild')
    expect(keys(world, sorted)).toEqual([1, 2, 3])

    settle(world, sorted)

    expect(sorted.isDirty).toBe('clean')
  })

  test('a write to an unrelated trait leaves the view clean', () => {
    const world = makeWorld()
    const entities = populate(world, [2, 1])
    const sorted = world.query(SortIndex).sortBy(SortIndex.value)
    settle(world, sorted)

    world.set(entities[0], Position.x, 99)

    expect(sorted.isDirty).toBe('clean')
  })

  test('a comparator view never settles — it has no key column to watch', () => {
    const world = makeWorld()
    populate(world, [2, 1])
    const sorted = world.query(SortIndex).sortBy((a, b) => a - b)

    settle(world, sorted)

    expect(sorted.isDirty).toBe('resort')
  })
})

describe('escape hatches (§6.7)', () => {
  test('invalidate forces a resort on next access', () => {
    const world = makeWorld()
    populate(world, [2, 1])
    const sorted = world.query(SortIndex).sortBy(SortIndex.value)
    settle(world, sorted)

    sorted.invalidate()

    expect(sorted.isDirty).toBe('resort')

    settle(world, sorted)

    expect(sorted.isDirty).toBe('clean')
  })

  test('rebuild forces a full rebuild', () => {
    const world = makeWorld()
    populate(world, [2, 1])
    const sorted = world.query(SortIndex).sortBy(SortIndex.value)
    settle(world, sorted)

    sorted.rebuild()

    expect(sorted.isDirty).toBe('rebuild')
    expect(keys(world, sorted)).toEqual([1, 2])
  })

  test('a comparator over external state resorts on demand', () => {
    const world = makeWorld()
    const entities = populate(world, [0, 0])
    const weight = new Map<Entity, number>([
      [entities[0], 2],
      [entities[1], 1],
    ])
    const sorted = world.query(SortIndex).sortBy((a, b) => weight.get(a)! - weight.get(b)!)

    expect([...sorted]).toEqual([entities[1], entities[0]])

    weight.set(entities[0], 0)
    sorted.invalidate()

    expect([...sorted]).toEqual([entities[0], entities[1]])
  })

  test('dispose drops the sorted view from the cache', () => {
    const world = makeWorld()
    populate(world, [1])
    const query = world.query(SortIndex)
    const sorted = query.sortBy(SortIndex.value)

    sorted.dispose()

    // Identity compared as a boolean: a disposed view must not be walked, and
    // a failing `not.toBe` would walk it to print the diff.
    expect(query.sortBy(SortIndex.value) === sorted).toBe(false)
  })
})

describe('chunk writes and sorted views (§6.7)', () => {
  test('markChanged is what schedules the resort', () => {
    const world = makeWorld()
    const entities = populate(world, [1, 2, 3])
    const sorted = world.query(SortIndex).sortBy(SortIndex.value)
    settle(world, sorted)

    for (const chunk of world.query(SortIndex).chunks()) {
      const s = chunk.get(SortIndex)
      for (let i = 0; i < chunk.length; i++) s.value[i] = -s.value[i]
      chunk.markChanged(SortIndex)
    }

    expect(sorted.isDirty).toBe('resort')
    expect(keys(world, sorted)).toEqual([-3, -2, -1])
    expect([...sorted][0]).toBe(entities[2])
  })

  test('sorting by a field marks its trait tracked, so the tick machinery exists', () => {
    const Untracked = new Trait({ value: 0 })
    const world = makeWorld()
    const entity = world.spawn(Untracked({ value: 2 }))
    world.spawn(Untracked({ value: 1 }))
    const sorted = world.query(Untracked).sortBy(Untracked.value)
    settle(world, sorted)

    world.set(entity, Untracked.value, 0)

    expect(sorted.isDirty).toBe('resort')
  })
})
