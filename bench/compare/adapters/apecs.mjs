/**
 * apecs, benchmarked from the built `dist/` — the same bytes a user installs,
 * with dev assertions compiled out.
 *
 * Two tiers are measured wherever apecs offers both: `each` (the idiom) and
 * `chunks` (the escape hatch).
 */
import { Not, Trait, World, f32 } from '../../../dist/index.js'
import { fragmentSizes, permutation } from '../lib/spec.mjs'

const A = new Trait({ value: f32(0) })
const B = new Trait({ value: f32(0) })
const C = new Trait({ value: f32(0) })
const D = new Trait({ value: f32(0) })
const E = new Trait({ value: f32(0) })
const PACKED = [A, B, C, D, E]

const Position = new Trait({ x: f32(0), y: f32(0) })
const Velocity = new Trait({ x: f32(0), y: f32(0) })
const Data = new Trait({ value: f32(0) })
const FRAGMENTS = Array.from({ length: 26 }, () => new Trait({ value: f32(0) }))

const DT = 1 / 60

export const name = 'apecs'
export const version = '0.1.0 (dist)'
export const notes =
  'Archetype + SoA typed columns. `each` is the idiom; `chunks` hands back the raw arrays.'

function packedWorld(entities) {
  const world = new World()
  for (let i = 0; i < entities; i++) world.spawn(A, B, C, D, E)
  return world
}

function fragmentedWorld(entities, archetypes) {
  const world = new World()
  const sizes = fragmentSizes(entities, archetypes)
  for (let f = 0; f < archetypes; f++) {
    for (let i = 0; i < sizes[f]; i++) world.spawn(Data, FRAGMENTS[f])
  }
  return world
}

