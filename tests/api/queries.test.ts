/**
 * SPEC §6.1–6.4 — terms, caching, the result surface, and tier 1 iteration.
 * Public API only.
 */
import { afterEach, describe, expect, test } from 'vitest'

import {
  Added,
  Changed,
  Not,
  Optional,
  Or,
  Removed,
  Trait,
  With,
  World,
  f32,
} from '../../src/index'
import type { Entity, QueryResult } from '../../src/index'

const Position = new Trait({ x: f32(0), y: f32(0) })
const Velocity = new Trait({ x: f32(0), y: f32(0) })
const Renderable = new Trait({ layer: 0 })
const IsActive = new Trait()
const IsEnemy = new Trait()

const worlds: World[] = []

function makeWorld(options?: ConstructorParameters<typeof World>[0]): World {
  const world = new World(options)
  worlds.push(world)
  return world
}

function set(query: QueryResult): Set<Entity> {
  return new Set([...query])
}

afterEach(() => {
  for (const world of worlds.splice(0)) world.destroy()
})

describe('terms (§6.1)', () => {
  test('a bare trait list is "all of"', () => {
    const world = makeWorld()
    const both = world.spawn(Position, Velocity)
    world.spawn(Position)
    world.spawn(Velocity)

    expect(set(world.query(Position, Velocity))).toEqual(new Set([both]))
  })

  test('Not excludes', () => {
    const world = makeWorld()
    const alone = world.spawn(Position)
    world.spawn(Position, Velocity)

    expect(set(world.query(Position, Not(Velocity)))).toEqual(new Set([alone]))
  })

  test('Or is a disjunction', () => {
    const world = makeWorld()
    const v = world.spawn(Velocity)
    const r = world.spawn(Renderable)
    world.spawn(Position)

    expect(set(world.query(Or(Velocity, Renderable)))).toEqual(new Set([v, r]))
  })

  test('With requires without reading', () => {
    const world = makeWorld()
    const active = world.spawn(Position, IsActive)
    world.spawn(Position)
    const seen: unknown[][] = []

    world.query(Position, With(IsActive)).each((...args) => seen.push(args))

    expect(set(world.query(Position, With(IsActive)))).toEqual(new Set([active]))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toHaveLength(2) // the Position cursor and the entity, nothing for With
  })

  test('Optional matches either way', () => {
    const world = makeWorld()
    const with_ = world.spawn(Position, Velocity)
    const without = world.spawn(Position)

    expect(set(world.query(Position, Optional(Velocity)))).toEqual(new Set([with_, without]))
  })

  test('Optional yields a cursor or null, positionally', () => {
    const world = makeWorld()
    world.spawn(Position({ x: 1 }), Velocity({ x: 9 }))
    world.spawn(Position({ x: 2 }))
    const seen: [number, number | null][] = []

    world.query(Position, Optional(Velocity)).each((p, v) => {
      seen.push([p.x, v === null ? null : v.x])
    })

    expect(seen.sort((a, b) => a[0] - b[0])).toEqual([
      [1, 9],
      [2, null],
    ])
  })

  test('a tag contributes no argument', () => {
    const world = makeWorld()
    world.spawn(Position, IsEnemy)
    let arity = -1

    world.query(Position, IsEnemy).each((...args) => {
      arity = args.length
    })

    expect(arity).toBe(2) // the Position cursor and the entity
  })

  test('modifiers nest', () => {
    const world = makeWorld()
    const a = world.spawn(Position)
    const b = world.spawn(Position, Velocity, IsActive)
    world.spawn(Position, Velocity)

    expect(set(world.query(Position, Or(Not(Velocity), IsActive)))).toEqual(new Set([a, b]))
  })

  test('an empty term list matches nothing meaningful but does not throw', () => {
    const world = makeWorld()
    world.spawn(Position)

    expect(() => world.query()).not.toThrow()
  })

  test('term order does not change the matched set', () => {
    const world = makeWorld()
    world.spawn(Position, Velocity, IsActive)
    world.spawn(Position)

    const a = set(world.query(Position, Velocity, With(IsActive)))
    const b = set(world.query(With(IsActive), Velocity, Position))

    expect(a).toEqual(b)
  })
})

describe('caching (§6.2)', () => {
  test('the same signature returns the same object', () => {
    const world = makeWorld()

    expect(world.query(Position, Velocity)).toBe(world.query(Position, Velocity))
    expect(world.createQuery(Position, Velocity)).toBe(world.query(Position, Velocity))
  })

  test('a different signature returns a different object', () => {
    const world = makeWorld()

    expect(world.query(Position)).not.toBe(world.query(Velocity))
    expect(world.query(Position)).not.toBe(world.query(Position, Not(Velocity)))
  })

  test('the cache is per world', () => {
    const a = makeWorld()
    const b = makeWorld()

    expect(a.query(Position)).not.toBe(b.query(Position))
  })

  test('a query built before the archetype exists still matches it', () => {
    const world = makeWorld()
    const query = world.createQuery(Position, Velocity)

    expect(query.isEmpty).toBe(true)

    const entity = world.spawn(Position, Velocity)

    expect(query.count).toBe(1)
    expect(query.first).toBe(entity)
  })

  test('dispose drops the query from the cache', () => {
    const world = makeWorld()
    const query = world.createQuery(Position)

    query.dispose()

    expect(world.query(Position)).not.toBe(query)
  })

  test('a hoisted query tracks structural change without being re-created', () => {
    const world = makeWorld()
    const query = world.createQuery(Position)
    const entity = world.spawn(Position)

    expect(query.count).toBe(1)

    world.remove(entity, Position)

    expect(query.count).toBe(0)

    world.add(entity, Position)

    expect(query.count).toBe(1)

    world.despawn(entity)

    expect(query.count).toBe(0)
  })
})

