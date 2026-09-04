// Fixed cost per each()/chunks() call, and per-entity cost, from a scaling
// sweep. SPEC §12.1 budgets a per-archetype fixed cost under ~200ns; this asks
// what the per-CALL fixed cost is.
import { measure } from 'mitata'
import { Trait, World, f32 } from '../../dist/index.js'

const P = new Trait({ value: f32(0) })
const rows = []
for (const n of [1, 10, 100, 1000, 5000, 20000, 100000]) {
  const world = new World()
  for (let i = 0; i < n; i++) world.spawn(P)
  const q = world.query(P)
  const each = () => q.each((p) => (p.value += 1))
  const chunks = () => {
    for (const c of q.chunks()) {
      const col = c.column(P.value)
      for (let i = 0, m = c.length; i < m; i++) col[i] += 1
    }
  }
  for (let i = 0; i < 5; i++) {
    each()
    chunks()
  }
  const e = await measure(each, { min_cpu_time: 600e6 })
  const c = await measure(chunks, { min_cpu_time: 600e6 })
  rows.push({ n, each: e.avg, chunks: c.avg })
}
console.log(
  'entities'.padStart(8),
  'each(ns)'.padStart(12),
  'ns/entity'.padStart(10),
  'chunks(ns)'.padStart(12),
  'ns/entity'.padStart(10),
)
for (const r of rows) {
  console.log(
    String(r.n).padStart(8),
    r.each.toFixed(0).padStart(12),
    (r.each / r.n).toFixed(2).padStart(10),
    r.chunks.toFixed(0).padStart(12),
    (r.chunks / r.n).toFixed(2).padStart(10),
  )
}
