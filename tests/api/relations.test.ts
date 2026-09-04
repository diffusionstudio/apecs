/**
 * SPEC §7 — relations: declaration, usage, querying, target lifecycle, and
 * `Cascade` traversal. Public API only.
 */
import { afterEach, describe, expect, test } from 'vitest'

import { Cascade, Not, Relation, Trait, World, f32 } from '../../src/index'
import type { Entity } from '../../src/index'

const Position = new Trait({ x: f32(0), y: f32(0) })
const LocalTransform = new Trait({ x: f32(0) })

const worlds: World[] = []

function makeWorld(options?: ConstructorParameters<typeof World>[0]): World {
  const world = new World(options)
  worlds.push(world)
  return world
}

afterEach(() => {
  for (const world of worlds.splice(0)) world.destroy()
})

describe('declaration (§7.1)', () => {
  test('a relation is a trait', () => {
    const ChildOf = new Relation()

    expect(ChildOf).toBeInstanceOf(Relation)
    expect(ChildOf).toBeInstanceOf(Trait)
    expect(typeof ChildOf).toBe('function')
  })

  test('a tag relation carries no data', () => {
    const ChildOf = new Relation()
    const world = makeWorld()
    const parent = world.spawn()
    const child = world.spawn(ChildOf(parent))

    expect(world.has(child, ChildOf(parent))).toBe(true)
  })

  test('a relation with a schema carries per-pair data', () => {
    const Likes = new Relation({ amount: 0 })
    const world = makeWorld()
    const a = world.spawn()
    const b = world.spawn()
    const me = world.spawn(Likes(a, { amount: 5 }), Likes(b, { amount: 1 }))

    expect(world.get(me, Likes(a))).toEqual({ amount: 5 })
    expect(world.get(me, Likes(b))).toEqual({ amount: 1 })
  })

  test('options are read at declaration', () => {
    const Exclusive = new Relation(undefined, { exclusive: true })
    const world = makeWorld()
    const a = world.spawn()
    const b = world.spawn()
    const child = world.spawn(Exclusive(a))

    world.add(child, Exclusive(b))

    expect(world.target(child, Exclusive)).toBe(b)
    expect(world.has(child, Exclusive(a))).toBe(false)
  })
})

describe('usage (§7.2)', () => {
  const ChildOf = new Relation(undefined, { exclusive: true })
  const Likes = new Relation({ amount: 0 })

  test('add, remove and has address a specific pair', () => {
    const world = makeWorld()
    const parent = world.spawn()
    const other = world.spawn()
    const child = world.spawn(ChildOf(parent))

    expect(world.has(child, ChildOf(parent))).toBe(true)
    expect(world.has(child, ChildOf(other))).toBe(false)

    world.add(child, Likes(other, { amount: 5 }))

    expect(world.has(child, Likes(other))).toBe(true)

    world.remove(child, Likes(other))

    expect(world.has(child, Likes(other))).toBe(false)
    expect(world.has(child, ChildOf(parent))).toBe(true)
  })

  test("has with '*' asks about any target", () => {
    const world = makeWorld()
    const parent = world.spawn()
    const child = world.spawn(ChildOf(parent))
    const orphan = world.spawn()

    expect(world.has(child, ChildOf('*'))).toBe(true)
    expect(world.has(orphan, ChildOf('*'))).toBe(false)
  })

  test('relation data reads and writes like any other trait', () => {
    const world = makeWorld()
    const target = world.spawn()
    const me = world.spawn(Likes(target, { amount: 1 }))

    world.set(me, Likes(target), { amount: 9 })

    expect(world.get(me, Likes(target))).toEqual({ amount: 9 })
  })

  test('an exclusive relation may be retargeted', () => {
    const world = makeWorld()
    const first = world.spawn()
    const second = world.spawn()
    const child = world.spawn(ChildOf(first), Position({ x: 1 }))

    world.add(child, ChildOf(second))

    expect(world.target(child, ChildOf)).toBe(second)
    expect(world.get(child, Position.x)).toBe(1)
  })
})

