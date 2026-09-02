import { describe, expect, test } from 'vitest'

import { Cascade, Changed, Relation, Trait, World, f32 } from '../src/index'
import type { Entity, QueryResult, SortedQueryResult } from '../src/index'
import { $relations, entityId } from '../src/internal'

const Position = new Trait({ x: f32(0) })
const Local = new Trait({ x: f32(0) })
const IsActive = new Trait()
const ChildOf = new Relation(undefined, { exclusive: true })
const Likes = new Relation()

function depthOf(world: World, entity: Entity): number {
  return world[$relations].get(ChildOf)!.depths![entityId(entity)]
}

/** A `Cascade` result is materialised; its surface is the sorted one (SPEC §7.6). */
function dirtyOf(query: QueryResult): string {
  return (query as unknown as SortedQueryResult).isDirty
}

/** A tree spawned children-first so archetype order never coincides with hierarchy order. */
function forest(world: World) {
  const parents = new Map<Entity, Entity>()
  const leaves = Array.from({ length: 6 }, () => world.spawn(Position, IsActive))
  const mids = Array.from({ length: 3 }, () => world.spawn(Position))
  const roots = [world.spawn(Position, Local), world.spawn(Position)]
  leaves.forEach((leaf, i) => {
    world.add(leaf, ChildOf(mids[i % 3]))
    parents.set(leaf, mids[i % 3])
  })
  mids.forEach((mid, i) => {
    world.add(mid, ChildOf(roots[i % 2]))
    parents.set(mid, roots[i % 2])
  })
  return { parents, leaves, mids, roots }
}

function expectParentsFirst(order: readonly Entity[], parents: Map<Entity, Entity>): void {
  const at = new Map(order.map((e, i) => [e, i]))
  for (const [child, parent] of parents) {
    expect(at.has(child)).toBe(true)
    expect(at.has(parent)).toBe(true)
    expect(at.get(parent)!).toBeLessThan(at.get(child)!)
  }
}

describe('ordering (§7.6)', () => {
  test('each visits every parent before any of its children, roots included', () => {
    const world = new World({ pageSize: 4 })
    const { parents } = forest(world)

    const visited: Entity[] = []
    world.query(Position, Cascade(ChildOf)).each((_p, entity: Entity) => visited.push(entity))

    expect(visited).toHaveLength(11)
    expectParentsFirst(visited, parents)

    world.destroy()
  })

  test('Tier 1 and entities() follow the same order', () => {
    const world = new World({ pageSize: 4 })
    const { parents } = forest(world)
    const query = world.query(Position, Cascade(ChildOf))

    expectParentsFirst([...query], parents)
    expectParentsFirst(Array.from(query.entities()) as Entity[], parents)
    expect(query.count).toBe(11)
    expect(query.first).toBeDefined()
    expect(depthOf(world, query.first!)).toBe(0)

    world.destroy()
  })

  test('the query is memoised and a distinct object from the unordered one', () => {
    const world = new World()
    const query = world.query(Position, Cascade(ChildOf))

    expect(world.query(Position, Cascade(ChildOf))).toBe(query)
    expect(world.query(Position)).not.toBe(query)
    expect(world.query(Position, IsActive, Cascade(ChildOf))).not.toBe(query)

    world.destroy()
  })

  test('data terms and tick filters apply as in the unordered query', () => {
    const world = new World()
    const root = world.spawn(Position({ x: 1 }), Local({ x: 10 }))
    const child = world.spawn(Position({ x: 2 }), Local({ x: 20 }), ChildOf(root))
    const query = world.query(Position, Local, Changed(Position), Cascade(ChildOf))

    const seen: number[] = []
    query.each((p, l) => seen.push(p.x + l.x))
    expect(seen).toEqual([11, 22])

    world.step()
    world.set(child, Position.x, 3)
    seen.length = 0
    query.each((p, l) => seen.push(p.x + l.x))
    expect(seen).toEqual([23])

    world.destroy()
  })

  test('a materialised order has no chunks', () => {
    const world = new World()
    const query = world.query(Position, Cascade(ChildOf))

    expect(() => (query as unknown as { chunks(): unknown }).chunks()).toThrowError(/apecs/)

    world.destroy()
  })
})

