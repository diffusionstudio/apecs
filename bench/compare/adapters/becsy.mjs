/**
 * becsy 0.15, `perf` build (runtime validation compiled out — the dev build is
 * several times slower by design and benchmarking it would be dishonest).
 *
 * becsy is scheduler-first: work happens inside a `System`, and a frame is
 * driven by `await world.execute()`. So every becsy number here includes one
 * frame of scheduler overhead that the other libraries do not pay. The
 * `frame_overhead` entry measures that floor on its own so the report can say
 * how much of each figure is scheduling rather than iteration.
 */
import { System, Type, World } from '@lastolivegames/becsy/perf.js'
import { fragmentSizes, permutation } from '../lib/spec.mjs'

export const name = 'becsy'
export const version = '0.15.5 (perf build)'
export const notes =
  'Archetype + typed columns, but scheduler-first: every figure includes one `world.execute()` frame.'

const DT = 1 / 60
const v1 = { value: Type.float32 }
const v2 = { x: Type.float32, y: Type.float32 }

/**
 * becsy sizes several per-frame logs from these options, and the `perf` build
 * has the assertions compiled out — so a world left on the defaults silently
 * creates only some of the entities you asked for and every query built on
 * them comes back short. The census in `census.mjs` is what caught that;
 * these limits are set generously on every world so it cannot recur.
 */
const limits = (n) => ({
  maxEntities: n + 16,
  maxShapeChangesPerFrame: n * 8 + 1024,
  maxWritesPerFrame: n * 8 + 1024,
  maxLimboComponents: n * 8 + 1024,
})

const cls = (schema) => {
  const C = class {}
  C.schema = schema
  return C
}

