import { describe, expect, test } from 'vitest'

import { Trait, World, f32 } from '../src/index'
import type { Entity } from '../src/index'

const Position = new Trait({ x: f32(0), y: f32(0) })
const Velocity = new Trait({ x: f32(0), y: f32(0) })
const Marked = new Trait()

/** Enough entities to span several pages, so swap-removes cross page boundaries. */
const PAGE = 4
const COUNT = PAGE * 2 + 1

type Walk = (world: World, fn: (entity: Entity) => void) => void

/** The same visit through each access tier; chunks walk their page back to front (§9). */
const tiers: Array<[string, Walk]> = [
  [
    'Tier 1 — entities',
    (world, fn) => {
      for (const entity of world.query(Position)) fn(entity)
    },
  ],
  ['Tier 2 — each', (world, fn) => world.query(Position).each((_p, entity: Entity) => fn(entity))],
  [
    'Tier 3 — chunks',
    (world, fn) => {
      for (const chunk of world.query(Position).chunks()) {
        for (let i = chunk.length - 1; i >= 0; i--) fn(chunk.entity(i))
      }
    },
  ],
]

function spawnAll(world: World, ...extra: Trait[]): Entity[] {
  const out: Entity[] = []
  for (let i = 0; i < COUNT; i++) out.push(world.spawn(Position({ x: i }), ...extra))
  return out
}

/** Creates the archetype for `traits` without leaving an entity in it. */
function warm(world: World, ...traits: Trait[]): void {
  world.despawn(world.spawn(...traits))
}

const ascending = (a: number, b: number) => a - b

describe.each(tiers)('%s — mutating the current entity (§9)', (_name, walk) => {
  test('despawning the current entity visits every entity once and empties the query', () => {
    const world = new World({ pageSize: PAGE })
    const spawned = spawnAll(world)

    const visited: Entity[] = []
    walk(world, (entity) => {
      visited.push(entity)
      world.despawn(entity)
    })

    expect([...visited].sort(ascending)).toEqual([...spawned].sort(ascending))
    expect(world.query(Position).count).toBe(0)
    expect(spawned.every((e) => !world.isAlive(e))).toBe(true)

    world.destroy()
  })

  test('despawning some of the entities leaves every survivor intact and readable', () => {
    const world = new World({ pageSize: PAGE })
    const spawned = spawnAll(world)

    const visited: Entity[] = []
    walk(world, (entity) => {
      visited.push(entity)
      if (world.get(entity, Position.x) % 2 === 0) world.despawn(entity)
    })

    expect(visited).toHaveLength(COUNT)
    for (let i = 0; i < COUNT; i++) {
      expect(world.isAlive(spawned[i])).toBe(i % 2 === 1)
      if (i % 2 === 1) expect(world.get(spawned[i], Position.x)).toBe(i)
    }

    world.destroy()
  })

  test('adding a trait that moves the entity into an archetype not yet walked visits it once', () => {
    const world = new World({ pageSize: PAGE })
    // Older archetypes are walked last, so this is the destination the walk has not reached.
    warm(world, Position, Marked)
    const spawned = spawnAll(world)

    const visited: Entity[] = []
    walk(world, (entity) => {
      visited.push(entity)
      world.add(entity, Marked)
    })

    expect([...visited].sort(ascending)).toEqual([...spawned].sort(ascending))
    expect(spawned.every((e) => world.has(e, Marked))).toBe(true)
    expect(world.query(Position, Marked).count).toBe(COUNT)

    world.destroy()
  })

  test('adding a trait that moves the entity into an archetype already walked visits it once', () => {
    const world = new World({ pageSize: PAGE })
    const spawned = spawnAll(world)
    warm(world, Position, Marked)

    const visited: Entity[] = []
    walk(world, (entity) => {
      visited.push(entity)
      world.add(entity, Marked)
    })

    expect([...visited].sort(ascending)).toEqual([...spawned].sort(ascending))
    expect(spawned.every((e) => world.has(e, Marked))).toBe(true)

    world.destroy()
  })

  test('removing a trait that moves the entity into an archetype not yet walked visits it once', () => {
    const world = new World({ pageSize: PAGE })
    warm(world, Position)
    const spawned = spawnAll(world, Velocity)

    const visited: Entity[] = []
    walk(world, (entity) => {
      visited.push(entity)
      world.remove(entity, Velocity)
    })

    expect([...visited].sort(ascending)).toEqual([...spawned].sort(ascending))
    expect(spawned.every((e) => !world.has(e, Velocity))).toBe(true)
    expect(world.query(Position).count).toBe(COUNT)

    world.destroy()
  })

  test('a trait added and removed again within one visit leaves the entity in place, seen once', () => {
    const world = new World({ pageSize: PAGE })
    warm(world, Position, Marked)
    const spawned = spawnAll(world)

    const visited: Entity[] = []
    walk(world, (entity) => {
      visited.push(entity)
      world.add(entity, Marked)
      world.remove(entity, Marked)
    })

    expect([...visited].sort(ascending)).toEqual([...spawned].sort(ascending))
    expect(world.query(Position).count).toBe(COUNT)
    for (let i = 0; i < COUNT; i++) expect(world.get(spawned[i], Position.x)).toBe(i)

    world.destroy()
  })

  test('values on any entity may be read and written during the walk', () => {
    const world = new World({ pageSize: PAGE })
    const spawned = spawnAll(world)
    const last = spawned[COUNT - 1]

    walk(world, (entity) => {
      world.set(last, Position.y, world.get(last, Position.y) + 1)
      world.set(entity, Position.x, world.get(entity, Position.x) * 2)
    })

    expect(world.get(last, Position.y)).toBe(COUNT)
    for (let i = 0; i < COUNT; i++) expect(world.get(spawned[i], Position.x)).toBe(i * 2)

    world.destroy()
  })

  test('a deferred spawn lands after the walk and is not visited by it', () => {
    const world = new World({ pageSize: PAGE })
    spawnAll(world)

    let visits = 0
    walk(world, () => {
      visits++
      world.defer(() => world.spawn(Position))
    })
    world.flush() // only `each` and `chunks` flush on their own (§9)

    expect(visits).toBe(COUNT)
    expect(world.query(Position).count).toBe(COUNT * 2)

    world.destroy()
  })
})

describe('Tier 2 cursors under mutation (§9)', () => {
  test('the cursor still reads the current row after the entity ahead of it was despawned', () => {
    const world = new World({ pageSize: PAGE })
    spawnAll(world)

    const seen: number[] = []
    world.query(Position).each((p, entity: Entity) => {
      seen.push(p.x)
      world.despawn(entity)
    })

    expect(seen.sort(ascending)).toEqual(Array.from({ length: COUNT }, (_, i) => i))

    world.destroy()
  })
})

describe('Tier 3 chunks under mutation (§9)', () => {
  test('a chunk visited after despawns reflects the shrunken archetype', () => {
    const world = new World({ pageSize: PAGE })
    spawnAll(world)

    let rows = 0
    for (const chunk of world.query(Position).chunks()) {
      rows += chunk.length
      for (let i = chunk.length - 1; i >= 0; i--) world.despawn(chunk.entity(i))
    }

    expect(rows).toBe(COUNT)
    expect(world.query(Position).count).toBe(0)

    world.destroy()
  })
})
