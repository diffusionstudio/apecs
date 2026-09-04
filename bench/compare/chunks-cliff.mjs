// Is apecs's chunks() tier immune to the trait-count cliff? One k per process.
//   node chunks-cliff.mjs <k>
import { measure } from 'mitata'
import { Trait, World, f32 } from '../../dist/index.js'

const N = 1000
const k = Number(process.argv[2])
const traits = Array.from({ length: k }, () => new Trait({ value: f32(0) }))
const w = new World()
for (let i = 0; i < N; i++) w.spawn(...traits)
const qs = traits.map((t) => w.query(t))
const fields = traits.map((t) => t.value)
const fn = () => {
  for (let i = 0; i < k; i++)
    for (const c of qs[i].chunks()) {
      const col = c.column(fields[i])
      for (let j = 0, m = c.length; j < m; j++) col[j] += 1
    }
}
for (let i = 0; i < 5; i++) fn()
const s = await measure(fn, { min_cpu_time: 700e6 })
console.log(JSON.stringify({ k, ns: s.avg / (k * N) }))
