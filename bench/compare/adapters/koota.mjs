/**
 * koota 0.6 — the closest API relative to apecs: global `trait`s, a `World`
 * that spawns, a query with `updateEach`. Two tiers, same as apecs:
 * `updateEach` is the idiom, `useStores` is the escape hatch.
 *
 * Queries are pre-built with `createQuery` so we measure iteration, not the
 * per-call query hash.
 */
import { Not, createQuery, createWorld, getStore, trait } from 'koota'
import { fragmentSizes, permutation } from '../lib/spec.mjs'

export const name = 'koota'
export const version = '0.6.6'
export const notes =
  'Archetype-ish query cache over SoA stores held in plain JS arrays (not typed arrays).'

const DT = 1 / 60
/** koota packs generation above a 20-bit entity id. */
const ID = 0xfffff

const A = trait({ value: 0 })
const B = trait({ value: 0 })
const C = trait({ value: 0 })
const D = trait({ value: 0 })
const E = trait({ value: 0 })
const PACKED = [A, B, C, D, E]

const Position = trait({ x: 0, y: 0 })
const Velocity = trait({ x: 0, y: 0 })
const Data = trait({ value: 0 })
const FRAGMENTS = Array.from({ length: 26 }, () => trait({}))

function packedWorld(entities) {
  const world = createWorld()
  for (let i = 0; i < entities; i++) world.spawn(A, B, C, D, E)
  return world
}

function fragmentedWorld(entities, archetypes) {
  const world = createWorld()
  const sizes = fragmentSizes(entities, archetypes)
  for (let f = 0; f < archetypes; f++) {
    for (let i = 0; i < sizes[f]; i++) world.spawn(Data, FRAGMENTS[f])
  }
  return world
}

