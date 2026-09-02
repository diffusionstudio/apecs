import { describe, expect, test, vi } from 'vitest'

import { Trait, World, f32 } from '../src/index'
import type { Entity } from '../src/index'
import { $view, Column, sortByKey } from '../src/internal'

const Position = new Trait({ x: f32(0), y: f32(0) })
const SortIndex = new Trait({ value: 0 })
const IsActive = new Trait()

/** A deterministic LCG, so a failing shuffle is reproducible. */
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

/** The reference: a stable ascending order of indices by key. */
function reference(keys: ArrayLike<number>): number[] {
  return Array.from({ length: keys.length }, (_, i) => i).sort((a, b) => keys[a] - keys[b] || a - b)
}

function identity(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i)
}

/** Wraps a key array so every indexed read is counted. */
function counted(keys: Float64Array): { keys: Float64Array; reads: () => number } {
  let reads = 0
  const proxy = new Proxy(keys, {
    get(target, property, receiver) {
      if (typeof property === 'string' && property !== 'length') reads++
      return Reflect.get(target, property, receiver)
    },
  })
  return { keys: proxy, reads: () => reads }
}

describe('sortByKey (§6.7)', () => {
  test('sorts random keys of every size, including the short-run and merge edge cases', () => {
    const random = rng(7)
    for (const n of [0, 1, 2, 3, 31, 32, 33, 64, 65, 100, 1000, 4097]) {
      const keys = new Float64Array(n)
      for (let i = 0; i < n; i++) keys[i] = Math.floor(random() * 50)
      const order = identity(n)

      sortByKey(order, keys)

      expect(order).toEqual(reference(keys))
    }
  })

  test('ties keep their previous relative order', () => {
    const keys = new Float64Array([1, 0, 1, 0, 1, 0, 1, 0])
    const order = [7, 5, 3, 1, 6, 4, 2, 0] // zeros then ones, each group reversed

    sortByKey(order, keys)

    expect(order).toEqual([7, 5, 3, 1, 6, 4, 2, 0])
  })

  test('an ordered input costs one linear scan and moves nothing', () => {
    const n = 1000
    const plain = new Float64Array(n)
    for (let i = 0; i < n; i++) plain[i] = i * 2
    const { keys, reads } = counted(plain)
    const order = identity(n)

    sortByKey(order, keys)

    expect(order).toEqual(identity(n))
    expect(reads()).toBeLessThanOrEqual(2 * n)
  })

  test('a strictly descending input is one reversed run', () => {
    const n = 1000
    const plain = new Float64Array(n)
    for (let i = 0; i < n; i++) plain[i] = n - i
    const { keys, reads } = counted(plain)
    const order = identity(n)

    sortByKey(order, keys)

    expect(order).toEqual(reference(plain))
    expect(reads()).toBeLessThanOrEqual(2 * n)
  })

  test('a handful of drifted keys costs a linear pass, not a full sort', () => {
    const n = 100_000
    const plain = new Float64Array(n)
    for (let i = 0; i < n; i++) plain[i] = i
    plain[10] = 500
    plain[70_000] = 30
    plain[n - 1] = -1
    const { keys, reads } = counted(plain)
    const order = identity(n)

    sortByKey(order, keys)

    expect(order).toEqual(reference(plain))
    expect(reads()).toBeLessThan(n * Math.log2(n))
    expect(reads()).toBeLessThanOrEqual(12 * n)
  })

  test('NaN keys are unorderable but still terminate with a permutation', () => {
    const random = rng(11)
    const keys = new Float64Array(500)
    for (let i = 0; i < keys.length; i++) keys[i] = random() < 0.1 ? NaN : random()
    const order = identity(keys.length)

    sortByKey(order, keys)

    expect([...order].sort((a, b) => a - b)).toEqual(identity(keys.length))
  })
})

