import { describe, expect, test } from 'vitest'

import { Trait, World, f32 } from '../src/index'
import type { Entity } from '../src/index'

const Position = new Trait({ x: f32(0), y: f32(0) })
const Velocity = new Trait({ x: f32(0), y: f32(0) })
const IsActive = new Trait()

const ascending = (a: number, b: number) => a - b

describe('a chunk is one page of one archetype (§6.6)', () => {
  test('pages are the unit, and the tail page is short', () => {
    const world = new World({ pageSize: 4 })
    world.spawnMany(9, Position)

    const lengths: number[] = []
    for (const chunk of world.query(Position).chunks()) lengths.push(chunk.length)

    expect(lengths.sort(ascending)).toEqual([1, 4, 4])

    world.destroy()
  })

  test('views are whole pages — length is what bounds the loop, not the array', () => {
    const world = new World({ pageSize: 4 })
    world.spawnMany(5, Position)

    for (const chunk of world.query(Position).chunks()) {
      expect(chunk.entities).toBeInstanceOf(Float64Array)
      expect(chunk.entities).toHaveLength(4)
      expect(chunk.get(Position).x).toHaveLength(4)
      expect(chunk.length).toBeLessThanOrEqual(4)
    }

    world.destroy()
  })

  test('every matching archetype contributes its pages', () => {
    const world = new World({ pageSize: 4 })
    const expected = new Set<Entity>()
    for (let i = 0; i < 6; i++) expected.add(world.spawn(Position))
    for (let i = 0; i < 3; i++) expected.add(world.spawn(Position, Velocity))
    for (let i = 0; i < 2; i++) expected.add(world.spawn(Position, IsActive))
    world.spawn(Velocity)

    const seen: Entity[] = []
    for (const chunk of world.query(Position).chunks()) {
      for (let i = 0; i < chunk.length; i++) seen.push(chunk.entity(i))
    }

    expect(seen).toHaveLength(expected.size)
    expect(new Set(seen)).toEqual(expected)

    world.destroy()
  })

  test('an empty result and an emptied archetype yield no chunk', () => {
    const world = new World({ pageSize: 4 })
    const e = world.spawn(Position, Velocity)
    world.spawn(Position)
    const query = world.query(Position, Velocity)

    world.despawn(e)

    let steps = 0
    let rows = 0
    for (const chunk of query.chunks()) {
      steps++
      rows += chunk.length
    }
    for (const chunk of world.query(IsActive).chunks()) {
      steps++
      rows += chunk.length
    }

    expect(steps).toBe(0)
    expect(rows).toBe(0)

    world.destroy()
  })
})

describe('index alignment (§6.6)', () => {
  test('row i is the same entity in every column and in entities', () => {
    const world = new World({ pageSize: 4 })
    const entities: Entity[] = []
    for (let i = 0; i < 9; i++) {
      entities.push(world.spawn(Position({ x: i, y: -i }), Velocity({ x: i * 2 })))
    }

    let visited = 0
    for (const chunk of world.query(Position, Velocity).chunks()) {
      const p = chunk.get(Position)
      const v = chunk.get(Velocity)
      for (let i = 0; i < chunk.length; i++) {
        const entity = chunk.entity(i)
        expect(chunk.entities[i]).toBe(entity)
        expect(p.x[i]).toBe(world.get(entity, Position.x))
        expect(p.y[i]).toBe(world.get(entity, Position.y))
        expect(v.x[i]).toBe(world.get(entity, Velocity.x))
        visited++
      }
    }

    expect(visited).toBe(entities.length)

    world.destroy()
  })

  test('a chunk write is visible through the world', () => {
    const world = new World({ pageSize: 4 })
    const entities: Entity[] = []
    for (let i = 0; i < 6; i++) entities.push(world.spawn(Position({ x: i }), Velocity({ x: 10 })))

    for (const chunk of world.query(Position, Velocity).chunks()) {
      const { x } = chunk.get(Position)
      const { x: vx } = chunk.get(Velocity)
      for (let i = 0, n = chunk.length; i < n; i++) x[i] += vx[i]
    }

    for (let i = 0; i < entities.length; i++)
      expect(world.get(entities[i], Position.x)).toBe(i + 10)

    world.destroy()
  })

  test('column and get address the same typed array', () => {
    const world = new World({ pageSize: 4 })
    world.spawn(Position)

    for (const chunk of world.query(Position).chunks()) {
      expect(chunk.column(Position.x)).toBe(chunk.get(Position).x)
      expect(chunk.column(Position.y)).toBe(chunk.get(Position).y)
    }

    world.destroy()
  })

  test('the store view is cached per trait and repointed at the next page', () => {
    const world = new World({ pageSize: 4 })
    world.spawnMany(8, Position)

    const stores: Array<{ x: Float32Array }> = []
    const arrays: Float32Array[] = []
    for (const chunk of world.query(Position).chunks()) {
      const store = chunk.get(Position)
      expect(chunk.get(Position)).toBe(store)
      stores.push(store)
      arrays.push(store.x)
    }

    expect(stores).toHaveLength(2)
    expect(stores[1]).toBe(stores[0])
    expect(arrays[1]).not.toBe(arrays[0])

    world.destroy()
  })
})

describe('the iterator (§12.2)', () => {
  test('chunks() hands back one reusable iterator, not a fresh generator', () => {
    const world = new World({ pageSize: 4 })
    world.spawnMany(5, Position)
    const query = world.query(Position)

    const chunks = query.chunks()

    expect(query.chunks()).toBe(chunks)

    const iterator = chunks[Symbol.iterator]() as IterableIterator<unknown>

    expect(iterator[Symbol.iterator]()).toBe(iterator)
    expect(iterator.next).toBeTypeOf('function')
    expect(Object.prototype.toString.call(iterator)).not.toBe('[object Generator]')

    world.destroy()
  })

  test('the iterator restarts, and stays done once it is done', () => {
    const world = new World({ pageSize: 4 })
    world.spawnMany(5, Position)
    const query = world.query(Position)

    const first: number[] = []
    for (const chunk of query.chunks()) first.push(chunk.length)
    const second: number[] = []
    for (const chunk of query.chunks()) second.push(chunk.length)

    expect(second).toEqual(first)

    const iterator = query.chunks()[Symbol.iterator]()
    while (!iterator.next().done) {
      /* drain */
    }

    expect(iterator.next()).toEqual({ done: true, value: undefined })

    world.destroy()
  })

  test('the chunk object is reused across steps', () => {
    const world = new World({ pageSize: 4 })
    world.spawnMany(6, Position)
    world.spawnMany(6, Position, Velocity)

    const identities = new Set<unknown>()
    let steps = 0
    for (const chunk of world.query(Position).chunks()) {
      identities.add(chunk)
      steps++
    }

    expect(steps).toBe(4)
    expect(identities.size).toBe(1)

    world.destroy()
  })
})
