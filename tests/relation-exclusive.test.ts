import { describe, expect, test } from 'vitest'

import { Not, Relation, Trait, World, f32 } from '../src/index'
import type { Entity } from '../src/index'
import {
  $archetypes,
  $id,
  $plan,
  $relations,
  $targetField,
  $traits,
  maskHas,
} from '../src/internal'
import { archetypeOf, rowOf } from './support/columns'

const Position = new Trait({ x: f32(0), y: f32(0) })
const IsActive = new Trait()
const ChildOf = new Relation(undefined, { exclusive: true })
const Attached = new Relation({ offset: 0 }, { exclusive: true })

function sorted(entities: Iterable<number>): number[] {
  return [...entities].sort((a, b) => a - b)
}

describe('storage (§7.4)', () => {
  test('one archetype regardless of how many distinct targets exist', () => {
    const world = new World()
    const before = world[$archetypes].list.length

    for (let i = 0; i < 200; i++) world.spawn(ChildOf(world.spawn()))

    expect(world[$archetypes].list.length).toBe(before + 1)
    expect(world.query(ChildOf('*'))[$archetypes]).toHaveLength(1)

    world.destroy()
  })

  test('the target lives in a Float64Array column after the data columns', () => {
    const world = new World()
    const parent = world.spawn()
    const child = world.spawn(Attached(parent, { offset: 3 }))

    const columns = archetypeOf(world, child).columnsOf.get(Attached[$id])!
    expect(columns).toHaveLength(2)
    expect(columns[0].get(rowOf(world, child))).toBe(3)
    expect(columns[1].pages[0]).toBeInstanceOf(Float64Array)
    expect(columns[1].get(rowOf(world, child))).toBe(parent)
    expect(archetypeOf(world, child).column(Attached[$targetField])).toBe(columns[1])

    world.destroy()
  })

  test('a tag relation still gets its target column', () => {
    const world = new World()
    const parent = world.spawn()
    const child = world.spawn(ChildOf(parent))

    const columns = archetypeOf(world, child).columnsOf.get(ChildOf[$id])!
    expect(columns).toHaveLength(1)
    expect(columns[0].get(rowOf(world, child))).toBe(parent)

    world.destroy()
  })

  test("R('*') is a plain archetype match", () => {
    const world = new World()
    const root = world.spawn(Position)
    const a = world.spawn(Position, ChildOf(root))
    const b = world.spawn(Position, ChildOf(a), IsActive)

    const any = world.query(ChildOf('*'))
    expect(maskHas(any[$plan].all, world[$traits].localId(ChildOf))).toBe(true)
    expect(typeof any.chunks).toBe('function')
    expect(sorted(any)).toEqual(sorted([a, b]))
    expect(sorted(world.query(Position, Not(ChildOf('*'))))).toEqual([root])
    expect(world.query(ChildOf)).toBe(any)

    world.destroy()
  })
})