describe('key extraction and the permutation (§6.7)', () => {
  test('keys are extracted once into a Float64Array parallel to the walk order', () => {
    const world = new World({ pageSize: 2 })
    for (const value of [5, 3, 4, 1, 2]) world.spawn(SortIndex({ value }))
    world.spawn(SortIndex({ value: 9 }), IsActive)
    const query = world.query(SortIndex)
    const sorted = query.sortBy(SortIndex.value)

    sorted.entities()

    const view = sorted[$view]
    expect(view.keys).toBeInstanceOf(Float64Array)
    const extracted = Array.from(query.entities(), (e) => world.get(e as Entity, SortIndex.value))
    expect(Array.from(view.keys.subarray(0, view.length))).toEqual(extracted)
    expect(Array.from(view.list.subarray(0, view.length))).toEqual(Array.from(query.entities()))

    world.destroy()
  })

  test('a descending view negates the key at extraction, so the sort never branches on direction', () => {
    const world = new World()
    for (const value of [1, 3, 2]) world.spawn(SortIndex({ value }))
    const sorted = world.query(SortIndex).sortBy(SortIndex.value, 'desc')

    sorted.entities()

    const view = sorted[$view]
    expect(
      Array.from(view.keys.subarray(0, view.length))
        .map((k) => -k)
        .sort(),
    ).toEqual([1, 2, 3])
    expect(Array.from(sorted, (e) => world.get(e, SortIndex.value))).toEqual([3, 2, 1])

    world.destroy()
  })

  test('the sort reads only the key array — never the world or the columns', () => {
    const world = new World({ pageSize: 4 })
    for (let value = 20; value > 0; value--) world.spawn(SortIndex({ value }), Position)
    const sorted = world.query(SortIndex).sortBy(SortIndex.value)
    const get = vi.spyOn(World.prototype, 'get')
    const columnGet = vi.spyOn(Column.prototype, 'get')

    sorted.entities()
    world.step()
    world.query(SortIndex).each((s) => {
      s.value = 21 - s.value
    })
    sorted.entities()

    expect(get).not.toHaveBeenCalled()
    expect(columnGet).not.toHaveBeenCalled()
    vi.restoreAllMocks()
    world.destroy()
  })

  test('a resort refreshes the keys and re-sorts the same permutation in place', () => {
    const world = new World()
    const spawned = [3, 1, 2].map((value) => world.spawn(SortIndex({ value })))
    const sorted = world.query(SortIndex).sortBy(SortIndex.value)
    sorted.entities()
    const view = sorted[$view]
    const { order, keys, entities, list } = view
    const rebuilds = view.stamp.structural

    world.step()
    world.set(spawned[1], SortIndex.value, 10)
    expect([...sorted]).toEqual([spawned[2], spawned[0], spawned[1]])

    expect(view.order).toBe(order)
    expect(view.keys).toBe(keys)
    expect(view.entities).toBe(entities)
    expect(view.list).toBe(list)
    expect(view.stamp.structural).toBe(rebuilds)

    world.destroy()
  })

  test('ties keep their previous relative order across resorts', () => {
    const world = new World()
    const spawned: Entity[] = []
    for (let i = 0; i < 6; i++) spawned.push(world.spawn(SortIndex({ value: 1 })))
    const sorted = world.query(SortIndex).sortBy(SortIndex.value)
    const initial = [...sorted]
    expect(initial).toEqual(Array.from(world.query(SortIndex).entities()))

    world.step()
    world.set(initial[0], SortIndex.value, 5)
    expect([...sorted]).toEqual([...initial.slice(1), initial[0]])

    world.step()
    world.set(initial[0], SortIndex.value, 1)
    expect([...sorted]).toEqual([...initial.slice(1), initial[0]])

    world.destroy()
  })

  test('a rebuild keeps the surviving order, so equal keys do not reshuffle on spawn', () => {
    const world = new World()
    for (let i = 0; i < 5; i++) world.spawn(SortIndex({ value: 0 }))
    const sorted = world.query(SortIndex).sortBy(SortIndex.value)
    const before = [...sorted]

    const late = world.spawn(SortIndex({ value: 0 }))
    const after = [...sorted]

    expect(after.filter((e) => e !== late)).toEqual(before)

    world.despawn(before[2])
    expect([...sorted].filter((e) => e !== late)).toEqual(before.filter((e) => e !== before[2]))

    world.destroy()
  })

  test('the comparator overload orders through the user function', () => {
    const world = new World()
    const spawned = [2, 3, 1].map((value) => world.spawn(SortIndex({ value })))
    const cmp = (a: Entity, b: Entity) =>
      world.get(b, SortIndex.value) - world.get(a, SortIndex.value)

    expect([...world.query(SortIndex).sortBy(cmp)]).toEqual([spawned[1], spawned[0], spawned[2]])

    world.destroy()
  })
})