describe('result surface (§6.3)', () => {
  test('count, isEmpty and first agree', () => {
    const world = makeWorld()
    const query = world.query(Position)

    expect(query.count).toBe(0)
    expect(query.isEmpty).toBe(true)
    expect(query.first).toBeUndefined()

    const entity = world.spawn(Position)

    expect(query.count).toBe(1)
    expect(query.isEmpty).toBe(false)
    expect(query.first).toBe(entity)
  })

  test('queryFirst is sugar for first', () => {
    const world = makeWorld()

    expect(world.queryFirst(Position)).toBeUndefined()

    const entity = world.spawn(Position)

    expect(world.queryFirst(Position)).toBe(world.query(Position).first)
    expect(world.queryFirst(Position)).toBe(entity)
  })

  test('entities() is a Float64Array snapshot, safe under mutation', () => {
    const world = makeWorld()
    const swarm = world.spawnMany(10, Position)
    const snapshot = world.query(Position).entities()

    expect(snapshot).toBeInstanceOf(Float64Array)
    expect(snapshot.length).toBe(10)

    world.despawnMany(swarm)

    expect(snapshot.length).toBe(10)
    expect(new Set(snapshot)).toEqual(new Set(swarm))
  })

  test('entities() hands out a fresh copy each call', () => {
    const world = makeWorld()
    world.spawnMany(4, Position)
    const query = world.query(Position)

    expect(query.entities()).not.toBe(query.entities())
    expect([...query.entities()]).toEqual([...query.entities()])
  })

  test('the query is iterable and yields every match once', () => {
    const world = makeWorld()
    const swarm = world.spawnMany(100, Position)
    const seen: Entity[] = []

    for (const entity of world.query(Position)) seen.push(entity)

    expect(seen).toHaveLength(100)
    expect(new Set(seen)).toEqual(new Set(swarm))
  })

  test('iteration spans archetypes and pages', () => {
    const world = makeWorld({ pageSize: 4 })
    world.spawnMany(10, Position)
    world.spawnMany(10, Position, Velocity)
    world.spawnMany(10, Position, IsActive)

    expect(world.query(Position).count).toBe(30)
    expect([...world.query(Position)]).toHaveLength(30)
  })

  test('an exhausted iterator does not restart', () => {
    const world = makeWorld()
    world.spawnMany(3, Position)
    const iterator = world.query(Position)[Symbol.iterator]()

    let steps = 0
    while (!iterator.next().done) steps++

    expect(steps).toBe(3)
    expect(iterator.next().done).toBe(true)
  })
})

describe('tier 1 (§6.4)', () => {
  test('handles read back through the world', () => {
    const world = makeWorld()
    world.spawn(Position({ x: 1, y: 2 }))
    let copy: { x: number; y: number } | undefined
    let field = -1

    for (const entity of world.query(Position)) {
      copy = world.get(entity, Position)
      field = world.get(entity, Position.x)
    }

    expect(copy).toEqual({ x: 1, y: 2 })
    expect(field).toBe(1)
  })

  test('writes through the world during tier-1 iteration land', () => {
    const world = makeWorld()
    world.spawnMany(20, Position)

    for (const entity of world.query(Position)) world.set(entity, Position.x, 5)

    for (const entity of world.query(Position)) expect(world.get(entity, Position.x)).toBe(5)
  })
})

describe('tick filters as terms (§6.1, §8.3)', () => {
  test('Added yields entities that gained the trait since the query last ran', () => {
    const world = makeWorld()
    const query = world.query(Added(Velocity))
    const seen: Entity[] = []
    const drain = () => {
      seen.length = 0
      query.each((...args) => seen.push(args[args.length - 1] as Entity))
    }

    drain()
    world.step()
    const entity = world.spawn(Position, Velocity)
    drain()

    expect(seen).toEqual([entity])

    world.step()
    drain()

    expect(seen).toEqual([])
  })

  test('Removed is valid for one tick after removal', () => {
    const world = makeWorld()
    const entity = world.spawn(Position, Velocity)
    const query = world.query(Removed(Velocity))
    const seen: Entity[] = []
    const drain = () => {
      seen.length = 0
      query.each((...args) => seen.push(args[args.length - 1] as Entity))
    }

    drain()
    world.step()
    world.remove(entity, Velocity)
    drain()

    expect(seen).toEqual([entity])

    world.step()
    drain()

    expect(seen).toEqual([])
  })

  test('Changed yields only entities written since this query last ran', () => {
    const world = makeWorld()
    const a = world.spawn(Position)
    world.spawn(Position)
    const query = world.query(Position, Changed(Position))
    const seen: Entity[] = []
    const drain = () => {
      seen.length = 0
      query.each((_p, e) => seen.push(e))
    }

    drain() // consume the initial state
    world.step()
    world.set(a, Position.x, 5)
    drain()

    expect(seen).toEqual([a])

    world.step()
    drain()

    expect(seen).toEqual([])
  })

  test('two queries over the same trait keep their own last-seen tick', () => {
    const world = makeWorld()
    const entity = world.spawn(Position, IsActive)
    const one = world.query(Position, Changed(Position))
    const two = world.query(With(IsActive), Changed(Position))
    const drain = (query: QueryResult) => {
      const out: Entity[] = []
      query.each((...args) => out.push(args[args.length - 1] as Entity))
      return out
    }

    drain(one)
    drain(two)
    world.step()
    world.set(entity, Position.x, 1)

    expect(drain(one)).toEqual([entity])
    expect(drain(two)).toEqual([entity])
  })
})