describe('querying (§7.3)', () => {
  const ChildOf = new Relation(undefined, { exclusive: true })
  const Likes = new Relation({ amount: 0 })

  test('a pair term matches the entities related to that target', () => {
    const world = makeWorld()
    const a = world.spawn()
    const b = world.spawn()
    const first = world.spawn(ChildOf(a))
    const second = world.spawn(ChildOf(a))
    world.spawn(ChildOf(b))

    expect(new Set([...world.query(ChildOf(a))])).toEqual(new Set([first, second]))
    expect(world.query(ChildOf(a)).count).toBe(2)
  })

  test("a '*' term matches every entity that has the relation", () => {
    const world = makeWorld()
    const a = world.spawn()
    const b = world.spawn()
    const children = [world.spawn(ChildOf(a)), world.spawn(ChildOf(b))]

    expect(new Set([...world.query(ChildOf('*'))])).toEqual(new Set(children))
  })

  test("Not over '*' finds the roots", () => {
    const world = makeWorld()
    const root = world.spawn(Position)
    world.spawn(Position, ChildOf(root))

    expect([...world.query(Position, Not(ChildOf('*')))]).toEqual([root])
  })

  test('queryFirst over a pair is the first related entity', () => {
    const world = makeWorld()
    const parent = world.spawn()

    expect(world.queryFirst(ChildOf(parent))).toBeUndefined()

    const child = world.spawn(ChildOf(parent))

    expect(world.queryFirst(ChildOf(parent))).toBe(child)
  })

  test('target returns the one target of an exclusive relation, or 0', () => {
    const world = makeWorld()
    const parent = world.spawn()
    const child = world.spawn(ChildOf(parent))
    const orphan = world.spawn()

    expect(world.target(child, ChildOf)).toBe(parent)
    expect(world.target(orphan, ChildOf)).toBe(0)
  })

  test('targets iterates every target of a non-exclusive relation', () => {
    const world = makeWorld()
    const a = world.spawn()
    const b = world.spawn()
    const me = world.spawn(Likes(a), Likes(b))

    expect(new Set(world.targets(me, Likes))).toEqual(new Set([a, b]))
    expect(world.targets(world.spawn(), Likes)).toEqual([])
  })

  test('targets on an exclusive relation is the single target as a list', () => {
    const world = makeWorld()
    const parent = world.spawn()
    const child = world.spawn(ChildOf(parent))

    expect(world.targets(child, ChildOf)).toEqual([parent])
    expect(world.targets(world.spawn(), ChildOf)).toEqual([])
  })

  test.runIf(__DEV__)('target rejects a non-exclusive relation', () => {
    const world = makeWorld()
    const entity = world.spawn(Likes(world.spawn()))

    expect(() => world.target(entity, Likes)).toThrow()
  })

  test('a relation query is a valid batch', () => {
    const world = makeWorld()
    const parent = world.spawn()
    world.spawnMany(5, ChildOf(parent))

    world.despawnMany(world.query(ChildOf(parent)))

    expect(world.query(ChildOf(parent)).count).toBe(0)
  })
})

describe('storage strategy is invisible (§7.4)', () => {
  test('an exclusive relation scales over many distinct targets', () => {
    const ChildOf = new Relation(undefined, { exclusive: true })
    const world = makeWorld()
    const parents = world.spawnMany(500)
    const children: Entity[] = []
    for (const parent of parents) children.push(world.spawn(ChildOf(parent as Entity)))

    expect(world.query(ChildOf('*')).count).toBe(500)
    for (let i = 0; i < 500; i++) {
      expect(world.target(children[i], ChildOf)).toBe(parents[i])
      expect(world.query(ChildOf(parents[i] as Entity)).count).toBe(1)
    }
  })

  test('retargeting keeps the rest of the entity intact', () => {
    const ChildOf = new Relation(undefined, { exclusive: true })
    const world = makeWorld()
    const a = world.spawn()
    const b = world.spawn()
    const child = world.spawn(ChildOf(a), Position({ x: 3, y: 4 }))

    for (let i = 0; i < 10; i++) world.add(child, ChildOf(i % 2 === 0 ? b : a))

    expect(world.get(child, Position)).toEqual({ x: 3, y: 4 })
    expect(world.query(ChildOf('*')).count).toBe(1)
  })

  test('a non-exclusive relation supports many targets on one entity', () => {
    const Owes = new Relation({ amount: 0 })
    const world = makeWorld()
    const creditors = world.spawnMany(20)
    const debtor = world.spawn()

    for (let i = 0; i < creditors.length; i++)
      world.add(debtor, Owes(creditors[i] as Entity, { amount: i }))

    expect(world.targets(debtor, Owes)).toHaveLength(20)
    for (let i = 0; i < creditors.length; i++)
      expect(world.get(debtor, Owes(creditors[i] as Entity))).toEqual({ amount: i })
  })
})

