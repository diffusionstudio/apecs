/**
 * T7.5 — the dev/prod split (SPEC §12.2, rule 5). Assertions and warnings are
 * behind `__DEV__` and are gone in the production build; the errors that guard
 * unrecoverable states are not, and the observable behaviour is identical
 * either way.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'

import { Changed, Relation, Trait, World, f32 } from '../src/index'
import type { Entity } from '../src/index'
import { ApecsError, assert, resetWarnOnce, warn, warnOnce } from '../src/internal'

const Position = new Trait({ x: f32(0), y: f32(0) })
const Velocity = new Trait({ x: f32(0), y: f32(0) })
const IsActive = new Trait()
const ChildOf = new Relation(undefined, { exclusive: true })

const devOnly = test.runIf(__DEV__)
const prodOnly = test.skipIf(__DEV__)

afterEach(() => {
  vi.restoreAllMocks()
  resetWarnOnce()
})

describe('the flag itself (§12.2)', () => {
  test('__DEV__ is a build-time boolean every dev-only path hangs off', () => {
    expect(typeof __DEV__).toBe('boolean')
    // The published bundle substitutes it and drops the branches; `scripts/check-bundle.mjs`
    // is what proves that, since the test projects only define the value.
    for (const fn of [assert, warn, warnOnce]) expect(String(fn)).toMatch(/__DEV__/)
  })
})

describe('assertions (§12.2)', () => {
  devOnly('dev assertions throw', () => {
    expect(() => assert(false, 'boom')).toThrowError(ApecsError)
    expect(() => assert(false, 'boom')).toThrowError(/apecs: boom/)
  })

  prodOnly('prod assertions are inert', () => {
    expect(() => assert(false, 'boom')).not.toThrow()
  })

  devOnly('dev catches misuse the API cannot recover from', () => {
    const world = new World()
    const entity = world.spawn(Position)

    expect(() => world.get(entity, IsActive)).toThrowError(/tag/)
    expect(() => world.get(entity, Velocity)).toThrowError(/does not have that trait/)
    expect(() => Position({ z: 1 } as never)).toThrowError(/not a field/)
    expect(() => world.get(0 as Entity, Position)).toThrowError(/not alive/)
    expect(() => world.spawn(ChildOf(0 as Entity))).toThrowError(/target/)

    world.despawn(entity)

    expect(() => world.get(entity, Position)).toThrowError(/not alive/)

    world.destroy()

    expect(() => world.spawn()).toThrowError(/destroyed/)
  })

  prodOnly('prod skips those checks rather than paying for them', () => {
    const world = new World()
    const entity = world.spawn(Position)

    expect(world.get(entity, IsActive)).toEqual({})
    expect(() => Position({ z: 1 } as never)).not.toThrow()
    expect(world.isAlive(0 as Entity)).toBe(false)

    world.destroy()

    expect(() => world.query(Position)).not.toThrow()
  })
})

describe('warnings (§12.2)', () => {
  test('a boxed field warns in dev and is silent in prod', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    new Trait({ payload: { nested: null } as unknown as Record<string, unknown> })

    expect(spy.mock.calls.length).toBe(__DEV__ ? 1 : 0)
  })

  test('warn and warnOnce write nothing in prod', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    warn('once')
    warnOnce('key', 'twice')
    warnOnce('key', 'twice')

    expect(spy.mock.calls.length).toBe(__DEV__ ? 2 : 0)
  })
})

describe('errors that survive the production build', () => {
  test('a sorted query still refuses chunks', () => {
    const world = new World()
    world.spawn(Position)

    const sorted = world.query(Position).sortBy(Position.x) as unknown as { chunks(): unknown }

    expect(() => sorted.chunks()).toThrowError(ApecsError)

    world.destroy()
  })

  test('world-id exhaustion is a hard error in both builds', () => {
    const worlds: World[] = []

    expect(() => {
      for (let i = 0; i < 300; i++) worlds.push(new World())
    }).toThrowError(ApecsError)

    for (const world of worlds) world.destroy()
  })
})

describe('behavioural parity', () => {
  /** Both projects run this and must agree, digit for digit. */
  test('a mixed workload produces identical results', () => {
    const world = new World({ pageSize: 16 })
    const parent = world.spawn(Position({ x: 1, y: 1 }))
    const children: Entity[] = []
    for (let i = 0; i < 50; i++) {
      children.push(
        world.spawn(Position({ x: i, y: -i }), Velocity({ x: 1, y: 2 }), ChildOf(parent)),
      )
    }
    world.spawnMany(25, Position, IsActive)
    world.step()

    for (const chunk of world.query(Position, Velocity).chunks()) {
      const { x, y } = chunk.get(Position)
      for (let i = 0; i < chunk.length; i++) {
        x[i] += 1
        y[i] -= 1
      }
      chunk.markChanged(Position)
    }

    let changed = 0
    world.query(Position, Changed(Position)).each((p) => {
      changed += p.x
    })

    const sorted = world.query(Position, Velocity).sortBy(Position.x, 'desc')

    world.despawn(children[0])
    world.step()

    // 50 children moved to x = 1..50, plus the parent, whose spawn write is a change.
    expect(changed).toBe(1_276)
    expect(world.query(Position).count).toBe(75)
    expect(sorted.count).toBe(49)
    expect(world.get(sorted.first!, Position.x)).toBe(50)
    expect(world.targets(children[1], ChildOf)).toEqual([parent])
    expect(world.query(ChildOf(parent)).count).toBe(49)

    world.destroy()
  })
})