export const benchmarks = {
  frame_overhead: async () => {
    class Nothing extends System {
      execute() {}
    }
    const world = await World.create({ defs: [Nothing], ...limits(16) })
    return () => world.execute()
  },

  'packed_1/ergonomic': async ({ entities }) => {
    const [A, B, C, D, E] = [cls(v1), cls(v1), cls(v1), cls(v1), cls(v1)]
    class Pass extends System {
      q = this.query((x) => x.current.with(A).write)
      execute() {
        for (const e of this.q.current) e.write(A).value += 1
      }
    }
    const world = await World.create({ defs: [A, B, C, D, E, Pass], ...limits(entities) })
    await world.build((sys) => {
      for (let i = 0; i < entities; i++) sys.createEntity(A, B, C, D, E)
    })
    return () => world.execute()
  },

  'packed_5/ergonomic': async ({ entities }) => {
    const comps = [cls(v1), cls(v1), cls(v1), cls(v1), cls(v1)]
    const [A, B, C, D, E] = comps
    class Pass extends System {
      a = this.query((x) => x.current.with(A).write)
      b = this.query((x) => x.current.with(B).write)
      c = this.query((x) => x.current.with(C).write)
      d = this.query((x) => x.current.with(D).write)
      e = this.query((x) => x.current.with(E).write)
      execute() {
        for (const e of this.a.current) e.write(A).value += 1
        for (const e of this.b.current) e.write(B).value += 1
        for (const e of this.c.current) e.write(C).value += 1
        for (const e of this.d.current) e.write(D).value += 1
        for (const e of this.e.current) e.write(E).value += 1
      }
    }
    const world = await World.create({ defs: [...comps, Pass], ...limits(entities) })
    await world.build((sys) => {
      for (let i = 0; i < entities; i++) sys.createEntity(A, B, C, D, E)
    })
    return () => world.execute()
  },

  'simple_iter/ergonomic': async ({ entities }) => {
    const Position = cls(v2)
    const Velocity = cls(v2)
    class Move extends System {
      q = this.query((x) => x.current.with(Position).write.and.with(Velocity).read)
      execute() {
        for (const e of this.q.current) {
          const p = e.write(Position)
          const v = e.read(Velocity)
          p.x += v.x * DT
          p.y += v.y * DT
        }
      }
    }
    const world = await World.create({
      defs: [Position, Velocity, Move],
      ...limits(entities),
    })
    await world.build((sys) => {
      for (let i = 0; i < entities; i++)
        sys.createEntity(Position, { x: i, y: i }, Velocity, { x: 1, y: 2 })
    })
    return () => world.execute()
  },

  'frag_iter/ergonomic': async ({ entities, archetypes }) => {
    const Data = cls(v1)
    const fragments = Array.from({ length: archetypes }, () => cls({}))
    class Pass extends System {
      q = this.query((x) => x.current.with(Data).write)
      execute() {
        for (const e of this.q.current) e.write(Data).value += 1
      }
    }
    const world = await World.create({
      defs: [Data, ...fragments, Pass],
      ...limits(entities),
    })
    const sizes = fragmentSizes(entities, archetypes)
    await world.build((sys) => {
      for (let f = 0; f < archetypes; f++) {
        for (let i = 0; i < sizes[f]; i++) sys.createEntity(Data, fragments[f])
      }
    })
    return () => world.execute()
  },

  'entity_cycle/ergonomic': async ({ entities }) => {
    const Position = cls(v2)
    const Velocity = cls(v2)
    class Churn extends System {
      q = this.query((x) => x.current.using(Position, Velocity).write)
      execute() {
        for (let i = 0; i < entities; i++) this.createEntity(Position, Velocity)
        for (const e of this.q.current) e.delete()
      }
    }
    const world = await World.create({
      defs: [Position, Velocity, Churn],
      ...limits(entities * 2),
    })
    return () => world.execute()
  },

  'add_remove/ergonomic': async ({ entities }) => {
    const Position = cls(v2)
    const Velocity = cls(v2)
    class Toggle extends System {
      q = this.query((x) => x.current.with(Position).and.using(Velocity).write)
      execute() {
        for (const e of this.q.current) e.add(Velocity)
        for (const e of this.q.current) e.remove(Velocity)
      }
    }
    const world = await World.create({
      defs: [Position, Velocity, Toggle],
      ...limits(entities),
    })
    await world.build((sys) => {
      for (let i = 0; i < entities; i++) sys.createEntity(Position)
    })
    return () => world.execute()
  },

  'mixed_query/ergonomic': async ({ entities, archetypes, excluded }) => {
    const Data = cls(v1)
    const fragments = Array.from({ length: archetypes }, () => cls({}))
    const banned = fragments.slice(0, excluded)
    class Pass extends System {
      q = this.query((x) => x.current.with(Data).write.without(...banned))
      execute() {
        for (const e of this.q.current) e.write(Data).value += 1
      }
    }
    const world = await World.create({
      defs: [Data, ...fragments, Pass],
      ...limits(entities),
    })
    const sizes = fragmentSizes(entities, archetypes)
    await world.build((sys) => {
      for (let f = 0; f < archetypes; f++) {
        for (let i = 0; i < sizes[f]; i++) sys.createEntity(Data, fragments[f])
      }
    })
    return () => world.execute()
  },

  'random_access/ergonomic': async ({ entities }) => {
    const Position = cls(v2)
    const order = permutation(entities)
    const live = new Array(entities)
    class Touch extends System {
      q = this.query((x) => x.current.with(Position).write)
      execute() {
        for (let i = 0; i < entities; i++) {
          const p = live[order[i]].write(Position)
          p.x = p.x + 1
        }
      }
    }
    const world = await World.create({ defs: [Position, Touch], ...limits(entities) })
    await world.build((sys) => {
      for (let i = 0; i < entities; i++) live[i] = sys.createEntity(Position).hold()
    })
    return () => world.execute()
  },
}

/**
 * How many entities each query-shaped benchmark actually matches. becsy has no
 * query handle outside a system, so the count is read from inside one frame.
 */
