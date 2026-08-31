import { afterEach, describe, expect, test, vi } from 'vitest'

import { Changed, Trait, World } from '../src/index'
import type { Entity } from '../src/index'
import { resetWarnOnce } from '../src/internal'
import { columnOf, rowOf } from './support/columns'

const Level = new Trait({ value: 0 }, { track: true })

afterEach(() => {
  vi.restoreAllMocks()
  resetWarnOnce()
})

describe('writes that bump ticks (§8.3)', () => {
  test('world.set stamps the row tick and the column scalar', () => {
    const world = new World()
    const e = world.spawn(Level)
    world.step()

    world.set(e, Level.value, 1)

    const column = columnOf(world, e, Level.value)
    expect(column.ticks![0][rowOf(world, e)]).toBe(world.tick)
    expect(column.lastWriteTick).toBe(world.tick)

    world.destroy()
  })

  test('cursor setters write the tick for a tracked trait', () => {
    const world = new World()
    const e = world.spawn(Level)
    const changed = world.query(Level, Changed(Level))
    changed.each(() => {}) // consume the initial state
    world.step()

    world.query(Level).each((level) => {
      level.value = 7
    })

    const column = columnOf(world, e, Level.value)
    expect(column.ticks![0][rowOf(world, e)]).toBe(world.tick)
    expect(column.lastWriteTick).toBe(world.tick)

    const seen: Entity[] = []
    changed.each((_level, entity: Entity) => seen.push(entity))
    expect(seen).toEqual([e])

    world.destroy()
  })

  test('cursor reads do not write the tick', () => {
    const world = new World()
    const e = world.spawn(Level({ value: 4 }))
    world.step()

    let total = 0
    world.query(Level).each((level) => {
      total += level.value
    })

    expect(total).toBe(4)
    const column = columnOf(world, e, Level.value)
    expect(column.ticks![0][rowOf(world, e)]).toBe(world.tick - 1)
    expect(column.lastWriteTick).toBe(world.tick - 1)

    world.destroy()
  })

  test('world.changed stamps without touching the data', () => {
    const world = new World()
    const e = world.spawn(Level({ value: 42 }))
    world.step()

    world.changed(e, Level)

    const column = columnOf(world, e, Level.value)
    expect(column.ticks![0][rowOf(world, e)]).toBe(world.tick)
    expect(column.lastWriteTick).toBe(world.tick)
    expect(world.get(e, Level.value)).toBe(42)

    world.destroy()
  })

  test('chunk.markChanged stamps every row of the chunk', () => {
    const world = new World()
    const batch = world.spawnMany(3, Level)
    world.step()

    for (const chunk of world.query(Level).chunks()) chunk.markChanged(Level)

    const column = columnOf(world, batch[0] as Entity, Level.value)
    for (let row = 0; row < 3; row++) expect(column.ticks![0][row]).toBe(world.tick)
    expect(column.lastWriteTick).toBe(world.tick)

    world.destroy()
  })

  test('chunk.markChanged with a row stamps that row alone', () => {
    const world = new World()
    const batch = world.spawnMany(3, Level)
    const changed = world.query(Level, Changed(Level))
    changed.each(() => {}) // consume the initial state
    world.step()

    let marked = 0 as Entity
    for (const chunk of world.query(Level).chunks()) {
      chunk.markChanged(Level, 1)
      marked = chunk.entity(1)
    }

    const column = columnOf(world, batch[0] as Entity, Level.value)
    expect(column.ticks![0][0]).toBe(world.tick - 1)
    expect(column.ticks![0][1]).toBe(world.tick)
    expect(column.ticks![0][2]).toBe(world.tick - 1)

    const seen: Entity[] = []
    changed.each((_level, entity: Entity) => seen.push(entity))
    expect(seen).toEqual([marked])

    world.destroy()
  })

  test('direct chunk writes bump nothing by themselves (§6.6)', () => {
    const world = new World()
    const e = world.spawn(Level)
    const changed = world.query(Level, Changed(Level))
    changed.each(() => {}) // consume the initial state
    world.step()

    vi.spyOn(console, 'warn').mockImplementation(() => {}) // silence the dev store guard
    for (const chunk of world.query(Level).chunks()) {
      chunk.get(Level).value[0] = 99
    }

    expect(world.get(e, Level.value)).toBe(99)
    const column = columnOf(world, e, Level.value)
    expect(column.ticks![0][rowOf(world, e)]).toBe(world.tick - 1)
    expect(column.lastWriteTick).toBe(world.tick - 1)

    const seen: Entity[] = []
    changed.each((_level, entity: Entity) => seen.push(entity))
    expect(seen).toEqual([])

    world.destroy()
  })
})