describe('incremental depth (§7.6)', () => {
  test('depth is target depth plus one, and zero without the relation', () => {
    const world = new World()
    world.query(Cascade(ChildOf))
    const root = world.spawn()
    const mid = world.spawn(ChildOf(root))
    const leaf = world.spawn(ChildOf(mid))

    expect(depthOf(world, root)).toBe(0)
    expect(depthOf(world, mid)).toBe(1)
    expect(depthOf(world, leaf)).toBe(2)

    world.destroy()
  })

  test('a re-parent recomputes the subtree, nothing else', () => {
    const world = new World()
    world.query(Cascade(ChildOf))
    const root = world.spawn()
    const deep = world.spawn(ChildOf(world.spawn(ChildOf(root))))
    const mid = world.spawn(ChildOf(root))
    const leaf = world.spawn(ChildOf(mid))
    const sibling = world.spawn(ChildOf(root))
    expect(depthOf(world, deep)).toBe(2)

    world.add(mid, ChildOf(deep))

    expect(depthOf(world, mid)).toBe(3)
    expect(depthOf(world, leaf)).toBe(4)
    expect(depthOf(world, sibling)).toBe(1)

    world.remove(mid, ChildOf)
    expect(depthOf(world, mid)).toBe(0)
    expect(depthOf(world, leaf)).toBe(1)

    world.destroy()
  })

  test('the first Cascade query computes depths for a hierarchy that already exists', () => {
    const world = new World()
    const { parents } = forest(world)
    expect(world[$relations].get(ChildOf)!.depths).toBeNull()

    const query = world.query(Position, Cascade(ChildOf))

    expectParentsFirst([...query], parents)
    for (const [child, parent] of parents)
      expect(depthOf(world, child)).toBe(depthOf(world, parent) + 1)

    world.destroy()
  })

  test('the order stays valid after re-parenting and despawning', () => {
    const world = new World({ pageSize: 4 })
    const { parents, leaves, mids, roots } = forest(world)
    const query = world.query(Position, Cascade(ChildOf))
    expectParentsFirst([...query], parents)

    world.add(mids[0], ChildOf(leaves[1]))
    parents.set(mids[0], leaves[1])
    expectParentsFirst([...query], parents)

    world.despawn(roots[0])
    for (const [child, parent] of parents) if (parent === roots[0]) parents.delete(child)
    expectParentsFirst([...query], parents)
    expect([...query]).not.toContain(roots[0])

    world.destroy()
  })

  test('depth changes are the only thing that dirties a settled view', () => {
    const world = new World()
    const root = world.spawn(Position)
    const mid = world.spawn(Position, ChildOf(root))
    const child = world.spawn(Position, ChildOf(root))
    const query = world.query(Position, Cascade(ChildOf))
    world.step()
    expect([...query]).toHaveLength(3)
    expect(dirtyOf(query)).toBe('clean')

    world.set(child, Position.x, 5)
    world.step()
    expect(dirtyOf(query)).toBe('clean')

    world.add(child, ChildOf(mid))
    expect(dirtyOf(query)).toBe('resort')
    world.step()
    expect([...query]).toEqual([root, mid, child])
    expect(dirtyOf(query)).toBe('clean')

    world.remove(child, ChildOf)
    expect(dirtyOf(query)).toBe('rebuild')

    world.destroy()
  })

  test('a despawned entity leaves no depth behind for the id that reuses it', () => {
    const world = new World()
    world.query(Cascade(ChildOf))
    const root = world.spawn()
    const child = world.spawn(ChildOf(root))
    expect(depthOf(world, child)).toBe(1)

    world.despawn(child)
    const reborn = world.spawn()

    expect(entityId(reborn)).toBe(entityId(child))
    expect(depthOf(world, reborn)).toBe(0)

    world.destroy()
  })
})

describe('validity (§7.6)', () => {
  test.runIf(__DEV__)('dev throws when a relation edit closes a cycle', () => {
    const world = new World()
    world.query(Cascade(ChildOf))
    const a = world.spawn()
    const b = world.spawn(ChildOf(a))
    const c = world.spawn(ChildOf(b))

    expect(() => world.add(a, ChildOf(c))).toThrowError(/cycle/)
    expect(() => world.add(a, ChildOf(a))).toThrowError(/cycle/)

    world.destroy()
  })

  test.runIf(__DEV__)('dev throws when the first Cascade query finds a cycle', () => {
    const world = new World()
    const a = world.spawn()
    const b = world.spawn(ChildOf(a))
    world.add(a, ChildOf(b))

    expect(() => world.query(Cascade(ChildOf))).toThrowError(/cycle/)

    world.destroy()
  })

  test.runIf(__DEV__)('Cascade rejects a non-exclusive relation', () => {
    expect(() => Cascade(Likes)).toThrowError(/exclusive/)
  })

  test('a ring on an exclusive relation is fine while nothing cascades over it', () => {
    const world = new World()
    const a = world.spawn()
    const b = world.spawn(ChildOf(a))
    const c = world.spawn(ChildOf(b))

    expect(() => world.add(a, ChildOf(c))).not.toThrow()
    expect(world.target(a, ChildOf)).toBe(c)

    world.destroy()
  })

  test.skipIf(__DEV__)('prod terminates on a cycle', () => {
    const world = new World()
    world.query(Cascade(ChildOf))
    const a = world.spawn(Position)
    const b = world.spawn(Position, ChildOf(a))
    world.add(a, ChildOf(b))

    expect(world.query(Position, Cascade(ChildOf)).count).toBe(2)
    expect([...world.query(Position, Cascade(ChildOf))]).toHaveLength(2)

    world.destroy()
  })
})
