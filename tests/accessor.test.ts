/**
 * T8.1 – T8.3 — `world.accessor`: a field resolved once, read and written by
 * entity handle afterwards (SPEC §4.5). Every value it hands back must equal
 * what `world.get` says, before and after anything that moves rows.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'

import { Changed, Relation, Trait, World, bool, eid, f32, i8, str, u16 } from '../src/index'
import type { Entity } from '../src/index'
import { $id, packEntity, resetWarnOnce } from '../src/internal'
import { CAN_MEASURE_HEAP, bytesPerPass } from './support/heap'
import { columnOf, rowOf } from './support/columns'

const Position = new Trait({ x: f32(0), y: f32(0) })
const Velocity = new Trait({ x: f32(0), y: f32(0) })
const Kinds = new Trait({
  small: i8(-3),
  wide: u16(9),
  flag: bool(false),
  name: str('none'),
  ref: eid(0),
  plain: 1.5,
})
const Transform = new Trait({ pos: { x: 0, y: 0 }, scale: 1 })
const Mesh = new Trait(() => ({ n: 0 }))
const Level = new Trait({ value: 0 }, { track: true })
const IsActive = new Trait()
const Attached = new Relation({ offset: 0 }, { exclusive: true })
const Likes = new Relation({ amount: 0 })

const devOnly = test.runIf(__DEV__)

afterEach(() => {
  vi.restoreAllMocks()
  resetWarnOnce()
})

describe('get / set parity with world.get / world.set (§4.5, §3.3)', () => {
  test('a numeric field reads and writes the same column', () => {
    const world = new World()
    const a = world.spawn(Position({ x: 1, y: 2 }))
    const b = world.spawn(Position({ x: 3, y: 4 }))
    const px = world.accessor(Position.x)

    expect(px.get(a)).toBe(1)
    expect(px.get(b)).toBe(3)

    px.set(a, 10)

    expect(px.get(a)).toBe(10)
    expect(world.get(a, Position.x)).toBe(10)
    expect(world.get(a, Position.y)).toBe(2)
    expect(world.get(b, Position)).toEqual({ x: 3, y: 4 })

    world.set(b, Position.x, 30)

    expect(px.get(b)).toBe(30)

    world.destroy()
  })

  test('every field kind decodes as world.get does', () => {
    const world = new World()
    const target = world.spawn()
    const e = world.spawn(Kinds({ flag: true, ref: target }))
    const small = world.accessor(Kinds.small)
    const wide = world.accessor(Kinds.wide)
    const flag = world.accessor(Kinds.flag)
    const name = world.accessor(Kinds.name)
    const ref = world.accessor(Kinds.ref)
    const plain = world.accessor(Kinds.plain)

    expect(small.get(e)).toBe(-3)
    expect(wide.get(e)).toBe(9)
    expect(flag.get(e)).toBe(true)
    expect(name.get(e)).toBe('none')
    expect(ref.get(e)).toBe(target)
    expect(plain.get(e)).toBe(1.5)

    small.set(e, 200)
    wide.set(e, 70000)
    flag.set(e, false)
    name.set(e, 'hero')
    ref.set(e, e)
    plain.set(e, 2.25)

    expect(small.get(e)).toBe(world.get(e, Kinds.small))
    expect(wide.get(e)).toBe(world.get(e, Kinds.wide))
    expect(flag.get(e)).toBe(false)
    expect(world.get(e, Kinds.flag)).toBe(false)
    expect(name.get(e)).toBe('hero')
    expect(ref.get(e)).toBe(e)
    expect(plain.get(e)).toBe(2.25)
    expect(world.get(e, Kinds)).toEqual({
      small: world.get(e, Kinds.small),
      wide: world.get(e, Kinds.wide),
      flag: false,
      name: 'hero',
      ref: e,
      plain: 2.25,
    })

    world.destroy()
  })

  test('a nested field addresses exactly its column', () => {
    const world = new World()
    const e = world.spawn(Transform({ pos: { x: 3, y: 4 }, scale: 2 }))
    const py = world.accessor(Transform['pos.y'])

    expect(py.get(e)).toBe(4)

    py.set(e, 9)

    expect(world.get(e, Transform)).toEqual({ pos: { x: 3, y: 9 }, scale: 2 })

    world.destroy()
  })

  test('an AoS trait is its own field: the accessor hands back the reference', () => {
    const world = new World()
    const mesh = { n: 7 }
    const e = world.spawn(Mesh(mesh))
    const meshes = world.accessor(Mesh)

    expect(meshes.get(e)).toBe(mesh)

    const replacement = { n: 8 }
    meshes.set(e, replacement)

    expect(meshes.get(e)).toBe(replacement)
    expect(world.get(e, Mesh)).toBe(replacement)

    world.destroy()
  })

  test("an exclusive relation's field reads the data stored beside its target", () => {
    const world = new World()
    const p = world.spawn()
    const q = world.spawn()
    const child = world.spawn(Attached(p, { offset: 5 }))
    const offset = world.accessor(Attached.offset)

    expect(offset.get(child)).toBe(5)

    offset.set(child, 6)

    expect(world.get(child, Attached.offset)).toBe(6)

    // Retargeting moves the row; the accessor still finds it.
    world.add(child, Attached(q, { offset: 7 }))

    expect(offset.get(child)).toBe(7)
    expect(world.target(child, Attached)).toBe(q)

    world.destroy()
  })

  test('an accessor is memoised per field (§4.5)', () => {
    const world = new World()

    expect(world.accessor(Position.x)).toBe(world.accessor(Position.x))
    expect(world.accessor(Position.x)).not.toBe(world.accessor(Position.y))
    expect(world.accessor(Mesh)).toBe(world.accessor(Mesh))

    const other = new World()

    expect(other.accessor(Position.x)).not.toBe(world.accessor(Position.x))

    other.destroy()
    world.destroy()
  })

  devOnly('dev rejects subjects with no single value to hand back', () => {
    const world = new World()

    expect(() => world.accessor(IsActive as never)).toThrowError(/tag/)
    expect(() => world.accessor(Position as never)).toThrowError(/field/)
    expect(() => world.accessor(Likes.amount)).toThrowError(/non-exclusive relation/)

    world.destroy()
  })
})

describe('the accessor follows the entity (§4.5, §10.2)', () => {
  test('across archetype moves in both directions', () => {
    const world = new World()
    const e = world.spawn(Position({ x: 1 }))
    const px = world.accessor(Position.x)

    expect(px.get(e)).toBe(1)

    world.add(e, Velocity)
    expect(px.get(e)).toBe(1)
    px.set(e, 2)

    world.add(e, IsActive)
    expect(px.get(e)).toBe(2)

    world.remove(e, Velocity, IsActive)
    expect(px.get(e)).toBe(2)
    expect(world.get(e, Position.x)).toBe(2)

    world.destroy()
  })

  test('when a swap-remove relocates the row', () => {
    const world = new World()
    const px = world.accessor(Position.x)
    const spawned: Entity[] = []
    for (let i = 0; i < 10; i++) spawned.push(world.spawn(Position({ x: i })))

    world.despawn(spawned[0])
    world.despawn(spawned[4])

    for (let i = 0; i < 10; i++) {
      if (i === 0 || i === 4) continue
      expect(px.get(spawned[i])).toBe(i)
    }

    world.destroy()
  })

  test('when a recycled id lands in a different archetype', () => {
    const world = new World()
    const px = world.accessor(Position.x)
    const first = world.spawn(Position({ x: 1 }), Velocity)

    expect(px.get(first)).toBe(1)

    world.despawn(first)
    const second = world.spawn(Position({ x: 2 }))

    expect(second).not.toBe(first)
    expect(px.get(second)).toBe(2)

    world.destroy()
  })

  test('through pages appended after the accessor first resolved', () => {
    const world = new World({ pageSize: 4 })
    const px = world.accessor(Position.x)
    const first = world.spawn(Position({ x: 0 }))

    expect(px.get(first)).toBe(0)

    const more: Entity[] = []
    for (let i = 1; i < 20; i++) more.push(world.spawn(Position({ x: i })))

    for (let i = 1; i < 20; i++) expect(px.get(more[i - 1])).toBe(i)
    expect(px.get(first)).toBe(0)

    world.destroy()
  })

  test('through compact() and the pages a later spawn puts back', () => {
    const world = new World({ pageSize: 4 })
    const px = world.accessor(Position.x)
    const spawned: Entity[] = []
    for (let i = 0; i < 12; i++) spawned.push(world.spawn(Position({ x: i })))

    expect(px.get(spawned[11])).toBe(11)

    for (let i = 4; i < 12; i++) world.despawn(spawned[i])
    world.compact()

    expect(px.get(spawned[2])).toBe(2)

    const again = world.spawn(Position({ x: 40 }))
    const more: Entity[] = []
    for (let i = 0; i < 6; i++) more.push(world.spawn(Position({ x: 50 + i })))

    expect(px.get(again)).toBe(40)
    for (let i = 0; i < 6; i++) expect(px.get(more[i])).toBe(50 + i)

    world.destroy()
  })

  test('through clear()', () => {
    const world = new World()
    const px = world.accessor(Position.x)
    world.spawn(Position({ x: 1 }))

    world.clear()
    const e = world.spawn(Position({ x: 2 }))

    expect(px.get(e)).toBe(2)

    world.destroy()
  })

  test('archetypes created after the accessor, in any order', () => {
    const world = new World()
    const px = world.accessor(Position.x)
    const a = world.spawn(Position({ x: 1 }), Velocity)
    const b = world.spawn(Position({ x: 2 }))
    const c = world.spawn(Position({ x: 3 }), IsActive)
    const d = world.spawn(Position({ x: 4 }), Velocity, IsActive)

    expect([px.get(d), px.get(b), px.get(a), px.get(c)]).toEqual([4, 2, 1, 3])

    px.set(c, 30)

    expect(world.get(c, Position.x)).toBe(30)
    expect(px.get(a)).toBe(1)

    world.destroy()
  })

  test('the world entity is addressable like any other (§5.4)', () => {
    const world = new World()
    world.add(Position({ x: 5 }))
    const px = world.accessor(Position.x)

    expect(px.get(world.entity)).toBe(5)

    px.set(world.entity, 6)

    expect(world.get(Position.x)).toBe(6)

    world.destroy()
  })
})

describe('set is a real write (§4.5, §8.1, §8.3)', () => {
  test('stamps the row tick and the column scalar', () => {
    const world = new World()
    const e = world.spawn(Level)
    const value = world.accessor(Level.value)
    world.step()

    value.set(e, 1)

    const column = columnOf(world, e, Level.value)
    expect(column.ticks![0][rowOf(world, e)]).toBe(world.tick)
    expect(column.lastWriteTick).toBe(world.tick)

    world.destroy()
  })

  test('stamps a column promoted to tracked after the accessor resolved', () => {
    const world = new World()
    const e = world.spawn(Position)
    const px = world.accessor(Position.x)
    px.set(e, 1)
    const query = world.query(Position, Changed(Position))
    query.each(() => {})
    world.step()

    px.set(e, 2)

    const seen: Entity[] = []
    query.each((_p, entity) => seen.push(entity))
    expect(seen).toEqual([e])

    world.destroy()
  })

  test('is seen by Changed() and fires onChange', () => {
    const world = new World()
    const a = world.spawn(Position)
    const b = world.spawn(Position)
    const px = world.accessor(Position.x)
    const changed: Entity[] = []
    world.onChange(Position, (entity) => changed.push(entity))
    const query = world.query(Position, Changed(Position))
    query.each(() => {})
    world.step()

    px.set(b, 1)

    const seen: Entity[] = []
    query.each((_p, entity) => seen.push(entity))
    expect(seen).toEqual([b])
    expect(changed).toEqual([b])
    expect(a).not.toBe(b)

    world.destroy()
  })

  test('get is not a write', () => {
    const world = new World()
    const e = world.spawn(Position)
    const px = world.accessor(Position.x)
    let calls = 0
    world.onChange(Position, () => calls++)
    const query = world.query(Position, Changed(Position))
    query.each(() => {})
    world.step()

    px.get(e)

    expect(calls).toBe(0)
    expect(query.count).toBe(1)
    let seen = 0
    query.each(() => seen++)
    expect(seen).toBe(0)

    world.destroy()
  })

  test("an exclusive relation's onChange carries the target", () => {
    const world = new World()
    const p = world.spawn()
    const child = world.spawn(Attached(p))
    const offset = world.accessor(Attached.offset)
    const seen: [Entity, Entity | undefined][] = []
    world.onChange(Attached, (entity, target) => seen.push([entity, target]))

    offset.set(child, 3)

    expect(seen).toEqual([[child, p]])

    world.destroy()
  })

  devOnly('dev asserts liveness, world membership and trait presence', () => {
    const world = new World()
    const other = new World()
    const px = world.accessor(Position.x)
    const e = world.spawn(Position)
    const bare = world.spawn()
    const foreign = other.spawn(Position)

    expect(() => px.get(bare)).toThrowError(/does not have that trait/)
    expect(() => px.set(bare, 1)).toThrowError(/does not have that trait/)
    expect(() => px.get(foreign)).toThrowError(/world/)
    expect(() => px.get(packEntity(0, 0, world[$id]))).toThrowError(/not alive/)

    world.despawn(e)

    expect(() => px.get(e)).toThrowError(/not alive/)
    expect(() => px.set(e, 1)).toThrowError(/not alive/)

    world.destroy()
    other.destroy()

    expect(() => px.get(e)).toThrowError(/destroyed/)
  })
})

describe('allocation (§4.5, §12.2)', () => {
  const it = test.skipIf(!CAN_MEASURE_HEAP)
  const ENTITIES = 1_000
  const PASSES = 200
  const NOISE = 2

  it('get and set allocate nothing per call after warmup', () => {
    const world = new World()
    const live: Entity[] = []
    for (let i = 0; i < ENTITIES; i++) {
      live.push(i % 2 === 0 ? world.spawn(Position, Velocity) : world.spawn(Position))
    }
    const px = world.accessor(Position.x)
    let sum = 0

    const bytes = bytesPerPass(PASSES, () => {
      for (let i = ENTITIES - 1; i >= 0; i--) {
        const e = live[i]
        px.set(e, px.get(e) + 1)
        sum += px.get(e)
      }
    })

    expect(sum).toBeGreaterThan(0)
    expect(bytes / ENTITIES).toBeLessThan(NOISE)

    world.destroy()
  })

  it('a memoised accessor costs nothing to look up again', () => {
    const world = new World()
    world.spawn(Position)
    world.accessor(Position.x)

    const bytes = bytesPerPass(PASSES, () => {
      for (let i = 0; i < ENTITIES; i++) world.accessor(Position.x)
    })

    expect(bytes / ENTITIES).toBeLessThan(NOISE)

    world.destroy()
  })
})