export const benchmarks = {
  'packed_1/ergonomic': ({ entities }) => {
    const query = packedWorld(entities).query(A)
    return () => query.each((a) => (a.value += 1))
  },

  'packed_1/raw': ({ entities }) => {
    const query = packedWorld(entities).query(A)
    return () => {
      for (const chunk of query.chunks()) {
        const column = chunk.column(A.value)
        for (let i = 0, n = chunk.length; i < n; i++) column[i] += 1
      }
    }
  },

  'packed_5/ergonomic': ({ entities }) => {
    const world = packedWorld(entities)
    // Five separate call sites, not a loop over an array of queries. A loop
    // funnels five cursor shapes through one `.each` site and measures V8's
    // inline cache rather than the library; real systems are written out.
    const [qa, qb, qc, qd, qe] = PACKED.map((trait) => world.query(trait))
    return () => {
      qa.each((t) => (t.value += 1))
      qb.each((t) => (t.value += 1))
      qc.each((t) => (t.value += 1))
      qd.each((t) => (t.value += 1))
      qe.each((t) => (t.value += 1))
    }
  },

  'packed_5/raw': ({ entities }) => {
    const world = packedWorld(entities)
    const queries = PACKED.map((trait) => world.query(trait))
    const fields = PACKED.map((trait) => trait.value)
    return () => {
      for (let q = 0; q < queries.length; q++) {
        for (const chunk of queries[q].chunks()) {
          const column = chunk.column(fields[q])
          for (let i = 0, n = chunk.length; i < n; i++) column[i] += 1
        }
      }
    }
  },

  'simple_iter/ergonomic': ({ entities }) => {
    const world = new World()
    for (let i = 0; i < entities; i++)
      world.spawn(Position({ x: i, y: i }), Velocity({ x: 1, y: 2 }))
    const query = world.query(Position, Velocity)
    return () =>
      query.each((p, v) => {
        p.x += v.x * DT
        p.y += v.y * DT
      })
  },

  'simple_iter/raw': ({ entities }) => {
    const world = new World()
    for (let i = 0; i < entities; i++)
      world.spawn(Position({ x: i, y: i }), Velocity({ x: 1, y: 2 }))
    const query = world.query(Position, Velocity)
    return () => {
      for (const chunk of query.chunks()) {
        const { x, y } = chunk.get(Position)
        const { x: vx, y: vy } = chunk.get(Velocity)
        for (let i = 0, n = chunk.length; i < n; i++) {
          x[i] += vx[i] * DT
          y[i] += vy[i] * DT
        }
      }
    }
  },

  'frag_iter/ergonomic': ({ entities, archetypes }) => {
    const query = fragmentedWorld(entities, archetypes).query(Data)
    return () => query.each((d) => (d.value += 1))
  },

  'frag_iter/raw': ({ entities, archetypes }) => {
    const query = fragmentedWorld(entities, archetypes).query(Data)
    return () => {
      for (const chunk of query.chunks()) {
        const column = chunk.column(Data.value)
        for (let i = 0, n = chunk.length; i < n; i++) column[i] += 1
      }
    }
  },

  'entity_cycle/ergonomic': ({ entities }) => {
    const world = new World({ maxEntities: entities + 16 })
    const live = new Float64Array(entities)
    return () => {
      for (let i = 0; i < entities; i++) live[i] = world.spawn(Position, Velocity)
      for (let i = 0; i < entities; i++) world.despawn(live[i])
    }
  },

  'add_remove/ergonomic': ({ entities }) => {
    const world = new World({ maxEntities: entities + 16 })
    const live = new Float64Array(entities)
    for (let i = 0; i < entities; i++) live[i] = world.spawn(Position)
    return () => {
      for (let i = 0; i < entities; i++) world.add(live[i], Velocity)
      for (let i = 0; i < entities; i++) world.remove(live[i], Velocity)
    }
  },

  'mixed_query/ergonomic': ({ entities, archetypes, excluded }) => {
    const world = fragmentedWorld(entities, archetypes)
    const query = world.query(Data, ...FRAGMENTS.slice(0, excluded).map(Not))
    return () => query.each((d) => (d.value += 1))
  },

  'mixed_query/raw': ({ entities, archetypes, excluded }) => {
    const world = fragmentedWorld(entities, archetypes)
    const query = world.query(Data, ...FRAGMENTS.slice(0, excluded).map(Not))
    return () => {
      for (const chunk of query.chunks()) {
        const column = chunk.column(Data.value)
        for (let i = 0, n = chunk.length; i < n; i++) column[i] += 1
      }
    }
  },

  'random_access/ergonomic': ({ entities }) => {
    const world = new World({ maxEntities: entities + 16 })
    const live = new Float64Array(entities)
    for (let i = 0; i < entities; i++) live[i] = world.spawn(Position)
    const order = permutation(entities)
    return () => {
      for (let i = 0; i < entities; i++) {
        const e = live[order[i]]
        world.set(e, Position.x, world.get(e, Position.x) + 1)
      }
    }
  },
}

/** How many entities each query-shaped benchmark actually matches. */
export function census({ entities, archetypes, excluded }) {
  const packed = packedWorld(entities)
  const frag = fragmentedWorld(entities, archetypes)
  const simple = new World()
  for (let i = 0; i < entities; i++) simple.spawn(Position, Velocity)
  return {
    packed_1: packed.query(A).entities().length,
    packed_5: PACKED.reduce((n, t) => n + packed.query(t).entities().length, 0),
    simple_iter: simple.query(Position, Velocity).entities().length,
    frag_iter: frag.query(Data).entities().length,
    mixed_query: frag.query(Data, ...FRAGMENTS.slice(0, excluded).map(Not)).entities().length,
  }
}

/** A world of `n` entities carrying Position + Velocity, for the memory probe. */
export function footprint(n) {
  const world = new World({ maxEntities: n + 16 })
  for (let i = 0; i < n; i++) world.spawn(Position({ x: i, y: i }), Velocity({ x: 1, y: 2 }))
  return world
}
