/**
 * The accessor lands at ~15 ns/entity where the prototype predicted 8.8. The
 * prototype omitted change-tick stamping and the onChange check, which a
 * correct `set` must do — so how much of the gap is that missing work, and how
 * much is recoverable?
 */
import { measure } from 'mitata'
import { Trait, World, f32 } from '../../dist/index.js'
import { $archetypes, $entities, $id, $index, entityId } from '../../dist/internal.js'
import { permutation } from './lib/spec.mjs'

const N = 100_000
const Position = new Trait({ x: f32(0), y: f32(0) })
const world = new World({ maxEntities: N + 16 })
const live = new Float64Array(N)
for (let i = 0; i < N; i++) live[i] = world.spawn(Position)
const order = permutation(N)

const px = world.accessor(Position.x)
const entities = world[$entities]
const graph = world[$archetypes]
const traitId = Position[$id]
const fi = Position.x[$index]

/** The original prototype: no stamping, no onChange check. */
function bare() {
  const table = []
  const bind = (a) => {
    const c = graph.list[a].columnsOf.get(traitId)[fi]
    return (table[a] = { pages: c.pages, shift: 31 - Math.clz32(c.pageSize), mask: c.pageSize - 1 })
  }
  return {
    get(e) {
      const id = entityId(e)
      const a = entities.archetypes[id]
      const b = table[a] ?? bind(a)
      const row = entities.rows[id]
      return b.pages[row >>> b.shift][row & b.mask]
    },
    set(e, v) {
      const id = entityId(e)
      const a = entities.archetypes[id]
      const b = table[a] ?? bind(a)
      const row = entities.rows[id]
      b.pages[row >>> b.shift][row & b.mask] = v
    },
  }
}

/** Same, but doing the stamping work a correct `set` owes. */
function stamping() {
  const table = []
  const bind = (a) => {
    const c = graph.list[a].columnsOf.get(traitId)[fi]
    return (table[a] = {
      col: c,
      pages: c.pages,
      shift: 31 - Math.clz32(c.pageSize),
      mask: c.pageSize - 1,
    })
  }
  let changedSize = 0
  return {
    get(e) {
      const id = entityId(e)
      const a = entities.archetypes[id]
      const b = table[a] ?? bind(a)
      const row = entities.rows[id]
      return b.pages[row >>> b.shift][row & b.mask]
    },
    set(e, v) {
      const id = entityId(e)
      const a = entities.archetypes[id]
      const b = table[a] ?? bind(a)
      const row = entities.rows[id]
      b.pages[row >>> b.shift][row & b.mask] = v
      const col = b.col
      // What Column.stamp does, inlined: untracked columns bail immediately.
      if (col.ticks !== null) {
        col.ticks[row >>> b.shift][row & b.mask] = 1
        col.lastWriteTick = 1
      }
      if (changedSize !== 0) throw new Error('unreachable')
    },
  }
}

const b = bare(),
  st = stamping()
const run = async (label, fn) => {
  for (let i = 0; i < 3; i++) fn()
  const s = await measure(fn, { min_cpu_time: 1200e6 })
  console.log(label.padEnd(46), (s.avg / N).toFixed(1).padStart(6) + ' ns/entity')
}

await run('world.accessor (shipped)', () => {
  for (let i = 0; i < N; i++) {
    const e = live[order[i]]
    px.set(e, px.get(e) + 1)
  }
})
await run('prototype, no stamping (the 8.8 claim)', () => {
  for (let i = 0; i < N; i++) {
    const e = live[order[i]]
    b.set(e, b.get(e) + 1)
  }
})
await run('prototype + inlined stamp/onChange work', () => {
  for (let i = 0; i < N; i++) {
    const e = live[order[i]]
    st.set(e, st.get(e) + 1)
  }
})
await run('world.get + world.set (after Tier 1)', () => {
  for (let i = 0; i < N; i++) {
    const e = live[order[i]]
    world.set(e, Position.x, world.get(e, Position.x) + 1)
  }
})
