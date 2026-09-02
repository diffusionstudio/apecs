import { describe, expect, test } from 'vitest'

import { Trait, World, f32, str } from '../src/index'
import type { Entity } from '../src/index'
import { $archetypes, $entities, $id, entityId } from '../src/internal'

const Position = new Trait({ x: f32(0), y: f32(0) })
const Name = new Trait({ value: str('') })
const Cooldown = new Trait({ left: 0 }, { storage: 'sparse' })
const IsActive = new Trait()
const Time = new Trait({ delta: 0 })

const PAGE = 4

const archetypeOf = (world: World, e: Entity) =>
  world[$archetypes].list[world[$entities].archetypes[entityId(e)]]

describe('clear (§5.5)', () => {
  test('despawns every entity, firing onRemove and onExit for each', () => {
    const world = new World()
    const spawned = [world.spawn(Position, IsActive), world.spawn(Position), world.spawn(IsActive)]
    const removed: Entity[] = []
    const exited: Entity[] = []
    world.onRemove(Position, (e) => removed.push(e))
    world.onExit(world.query(IsActive), (e) => exited.push(e))

    world.clear()

    expect(spawned.every((e) => !world.isAlive(e))).toBe(true)
    expect(world.query(Position).count).toBe(0)
    expect(world.query(IsActive).count).toBe(0)
    expect(removed.sort()).toEqual([spawned[0], spawned[1]].sort())
    expect(exited.sort()).toEqual([spawned[0], spawned[2]].sort())

    world.destroy()
  })

  test('the world entity and its traits survive', () => {
    const world = new World()
    world.add(Time, Position({ x: 3 }))
    world.spawn(Position)

    world.clear()

    expect(world.isAlive(world.entity)).toBe(true)
    expect(world.has(Time)).toBe(true)
    expect(world.get(Position.x)).toBe(3)
    expect(world.query(Position).count).toBe(1)

    world.destroy()
  })

  test('sparse storage is cleared with the entity', () => {
    const world = new World()
    const e = world.spawn(Position, Cooldown({ left: 5 }))

    world.clear()
    const again = world.spawn(Position)

    expect(entityId(again)).toBe(entityId(e))
    expect(world.has(again, Cooldown)).toBe(false)

    world.destroy()
  })

  test('archetypes and their pages stay warm', () => {
    const world = new World({ pageSize: PAGE })
    const e = world.spawn(Position, Name({ value: 'a' }))
    world.spawnMany(PAGE * 2, Position, Name)
    const archetype = archetypeOf(world, e)
    const archetypes = world[$archetypes].list.length
    const pages = archetype.entities.length

    world.clear()

    expect(world[$archetypes].list.length).toBe(archetypes)
    expect(archetype.rows).toBe(0)
    expect(archetype.entities.length).toBe(pages)
    expect(archetype.column(Name.value)!.pages.length).toBe(pages)

    const fresh = world.spawn(Position({ x: 7 }), Name({ value: 'b' }))
    expect(archetypeOf(world, fresh)).toBe(archetype)
    expect(archetype.entities.length).toBe(pages)
    expect(world.get(fresh, Position.x)).toBe(7)
    expect(world.get(fresh, Name.value)).toBe('b')

    world.destroy()
  })

  test('boxed values are released, not retained by the warm pages', () => {
    const world = new World({ pageSize: PAGE })
    const e = world.spawn(Name({ value: 'held' }))
    const column = archetypeOf(world, e).column(Name.value)!

    world.clear()

    expect((column.pages[0] as unknown[]).every((v) => v === undefined)).toBe(true)

    world.destroy()
  })

  test('ids recycle after a clear, with a bumped generation', () => {
    const world = new World()
    const cleared = [world.spawn(), world.spawn()]

    world.clear()
    const reused = world.spawn()

    expect(cleared.map(entityId)).toContain(entityId(reused))
    expect(cleared).not.toContain(reused)
    expect(cleared.every((e) => !world.isAlive(e))).toBe(true)

    world.destroy()
  })
})

