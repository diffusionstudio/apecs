/**
 * How much of apecs's ~52 ns/entity random access is recoverable?
 *
 * Prototypes three progressively cheaper paths against the public `world.get`
 * / `world.set`, using the internal entry point. Not a proposed API — a
 * measurement of the ceiling, to size the work before doing it.
 */
import { measure } from 'mitata'
import { Trait, World, f32 } from '../../dist/index.js'
import { $archetypes, $entities, $id, $index, $trait, entityId } from '../../dist/internal.js'
import { permutation } from './lib/spec.mjs'

const N = 100_000
const Position = new Trait({ x: f32(0), y: f32(0) })
const world = new World({ maxEntities: N + 16 })
const live = new Float64Array(N)
for (let i = 0; i < N; i++) live[i] = world.spawn(Position)
const order = permutation(N)

const entities = world[$entities]
const graph = world[$archetypes]
const traitId = Position[$trait] === undefined ? Position[$id] : Position[$id]
const fieldIndex = Position.x[$index]

/** B: merged lookup — one archetype resolve, still a Map.get per access. */
function makeMerged() {
  return {
    get(e) {
      const id = entityId(e)
      const cols = graph.list[entities.archetypes[id]].columnsOf.get(traitId)
      return cols[fieldIndex].get(entities.rows[id])
    },
    set(e, v) {
      const id = entityId(e)
      const cols = graph.list[entities.archetypes[id]].columnsOf.get(traitId)
      cols[fieldIndex].set(entities.rows[id], v)
    },
  }
}

/** C: one-entry inline cache on the archetype, and page indexing inlined. */
function makeCached() {
  let cachedArchetype = -1
  let pages = null
  let shift = 0
  let mask = 0
  const bind = (a) => {
    const column = graph.list[a].columnsOf.get(traitId)[fieldIndex]
    pages = column.pages
    shift = 31 - Math.clz32(column.pageSize)
    mask = column.pageSize - 1
    cachedArchetype = a
  }
  return {
    get(e) {
      const id = entityId(e)
      const a = entities.archetypes[id]
      if (a !== cachedArchetype) bind(a)
      const row = entities.rows[id]
      return pages[row >>> shift][row & mask]
    },
    set(e, v) {
      const id = entityId(e)
      const a = entities.archetypes[id]
      if (a !== cachedArchetype) bind(a)
      const row = entities.rows[id]
      pages[row >>> shift][row & mask] = v
    },
  }
}

const merged = makeMerged()
const cached = makeCached()

const run = async (label, fn) => {
  for (let i = 0; i < 3; i++) fn()
  const s = await measure(fn, { min_cpu_time: 1200e6 })
  console.log(
    label.padEnd(46),
    (s.avg / 1000).toFixed(0).padStart(5) + 'µs',
    (s.avg / N).toFixed(1).padStart(6) + ' ns/entity',
  )
  return s.avg / N
}

const a = await run('A · world.get + world.set (today)', () => {
  for (let i = 0; i < N; i++) {
    const e = live[order[i]]
    world.set(e, Position.x, world.get(e, Position.x) + 1)
  }
})
const b = await run('B · merged lookup, Map.get kept', () => {
  for (let i = 0; i < N; i++) {
    const e = live[order[i]]
    merged.set(e, merged.get(e) + 1)
  }
})
const c = await run('C · + archetype inline cache, inlined page', () => {
  for (let i = 0; i < N; i++) {
    const e = live[order[i]]
    cached.set(e, cached.get(e) + 1)
  }
})
const d = await run('D · bitECS-style flat array (the floor)', () => {
  const x = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    const e = order[i]
    x[e] = x[e] + 1
  }
})

console.log()
console.log(
  `B is ${(a / b).toFixed(1)}x faster than today; C is ${(a / c).toFixed(1)}x; the floor is ${(a / d).toFixed(1)}x.`,
)

// Correctness: every entity must have been incremented the same number of times.
const seen = new Set()
for (let i = 0; i < N; i++) seen.add(world.get(live[i], Position.x))
console.log('distinct values across all entities (1 = every path agreed):', seen.size)