export const benchmarks = {
  'packed_1/ergonomic': ({ entities }) => {
    const world = packedWorld(entities)
    const key = createQuery(A)
    return () => world.query(key).updateEach(([a]) => (a.value += 1))
  },

  'packed_1/raw': ({ entities }) => {
    const world = packedWorld(entities)
    const key = createQuery(A)
    return () => {
      world.query(key).useStores(([store], ents) => {
        const value = store.value
        for (let i = 0, n = ents.length; i < n; i++) value[ents[i] & ID] += 1
      })
    }
  },

  'packed_5/ergonomic': ({ entities }) => {
    const world = packedWorld(entities)
    // Five separate call sites — see the note in the apecs adapter.
    const [ka, kb, kc, kd, ke] = PACKED.map((t) => createQuery(t))
    return () => {
      world.query(ka).updateEach(([t]) => (t.value += 1))
      world.query(kb).updateEach(([t]) => (t.value += 1))
      world.query(kc).updateEach(([t]) => (t.value += 1))
      world.query(kd).updateEach(([t]) => (t.value += 1))
      world.query(ke).updateEach(([t]) => (t.value += 1))
    }
  },

  'packed_5/raw': ({ entities }) => {
    const world = packedWorld(entities)
    const keys = PACKED.map((t) => createQuery(t))
    return () => {
      for (let q = 0; q < keys.length; q++) {
        world.query(keys[q]).useStores(([store], ents) => {
          const value = store.value
          for (let i = 0, n = ents.length; i < n; i++) value[ents[i] & ID] += 1
        })
      }
    }
  },

  'simple_iter/ergonomic': ({ entities }) => {
    const world = createWorld()
    for (let i = 0; i < entities; i++)
      world.spawn(Position({ x: i, y: i }), Velocity({ x: 1, y: 2 }))
    const key = createQuery(Position, Velocity)
    return () =>
      world.query(key).updateEach(([p, v]) => {
        p.x += v.x * DT
        p.y += v.y * DT
      })
  },

  'simple_iter/raw': ({ entities }) => {
    const world = createWorld()
    for (let i = 0; i < entities; i++)
      world.spawn(Position({ x: i, y: i }), Velocity({ x: 1, y: 2 }))
    const key = createQuery(Position, Velocity)
    return () => {
      world.query(key).useStores(([p, v], ents) => {
        const { x, y } = p
        const { x: vx, y: vy } = v
        for (let i = 0, n = ents.length; i < n; i++) {
          const e = ents[i] & ID
          x[e] += vx[e] * DT
          y[e] += vy[e] * DT
        }
      })
    }
  },

  'frag_iter/ergonomic': ({ entities, archetypes }) => {
    const world = fragmentedWorld(entities, archetypes)
    const key = createQuery(Data)
    return () => world.query(key).updateEach(([d]) => (d.value += 1))
  },

  'frag_iter/raw': ({ entities, archetypes }) => {
    const world = fragmentedWorld(entities, archetypes)
    const key = createQuery(Data)
    return () => {
      world.query(key).useStores(([store], ents) => {
        const value = store.value
        for (let i = 0, n = ents.length; i < n; i++) value[ents[i] & ID] += 1
      })
    }
  },

  'entity_cycle/ergonomic': ({ entities }) => {
    const world = createWorld()
    const live = new Array(entities)
    return () => {
      for (let i = 0; i < entities; i++) live[i] = world.spawn(Position, Velocity)
      for (let i = 0; i < entities; i++) live[i].destroy()
    }
  },

  'add_remove/ergonomic': ({ entities }) => {
    const world = createWorld()
    const live = new Array(entities)
    for (let i = 0; i < entities; i++) live[i] = world.spawn(Position)
    return () => {
      for (let i = 0; i < entities; i++) live[i].add(Velocity)
      for (let i = 0; i < entities; i++) live[i].remove(Velocity)
    }
  },

  'mixed_query/ergonomic': ({ entities, archetypes, excluded }) => {
    const world = fragmentedWorld(entities, archetypes)
    const key = createQuery(Data, Not(...FRAGMENTS.slice(0, excluded)))
    return () => world.query(key).updateEach(([d]) => (d.value += 1))
  },

  'mixed_query/raw': ({ entities, archetypes, excluded }) => {
    const world = fragmentedWorld(entities, archetypes)
    const key = createQuery(Data, Not(...FRAGMENTS.slice(0, excluded)))
    return () => {
      world.query(key).useStores(([store], ents) => {
        const value = store.value
        for (let i = 0, n = ents.length; i < n; i++) value[ents[i] & ID] += 1
      })
    }
  },

  'random_access/ergonomic': ({ entities }) => {
    const world = createWorld()
    const live = new Array(entities)
    for (let i = 0; i < entities; i++) live[i] = world.spawn(Position)
    const order = permutation(entities)
    return () => {
      for (let i = 0; i < entities; i++) {
        const e = live[order[i]]
        e.set(Position, { x: e.get(Position).x + 1 })
      }
    }
  },

  'random_access/raw': ({ entities }) => {
    const world = createWorld()
    const live = new Array(entities)
    for (let i = 0; i < entities; i++) live[i] = world.spawn(Position)
    const order = permutation(entities)
    const x = getStore(world, Position).x
    return () => {
      for (let i = 0; i < entities; i++) {
        const e = live[order[i]] & ID
        x[e] = x[e] + 1
      }
    }
  },
}

/** How many entities each query-shaped benchmark actually matches. */
export function census({ entities, archetypes, excluded }) {
  const packed = packedWorld(entities)
  const frag = fragmentedWorld(entities, archetypes)
  const simple = createWorld()
  for (let i = 0; i < entities; i++) simple.spawn(Position, Velocity)
  return {
    packed_1: packed.query(createQuery(A)).length,
    packed_5: PACKED.reduce((n, t) => n + packed.query(createQuery(t)).length, 0),
    simple_iter: simple.query(createQuery(Position, Velocity)).length,
    frag_iter: frag.query(createQuery(Data)).length,
    mixed_query: frag.query(createQuery(Data, Not(...FRAGMENTS.slice(0, excluded)))).length,
  }
}

/** A world of `n` entities carrying Position + Velocity, for the memory probe. */
export function footprint(n) {
  const world = createWorld()
  for (let i = 0; i < n; i++) world.spawn(Position({ x: i, y: i }), Velocity({ x: 1, y: 2 }))
  return world
}
