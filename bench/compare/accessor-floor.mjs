/**
 * layout-physics.mjs showed the archetype indirection is not what costs
 * apecs at random access — one extra dependent load is ~free. So how much of
 * `world.accessor`'s 14.9 ns/entity is the access path itself, and how much is
 * software overhead sitting on top of it?
 *
 * Rebuilds the accessor's exact path in plain JS, step by step.
 *
 *   node accessor-floor.mjs
 */
import { measure } from 'mitata'
import { Trait, World, f32 } from '../../dist/index.js'
import { $archetypes, $entities, $id, $index } from '../../dist/internal.js'
import { permutation } from './lib/spec.mjs'

const N = 100_000
const P = new Trait({ x: f32(0) })
const world = new World({ maxEntities: N + 16 })
const live = new Float64Array(N)
for (let i = 0; i < N; i++) live[i] = world.spawn(P)
const order = permutation(N)

const acc = world.accessor(P.x)
const entities = world[$entities]
const graph = world[$archetypes]
const column = graph.list[entities.archetypes[entityId(live[0])]].columnsOf.get(P[$id])[P.x[$index]]
const pages = column.pages
const shift = 31 - Math.clz32(column.pageSize)
const mask = column.pageSize - 1
const table = []
table[entities.archetypes[live[0] >>> 0]] = { pages, shift, mask }

function entityId(e) {
  return e >>> 0
}

const run = async (label, fn) => {
  for (let i = 0; i < 3; i++) fn()
  const s = await measure(fn, { min_cpu_time: 1000e6 })
  console.log(`  ${label.padEnd(50)} ${(s.avg / N).toFixed(2).padStart(6)} ns/entity`)
}

console.log('\nOne read + one write per entity, shuffled:')
await run('world.accessor (shipped)', () => {
  for (let i = 0; i < N; i++) {
    const e = live[order[i]]
    acc.set(e, acc.get(e) + 1)
  }
})
await run('same path, fused, inline (no method calls)', () => {
  for (let i = 0; i < N; i++) {
    const id = live[order[i]] >>> 0
    const b = table[entities.archetypes[id]]
    const row = entities.rows[id]
    b.pages[row >>> b.shift][row & b.mask] += 1
  }
})
await run('same path, inline, split read then write', () => {
  for (let i = 0; i < N; i++) {
    const e = live[order[i]]
    let id = e >>> 0
    let b = table[entities.archetypes[id]]
    let row = entities.rows[id]
    const v = b.pages[row >>> b.shift][row & b.mask]
    id = e >>> 0
    b = table[entities.archetypes[id]]
    row = entities.rows[id]
    b.pages[row >>> b.shift][row & b.mask] = v + 1
  }
})
await run('unpaged: single flat column, id→row', () => {
  const flatCol = new Float32Array(N)
  const rows = entities.rows
  for (let i = 0; i < N; i++) {
    const id = live[order[i]] >>> 0
    const r = rows[id]
    flatCol[r] = flatCol[r] + 1
  }
})