describe('target lifecycle (§7.5)', () => {
  test("'remove' is the default — the relation goes, the source stays", () => {
    const ChildOf = new Relation(undefined, { exclusive: true })
    const world = makeWorld()
    const parent = world.spawn()
    const child = world.spawn(ChildOf(parent), Position)

    world.despawn(parent)

    expect(world.isAlive(child)).toBe(true)
    expect(world.has(child, ChildOf('*'))).toBe(false)
    expect(world.target(child, ChildOf)).toBe(0)
    expect(world.has(child, Position)).toBe(true)
  })

  test("'remove' applies to non-exclusive relations too", () => {
    const Likes = new Relation({ amount: 0 })
    const world = makeWorld()
    const a = world.spawn()
    const b = world.spawn()
    const me = world.spawn(Likes(a), Likes(b))

    world.despawn(a)

    expect(world.targets(me, Likes)).toEqual([b])
  })

  test("'despawn' takes the source down with the target, recursively", () => {
    const ChildOf = new Relation(undefined, { exclusive: true, onTargetDespawn: 'despawn' })
    const world = makeWorld()
    const root = world.spawn()
    const child = world.spawn(ChildOf(root))
    const grandchild = world.spawn(ChildOf(child))

    world.despawn(root)

    expect(world.isAlive(child)).toBe(false)
    expect(world.isAlive(grandchild)).toBe(false)
  })

  test("'despawn' handles a deep chain without blowing the stack", () => {
    const ChildOf = new Relation(undefined, { exclusive: true, onTargetDespawn: 'despawn' })
    const world = makeWorld()
    const root = world.spawn()
    let parent = root
    const chain: Entity[] = []
    for (let i = 0; i < 20_000; i++) chain.push((parent = world.spawn(ChildOf(parent))))

    expect(() => world.despawn(root)).not.toThrow()
    expect(world.query(ChildOf('*')).count).toBe(0)
    expect(world.isAlive(chain[chain.length - 1])).toBe(false)
  })

  test("'orphan' keeps the relation pointing at a dead target", () => {
    const Watches = new Relation(undefined, { exclusive: true, onTargetDespawn: 'orphan' })
    const world = makeWorld()
    const target = world.spawn()
    const watcher = world.spawn(Watches(target))

    world.despawn(target)

    expect(world.isAlive(watcher)).toBe(true)
    expect(world.target(watcher, Watches)).toBe(target)
    expect(world.isAlive(world.target(watcher, Watches))).toBe(false)
  })

  test('despawning the source leaves the target alone', () => {
    const ChildOf = new Relation(undefined, { exclusive: true, onTargetDespawn: 'despawn' })
    const world = makeWorld()
    const parent = world.spawn()
    const child = world.spawn(ChildOf(parent))

    world.despawn(child)

    expect(world.isAlive(parent)).toBe(true)
  })
})

describe('Cascade (§7.6)', () => {
  const ChildOf = new Relation(undefined, { exclusive: true })

  /** Builds a three-level tree and returns it depth by depth. */
  function tree(world: World): Entity[][] {
    const roots = [world.spawn(LocalTransform), world.spawn(LocalTransform)]
    const mid = roots.map((root) => world.spawn(LocalTransform, ChildOf(root)))
    const leaves = mid.map((parent) => world.spawn(LocalTransform, ChildOf(parent)))
    return [roots, mid, leaves]
  }

  test('parents are visited before their children', () => {
    const world = makeWorld()
    const levels = tree(world)
    const depthOf = new Map<Entity, number>()
    levels.forEach((level, depth) => level.forEach((entity) => depthOf.set(entity, depth)))
    const seen: number[] = []

    world.query(LocalTransform, Cascade(ChildOf)).each((_t, e) => seen.push(depthOf.get(e)!))

    expect(seen).toHaveLength(6)
    expect(seen.slice().sort()).toEqual(seen)
  })

  test('the order survives a re-parent', () => {
    const world = makeWorld()
    const [roots, mid, leaves] = tree(world)
    const query = world.query(LocalTransform, Cascade(ChildOf))
    void [...query]

    world.add(leaves[0], ChildOf(roots[1]))

    const order = [...query]
    const at = (entity: Entity) => order.indexOf(entity)

    expect(at(roots[1])).toBeLessThan(at(leaves[0]))
    expect(at(roots[0])).toBeLessThan(at(mid[0]))
  })

  test('a cascade query is tier 1 and each, not chunks', () => {
    const world = makeWorld()
    tree(world)
    const query = world.query(LocalTransform, Cascade(ChildOf))

    expect(query.count).toBe(6)
    expect(() => (query as unknown as { chunks(): void }).chunks()).toThrow()
  })

  test('a single-level set cascades in one flat pass', () => {
    const world = makeWorld()
    const roots = world.spawnMany(10, LocalTransform)

    expect(world.query(LocalTransform, Cascade(ChildOf)).count).toBe(roots.length)
  })
})
