import { describe, expect, test } from 'vitest'

import { Relation, Trait, World } from '../src/index'
import type { Entity } from '../src/index'
import { NULL_ENTITY } from '../src/internal'

const Position = new Trait({ x: 0 })
const ChildOf = new Relation(undefined, { exclusive: true })
const Attached = new Relation({ offset: 0, slot: { index: 0 } }, { exclusive: true })
const Likes = new Relation({ amount: 0 })
const Owes = new Relation()

function sorted(entities: Iterable<number>): number[] {
  return [...entities].sort((a, b) => a - b)
}

describe('add / remove / has with a target (§7.2)', () => {
  test('exclusive: has answers for the exact target, the wildcard and the bare relation', () => {
    const world = new World()
    const p = world.spawn()
    const q = world.spawn()
    const child = world.spawn()

    expect(world.has(child, ChildOf)).toBe(false)
    expect(world.has(child, ChildOf('*'))).toBe(false)

    world.add(child, ChildOf(p))

    expect(world.has(child, ChildOf(p))).toBe(true)
    expect(world.has(child, ChildOf(q))).toBe(false)
    expect(world.has(child, ChildOf('*'))).toBe(true)
    expect(world.has(child, ChildOf)).toBe(true)

    world.destroy()
  })

  test('exclusive: remove with the wrong target is a no-op', () => {
    const world = new World()
    const p = world.spawn()
    const q = world.spawn()
    const child = world.spawn(ChildOf(p))

    world.remove(child, ChildOf(q))
    expect(world.has(child, ChildOf(p))).toBe(true)

    world.remove(child, ChildOf(p))
    expect(world.has(child, ChildOf)).toBe(false)

    world.destroy()
  })

  test('exclusive: the wildcard and the bare relation remove whatever the target is', () => {
    const world = new World()
    const p = world.spawn()
    const a = world.spawn(Position, ChildOf(p))
    const b = world.spawn(Position, ChildOf(p))

    world.remove(a, ChildOf('*'))
    world.remove(b, ChildOf)

    expect(world.has(a, ChildOf)).toBe(false)
    expect(world.has(b, ChildOf)).toBe(false)
    expect(world.has(a, Position)).toBe(true)
    expect(world.query(ChildOf(p)).isEmpty).toBe(true)

    world.destroy()
  })

  test('non-exclusive: pairs come and go independently', () => {
    const world = new World()
    const a = world.spawn()
    const b = world.spawn()
    const e = world.spawn(Likes(a), Likes(b))

    expect(world.has(e, Likes(a))).toBe(true)
    expect(world.has(e, Likes(b))).toBe(true)
    expect(world.has(e, Likes('*'))).toBe(true)
    expect(world.has(e, Likes)).toBe(true)

    world.remove(e, Likes(a))
    expect(world.has(e, Likes(a))).toBe(false)
    expect(world.has(e, Likes(b))).toBe(true)
    expect(world.has(e, Likes('*'))).toBe(true)

    world.remove(e, Likes(b))
    expect(world.has(e, Likes('*'))).toBe(false)
    expect(world.has(e, Likes)).toBe(false)

    world.destroy()
  })

  test('non-exclusive: the wildcard and the bare relation remove every pair', () => {
    const world = new World()
    const a = world.spawn()
    const b = world.spawn()
    const x = world.spawn(Position, Likes(a), Likes(b))
    const y = world.spawn(Position, Likes(a), Likes(b))

    world.remove(x, Likes('*'))
    world.remove(y, Likes)

    expect(world.has(x, Likes('*'))).toBe(false)
    expect(world.has(y, Likes('*'))).toBe(false)
    expect(world.has(x, Position)).toBe(true)
    expect(world.query(Likes(a)).isEmpty).toBe(true)

    world.destroy()
  })

  test('adding a pair the entity already holds keeps it and re-seeds only when a value is given', () => {
    const world = new World()
    const a = world.spawn()
    const e = world.spawn(Likes(a, { amount: 4 }))

    world.add(e, Likes(a))
    expect(world.get(e, Likes(a))).toEqual({ amount: 4 })

    world.add(e, Likes(a, { amount: 8 }))
    expect(world.get(e, Likes(a))).toEqual({ amount: 8 })
    expect(world.query(Likes(a)).count).toBe(1)

    world.destroy()
  })

  test('bulk operations take relation instances', () => {
    const world = new World()
    const p = world.spawn()
    const a = world.spawn()

    const batch = world.spawnMany(3, ChildOf(p), Likes(a, { amount: 2 }))
    expect(world.query(ChildOf(p)).count).toBe(3)
    expect(world.query(Likes(a)).count).toBe(3)
    expect(world.get(batch[1] as Entity, Likes(a))).toEqual({ amount: 2 })
    expect(world.target(batch[2] as Entity, ChildOf)).toBe(p)

    world.removeMany(batch, ChildOf, Likes(a))
    expect(world.query(ChildOf(p)).isEmpty).toBe(true)
    expect(world.query(Likes('*')).isEmpty).toBe(true)

    world.addMany(batch, Owes(a))
    expect(world.query(Owes(a)).count).toBe(3)

    world.destroy()
  })
})

