import { describe, expect, test } from 'vitest'

import { Changed, Relation, Trait, World, eid } from '../src/index'
import type { Entity } from '../src/index'
import { $archetypes, NULL_ENTITY } from '../src/internal'
import { columnOf } from './support/columns'

const Following = new Trait({ target: eid(0), speed: 1 })
const Nested = new Trait({ link: { to: eid(0) } })
const SparseRef = new Trait({ to: eid(0) }, { storage: 'sparse' })
const Bare = new Trait({ target: 0 })
const IsActive = new Trait()
const Orbits = new Relation(undefined, { exclusive: true, onTargetDespawn: 'orphan' })

describe('reverse index of eid columns (§8.5)', () => {
  test('every eid column is registered as it is created; nothing else is', () => {
    const world = new World()
    const refs = world[$archetypes].refs
    expect(refs).toHaveLength(0)

    const a = world.spawn(Following, Bare)
    expect(refs).toContain(columnOf(world, a, Following.target))
    expect(refs).not.toContain(columnOf(world, a, Bare.target))
    expect(refs).not.toContain(columnOf(world, a, Following.speed))

    const b = world.spawn(Following, IsActive, Nested)
    expect(refs).toContain(columnOf(world, b, Following.target))
    expect(refs).toContain(columnOf(world, b, Nested['link.to']))
    for (const column of refs) expect(column.field.kind).toBe('eid')

    const registered = refs.length
    world.spawn(Orbits(world.spawn()))
    expect(refs).toHaveLength(registered)

    world.destroy()
  })
})

describe('patching on despawn (§8.5)', () => {
  test('a stored handle is replaced by NULL_ENTITY when its entity dies', () => {
    const world = new World()
    const leader = world.spawn()
    const follower = world.spawn(Following({ target: leader, speed: 3 }))
    expect(world.get(follower, Following.target)).toBe(leader)

    world.despawn(leader)

    expect(world.get(follower, Following.target)).toBe(NULL_ENTITY)
    expect(world.get(follower, Following.speed)).toBe(3)

    world.destroy()
  })

  test('every reference is patched, across archetypes, pages and nesting', () => {
    const world = new World({ pageSize: 4 })
    const leader = world.spawn()
    const flat: Entity[] = []
    for (let i = 0; i < 9; i++) flat.push(world.spawn(Following({ target: leader })))
    const tagged = world.spawn(Following({ target: leader }), IsActive)
    const nested = world.spawn(Nested({ link: { to: leader } }))
    const bystander = world.spawn(Following({ target: tagged }))

    world.despawn(leader)

    for (const e of flat) expect(world.get(e, Following.target)).toBe(NULL_ENTITY)
    expect(world.get(tagged, Following.target)).toBe(NULL_ENTITY)
    expect(world.get(nested, Nested)).toEqual({ link: { to: NULL_ENTITY } })
    expect(world.get(bystander, Following.target)).toBe(tagged)

    world.destroy()
  })

  test('sparse eid columns are patched too', () => {
    const world = new World()
    const leader = world.spawn()
    const e = world.spawn(SparseRef({ to: leader }))

    world.despawn(leader)

    expect(world.get(e, SparseRef.to)).toBe(NULL_ENTITY)

    world.destroy()
  })

  test('a handle written after spawn is patched as well', () => {
    const world = new World()
    const leader = world.spawn()
    const e = world.spawn(Following)
    const f = world.spawn(Following)
    world.set(e, Following.target, leader)
    world.query(Following).each((following) => {
      following.target = leader
    })

    world.despawn(leader)

    expect(world.get(e, Following.target)).toBe(NULL_ENTITY)
    expect(world.get(f, Following.target)).toBe(NULL_ENTITY)

    world.destroy()
  })

  test('the patch is a tracked write', () => {
    const world = new World()
    const leader = world.spawn()
    const follower = world.spawn(Following({ target: leader }))
    const changed = world.query(Following, Changed(Following))
    changed.each(() => {})
    world.step()

    world.despawn(leader)

    const seen: Entity[] = []
    changed.each((_f, entity: Entity) => seen.push(entity))
    expect(seen).toEqual([follower])
    expect(columnOf(world, follower, Following.target).lastWriteTick).toBe(world.tick)

    world.destroy()
  })

  test('a bare 0 field holding a handle is not patched', () => {
    const world = new World()
    const leader = world.spawn()
    const e = world.spawn(Bare({ target: leader }))

    world.despawn(leader)

    expect(world.get(e, Bare.target)).toBe(leader)
    expect(world.isAlive(world.get(e, Bare.target) as Entity)).toBe(false)

    world.destroy()
  })

  test('a relation target column is not an eid reference', () => {
    const world = new World()
    const sun = world.spawn()
    const planet = world.spawn(Orbits(sun))

    world.despawn(sun)

    expect(world.target(planet, Orbits)).toBe(sun)

    world.destroy()
  })

  test('a recycled id does not match the stale handle it replaced', () => {
    const world = new World()
    const first = world.spawn()
    const e = world.spawn(Following({ target: first }))
    world.despawn(first)
    const reborn = world.spawn()
    const f = world.spawn(Following({ target: reborn }))

    world.despawn(reborn)

    expect(world.get(e, Following.target)).toBe(NULL_ENTITY)
    expect(world.get(f, Following.target)).toBe(NULL_ENTITY)

    world.destroy()
  })

  test('a despawn with no referrers leaves other references alone', () => {
    const world = new World()
    const leader = world.spawn()
    const e = world.spawn(Following({ target: leader }))

    world.despawn(world.spawn())

    expect(world.get(e, Following.target)).toBe(leader)

    world.destroy()
  })
})