export async function census({ entities, archetypes, excluded }) {
  const counts = {}

  const record = (key) => (n) => (counts[key] = (counts[key] ?? 0) + n)

  {
    const comps = [cls(v1), cls(v1), cls(v1), cls(v1), cls(v1)]
    const [A, B, C, D, E] = comps
    const one = record('packed_1')
    const five = record('packed_5')
    class Count extends System {
      a = this.query((x) => x.current.with(A).read)
      all = comps.map((c) => this.query((x) => x.current.with(c).read))
      execute() {
        one(this.a.current.length)
        for (const q of this.all) five(q.current.length)
      }
    }
    const world = await World.create({ defs: [...comps, Count], ...limits(entities) })
    await world.build((sys) => {
      for (let i = 0; i < entities; i++) sys.createEntity(A, B, C, D, E)
    })
    await world.execute()
  }

  {
    const Position = cls(v2)
    const Velocity = cls(v2)
    const hit = record('simple_iter')
    class Count extends System {
      q = this.query((x) => x.current.with(Position).and.with(Velocity).read)
      execute() {
        hit(this.q.current.length)
      }
    }
    const world = await World.create({
      defs: [Position, Velocity, Count],
      ...limits(entities),
    })
    await world.build((sys) => {
      for (let i = 0; i < entities; i++) sys.createEntity(Position, Velocity)
    })
    await world.execute()
  }

  {
    const Data = cls(v1)
    const fragments = Array.from({ length: archetypes }, () => cls({}))
    const banned = fragments.slice(0, excluded)
    const all = record('frag_iter')
    const some = record('mixed_query')
    class Count extends System {
      q = this.query((x) => x.current.with(Data).read)
      m = this.query((x) => x.current.with(Data).read.without(...banned))
      execute() {
        all(this.q.current.length)
        some(this.m.current.length)
      }
    }
    const world = await World.create({
      defs: [Data, ...fragments, Count],
      ...limits(entities),
    })
    const sizes = fragmentSizes(entities, archetypes)
    await world.build((sys) => {
      for (let f = 0; f < archetypes; f++) {
        for (let i = 0; i < sizes[f]; i++) sys.createEntity(Data, fragments[f])
      }
    })
    await world.execute()
  }

  return counts
}

/** A world of `n` entities carrying Position + Velocity, for the memory probe. */
export async function footprint(n) {
  const Position = cls(v2)
  const Velocity = cls(v2)
  class Idle extends System {
    q = this.query((x) => x.current.with(Position).and.with(Velocity).read)
    execute() {}
  }
  // becsy sizes its per-frame logs from these options, so the benchmark
  // limits() — which must survive 100 000 structural changes in one frame —
  // would charge becsy for buffers a storage-only world never needs. Size them
  // to what construction actually requires; `verifyFootprint` proves it holds.
  const world = await World.create({
    defs: [Position, Velocity, Idle],
    maxEntities: n + 16,
    maxShapeChangesPerFrame: n * 3 + 1024,
    maxWritesPerFrame: n * 3 + 1024,
    maxLimboComponents: 1024,
  })
  await world.build((sys) => {
    for (let i = 0; i < n; i++) sys.createEntity(Position, { x: i, y: i }, Velocity, { x: 1, y: 2 })
  })
  return world
}

/** Proves the footprint world really holds `n` entities before we weigh it. */
export async function verifyFootprint(n) {
  let seen = -1
  const Position = cls(v2)
  const Velocity = cls(v2)
  class Check extends System {
    q = this.query((x) => x.current.with(Position).and.with(Velocity).read)
    execute() {
      seen = this.q.current.length
    }
  }
  const world = await World.create({
    defs: [Position, Velocity, Check],
    maxEntities: n + 16,
    maxShapeChangesPerFrame: n * 3 + 1024,
    maxWritesPerFrame: n * 3 + 1024,
    maxLimboComponents: 1024,
  })
  await world.build((sys) => {
    for (let i = 0; i < n; i++) sys.createEntity(Position, { x: i, y: i }, Velocity, { x: 1, y: 2 })
  })
  await world.execute()
  return seen
}