describe('target and targets (§7.3)', () => {
  test('target reads the one target of an exclusive relation', () => {
    const world = new World()
    const p = world.spawn()
    const child = world.spawn(ChildOf(p))
    const orphan = world.spawn()

    expect(world.target(child, ChildOf)).toBe(p)
    expect(world.target(orphan, ChildOf)).toBe(NULL_ENTITY)

    world.remove(child, ChildOf)
    expect(world.target(child, ChildOf)).toBe(NULL_ENTITY)

    world.destroy()
  })

  test('targets iterates every target of a non-exclusive relation', () => {
    const world = new World()
    const a = world.spawn()
    const b = world.spawn()
    const c = world.spawn()
    const e = world.spawn(Likes(a), Likes(b), Owes(c))

    expect(sorted(world.targets(e, Likes))).toEqual(sorted([a, b]))
    expect([...world.targets(e, Owes)]).toEqual([c])
    expect([...world.targets(world.spawn(), Likes)]).toEqual([])

    world.remove(e, Likes(a))
    expect([...world.targets(e, Likes)]).toEqual([b])

    world.destroy()
  })

  test('targets on an exclusive relation yields the single target', () => {
    const world = new World()
    const p = world.spawn()
    const child = world.spawn(ChildOf(p))

    expect([...world.targets(child, ChildOf)]).toEqual([p])
    expect([...world.targets(world.spawn(), ChildOf)]).toEqual([])

    world.destroy()
  })
})

describe('relation data (§7.2, §7.3)', () => {
  test('a pair carries its own struct, seeded from the defaults', () => {
    const world = new World()
    const a = world.spawn()
    const b = world.spawn()
    const e = world.spawn(Likes(a), Likes(b, { amount: 7 }))

    expect(world.get(e, Likes(a))).toEqual({ amount: 0 })
    expect(world.get(e, Likes(b))).toEqual({ amount: 7 })

    world.set(e, Likes(a), { amount: 3 })
    expect(world.get(e, Likes(a))).toEqual({ amount: 3 })
    expect(world.get(e, Likes(b))).toEqual({ amount: 7 })

    const out = { amount: -1 }
    expect(world.get(e, Likes(b), out)).toBe(out)
    expect(out.amount).toBe(7)

    world.destroy()
  })

  test('exclusive relation data is addressable by trait, pair and field', () => {
    const world = new World()
    const p = world.spawn()
    const e = world.spawn(Attached(p, { offset: 2, slot: { index: 1 } }))

    expect(world.get(e, Attached)).toEqual({ offset: 2, slot: { index: 1 } })
    expect(world.get(e, Attached(p))).toEqual({ offset: 2, slot: { index: 1 } })
    expect(world.get(e, Attached.offset)).toBe(2)
    expect(world.get(e, Attached['slot.index'])).toBe(1)

    world.set(e, Attached.offset, 9)
    world.set(e, Attached(p), { slot: { index: 5 } })
    expect(world.get(e, Attached)).toEqual({ offset: 9, slot: { index: 5 } })

    world.destroy()
  })

  test('exclusive relation data rides through each and chunks like a trait', () => {
    const world = new World()
    const p = world.spawn()
    const e = world.spawn(Attached(p, { offset: 1 }))

    world.query(Attached('*')).each((attached) => {
      attached.offset += 10
    })
    expect(world.get(e, Attached.offset)).toBe(11)

    for (const chunk of world.query(Attached).chunks()) {
      chunk.get(Attached).offset[0] += 1
    }
    expect(world.get(e, Attached.offset)).toBe(12)

    world.destroy()
  })

  test('the target column survives a move between archetypes', () => {
    const world = new World()
    const p = world.spawn()
    const e = world.spawn(Attached(p, { offset: 4 }))

    world.add(e, Position)
    expect(world.target(e, Attached)).toBe(p)
    expect(world.get(e, Attached.offset)).toBe(4)

    world.remove(e, Position)
    expect(world.target(e, Attached)).toBe(p)
    expect([...world.query(Attached(p))]).toEqual([e])

    world.destroy()
  })
})

describe.runIf(__DEV__)('dev validation (§7.2)', () => {
  test('a wildcard cannot be added', () => {
    const world = new World()
    const e = world.spawn()

    expect(() => world.add(e, ChildOf('*'))).toThrowError(/apecs/)
    expect(() => world.spawn(Likes('*'))).toThrowError(/apecs/)

    world.destroy()
  })

  test('a non-exclusive relation needs a target to read or write data', () => {
    const world = new World()
    const a = world.spawn()
    const e = world.spawn(Likes(a))

    expect(() => world.get(e, Likes)).toThrowError(/apecs/)
    expect(() => world.get(e, Likes.amount)).toThrowError(/apecs/)
    expect(() => world.set(e, Likes, { amount: 1 })).toThrowError(/apecs/)

    world.destroy()
  })

  test('a target must be a live entity of this world', () => {
    const world = new World()
    const other = new World()
    const foreign = other.spawn()
    const dead = world.spawn()
    world.despawn(dead)

    expect(() => world.spawn(ChildOf(foreign))).toThrowError(/apecs/)
    expect(() => world.spawn(ChildOf(dead))).toThrowError(/apecs/)
    expect(() => world.spawn(Likes(dead))).toThrowError(/apecs/)

    other.destroy()
    world.destroy()
  })
})