describe('compact (§10.2)', () => {
  test('empty tail pages are retained until compacted, then released from every column', () => {
    const world = new World({ pageSize: PAGE })
    const batch = world.spawnMany(PAGE * 2 + 1, Position, Name)
    const archetype = archetypeOf(world, batch[0] as Entity)
    for (let i = 3; i < batch.length; i++) world.despawn(batch[i] as Entity)

    expect(archetype.rows).toBe(3)
    expect(archetype.entities.length).toBe(3)

    world.compact()

    expect(archetype.entities.length).toBe(1)
    expect(archetype.column(Position.x)!.pages.length).toBe(1)
    expect(archetype.column(Name.value)!.pages.length).toBe(1)
    for (let i = 0; i < 3; i++) expect(world.isAlive(batch[i] as Entity)).toBe(true)

    world.destroy()
  })

  test('an archetype grows again after compaction', () => {
    const world = new World({ pageSize: PAGE })
    const batch = world.spawnMany(PAGE * 2, Position)
    const archetype = archetypeOf(world, batch[0] as Entity)
    world.despawnMany(batch)
    world.compact()
    expect(archetype.entities.length).toBe(0)

    const again = world.spawnMany(PAGE + 1, Position({ x: 9 }))

    expect(archetypeOf(world, again[0] as Entity)).toBe(archetype)
    expect(archetype.entities.length).toBe(2)
    for (let i = 0; i < again.length; i++) expect(world.get(again[i] as Entity, Position.x)).toBe(9)

    world.destroy()
  })

  test('clear then compact releases every page of every archetype', () => {
    const world = new World({ pageSize: PAGE })
    world.spawnMany(PAGE * 3, Position)
    world.spawnMany(PAGE * 3, Position, IsActive)

    world.clear()
    world.compact()

    for (const archetype of world[$archetypes].list) {
      const pages = archetype === world[$archetypes].root ? 1 : 0
      expect(archetype.entities.length).toBe(pages)
      for (const column of archetype.columns) expect(column.pages.length).toBe(pages)
    }

    world.destroy()
  })

  test('sparse stores are compacted too', () => {
    const world = new World({ pageSize: PAGE })
    const batch = world.spawnMany(PAGE * 2 + 1, Cooldown)
    world.despawnMany(batch)
    const survivor = world.spawn(Cooldown({ left: 2 }))

    world.compact()

    expect(world.get(survivor, Cooldown.left)).toBe(2)
    world.spawnMany(PAGE * 2, Cooldown)
    expect(world.query(Cooldown).count).toBe(0) // sparse traits are not queryable by archetype
    expect(world.has(survivor, Cooldown)).toBe(true)

    world.destroy()
  })
})

describe('destroy (§5.5)', () => {
  test('fires onRemove for every entity, the world entity included', () => {
    const world = new World()
    world.add(Time)
    const a = world.spawn(Position, IsActive)
    const b = world.spawn(Position)
    const removed: string[] = []
    world.onRemove(Position, (e) => removed.push(`pos:${e}`))
    world.onRemove(IsActive, (e) => removed.push(`active:${e}`))
    world.onRemove(Time, (e) => removed.push(`time:${e}`))

    world.destroy()

    expect(removed.sort()).toEqual(
      [`pos:${a}`, `pos:${b}`, `active:${a}`, `time:${world.entity}`].sort(),
    )
  })

  test('onRemove reads the data of the entity being torn down', () => {
    const world = new World()
    world.spawn(Name({ value: 'last words' }))
    let seen = ''
    world.onRemove(Name, (e) => {
      seen = world.get(e, Name.value)
    })

    world.destroy()

    expect(seen).toBe('last words')
  })

  test('releases the world id for the next world', () => {
    const world = new World()
    const id = world[$id]

    world.destroy()
    const next = new World()

    expect(next[$id]).toBe(id)

    next.destroy()
  })

  test('a second destroy is a no-op', () => {
    const world = new World()
    world.destroy()

    expect(() => world.destroy()).not.toThrow()
  })

  test('unsubscribe handles from a destroyed world are inert', () => {
    const world = new World()
    const off = world.onAdd(Position, () => {})
    world.destroy()

    expect(() => off()).not.toThrow()
  })

  test.runIf(__DEV__)('dev throws on any later use', () => {
    const world = new World()
    const e = world.spawn(Position)
    const query = world.query(Position)
    world.destroy()

    const uses: Array<() => unknown> = [
      () => world.spawn(),
      () => world.spawnMany(1, Position),
      () => world.despawn(e),
      () => world.despawnMany([e]),
      () => world.isAlive(e),
      () => world.add(e, IsActive),
      () => world.add(Time),
      () => world.addMany([e], IsActive),
      () => world.remove(e, Position),
      () => world.removeMany([e], Position),
      () => world.has(e, Position),
      () => world.get(e, Position),
      () => world.set(e, Position, { x: 1 }),
      () => world.changed(e, Position),
      () => world.tick,
      () => world.step(),
      () => world.onAdd(Position, () => {}),
      () => world.onRemove(Position, () => {}),
      () => world.onChange(Position, () => {}),
      () => world.onEnter(query, () => {}),
      () => world.onExit(query, () => {}),
      () => world.query(Position),
      () => world.createQuery(Position),
      () => world.queryFirst(Position),
      () => world.defer(() => {}),
      () => world.flush(),
      () => world.clear(),
      () => world.compact(),
    ]
    for (const use of uses) expect(use).toThrowError(/destroyed/)
  })
})