describe('target index (§7.4)', () => {
  test('a target query lists exactly the entities pointing at that target', () => {
    const world = new World()
    const p = world.spawn()
    const q = world.spawn()
    const a = world.spawn(ChildOf(p))
    const b = world.spawn(ChildOf(p))
    const c = world.spawn(ChildOf(q))
    world.spawn()

    expect(sorted(world.query(ChildOf(p)))).toEqual(sorted([a, b]))
    expect(sorted(world.query(ChildOf(q)))).toEqual([c])
    expect(world.query(ChildOf(p)).count).toBe(2)
    expect(world.query(ChildOf(q)).isEmpty).toBe(false)
    expect(world.query(ChildOf(world.spawn())).isEmpty).toBe(true)

    world.destroy()
  })

  test('queryFirst on a target answers without a scan', () => {
    const world = new World()
    const p = world.spawn()
    expect(world.queryFirst(ChildOf(p))).toBeUndefined()

    const child = world.spawn(ChildOf(p))

    expect(world.queryFirst(ChildOf(p))).toBe(child)
    expect(world.query(ChildOf(p)).first).toBe(child)

    world.destroy()
  })

  test('the same target hands back the same cached result, other targets their own', () => {
    const world = new World()
    const p = world.spawn()
    const q = world.spawn()

    const query = world.query(ChildOf(p))
    expect(world.query(ChildOf(p))).toBe(query)
    expect(world.createQuery(ChildOf(p))).toBe(query)
    expect(world.query(ChildOf(q))).not.toBe(query)
    expect(world.query(ChildOf('*'))).not.toBe(query)

    world.destroy()
  })

  test('a result created before any child exists sees the children that arrive', () => {
    const world = new World()
    const p = world.spawn()
    const query = world.query(ChildOf(p))
    expect(query.isEmpty).toBe(true)

    const child = world.spawn(ChildOf(p))

    expect([...query]).toEqual([child])
    expect(query.count).toBe(1)

    world.destroy()
  })

  test('maintained on add, remove and despawn', () => {
    const world = new World()
    const p = world.spawn()
    const a = world.spawn()
    const b = world.spawn()
    const query = world.query(ChildOf(p))

    world.add(a, ChildOf(p))
    world.add(b, ChildOf(p))
    expect(sorted(query)).toEqual(sorted([a, b]))

    world.remove(a, ChildOf(p))
    expect([...query]).toEqual([b])

    world.despawn(b)
    expect(query.isEmpty).toBe(true)
    expect(query.first).toBeUndefined()

    world.destroy()
  })

  test('other terms narrow the indexed list', () => {
    const world = new World()
    const p = world.spawn()
    const plain = world.spawn(ChildOf(p))
    const positioned = world.spawn(ChildOf(p), Position({ x: 4 }))
    world.spawn(Position, ChildOf(world.spawn()))

    const query = world.query(Position, ChildOf(p))
    expect([...query]).toEqual([positioned])
    expect(query.count).toBe(1)
    expect(sorted(world.query(ChildOf(p), Not(Position)))).toEqual([plain])

    const seen: Array<[number, Entity]> = []
    query.each((pos, entity: Entity) => seen.push([pos.x, entity]))
    expect(seen).toEqual([[4, positioned]])

    world.destroy()
  })

  test('an indexed result is materialised: Tier 1 and each, no chunks', () => {
    const world = new World()
    const p = world.spawn()
    const children = [world.spawn(ChildOf(p)), world.spawn(ChildOf(p)), world.spawn(ChildOf(p))]
    const query = world.query(ChildOf(p))

    const visited: Entity[] = []
    query.each((entity: Entity) => visited.push(entity))
    expect(sorted(visited)).toEqual(sorted(children))
    expect(sorted(query.entities())).toEqual(sorted(children))
    expect(query.entities()).toBeInstanceOf(Float64Array)
    expect(() => (query as unknown as { chunks(): unknown }).chunks()).toThrowError(/apecs/)

    world.destroy()
  })

  test('despawning the current entity during an indexed walk is safe (§9)', () => {
    const world = new World()
    const p = world.spawn()
    const children = new Set<Entity>()
    for (let i = 0; i < 5; i++) children.add(world.spawn(ChildOf(p)))

    const visited: Entity[] = []
    world.query(ChildOf(p)).each((entity: Entity) => {
      visited.push(entity)
      world.despawn(entity)
    })

    expect(visited).toHaveLength(5)
    expect(new Set(visited)).toEqual(children)
    expect(world.query(ChildOf(p)).isEmpty).toBe(true)

    world.destroy()
  })

  test('the index survives a row swap-remove in the archetype', () => {
    const world = new World()
    const p = world.spawn()
    const q = world.spawn()
    const a = world.spawn(ChildOf(p))
    const b = world.spawn(ChildOf(q))
    const c = world.spawn(ChildOf(p))

    world.despawn(a) // `c` is swapped into a's row

    expect([...world.query(ChildOf(p))]).toEqual([c])
    expect([...world.query(ChildOf(q))]).toEqual([b])
    expect(world.target(c, ChildOf)).toBe(p)

    world.destroy()
  })
})

describe('re-targeting (§7.4)', () => {
  test('a retarget is a column write plus two index edits, never a transition', () => {
    const world = new World()
    const p = world.spawn()
    const q = world.spawn()
    const child = world.spawn(Position, ChildOf(p))
    const archetype = archetypeOf(world, child)
    const row = rowOf(world, child)
    const created = world[$archetypes].list.length

    world.add(child, ChildOf(q))

    expect(archetypeOf(world, child)).toBe(archetype)
    expect(rowOf(world, child)).toBe(row)
    expect(archetype.rows).toBe(1)
    expect(world[$archetypes].list.length).toBe(created)
    expect(world.target(child, ChildOf)).toBe(q)
    expect(world.query(ChildOf(p)).isEmpty).toBe(true)
    expect([...world.query(ChildOf(q))]).toEqual([child])

    world.destroy()
  })

  test('re-adding the same target is a no-op that keeps the data', () => {
    const world = new World()
    const p = world.spawn()
    const child = world.spawn(Attached(p, { offset: 5 }))

    world.add(child, Attached(p))
    expect(world.get(child, Attached.offset)).toBe(5)
    expect([...world.query(Attached(p))]).toEqual([child])

    world.add(child, Attached(p, { offset: 6 }))
    expect(world.get(child, Attached.offset)).toBe(6)

    world.destroy()
  })

  test('the per-world state is created lazily and only for exclusive relations', () => {
    const world = new World()
    expect(world[$relations].get(ChildOf)).toBeUndefined()

    world.spawn(ChildOf(world.spawn()))

    expect(world[$relations].get(ChildOf)).toBeDefined()

    world.destroy()
  })
})
