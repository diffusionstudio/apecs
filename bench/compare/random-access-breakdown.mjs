/**
 * What `random_access` actually costs in apecs, split apart:
 *  - is it the shuffled order (cache misses), or per-entity access itself?
 *  - how much is `get` vs `set`?
 *  - how does one entity-at-a-time access compare to the same field via each()?
 */
import { measure } from 'mitata'
import { Trait, World, f32 } from '../../dist/index.js'
import { permutation } from './lib/spec.mjs'

const N = 100_000
const Position = new Trait({ x: f32(0), y: f32(0) })
const world = new World({ maxEntities: N + 16 })
const live = new Float64Array(N)
for (let i = 0; i < N; i++) live[i] = world.spawn(Position)

const shuffled = permutation(N)
const sequential = new Uint32Array(N)
for (let i = 0; i < N; i++) sequential[i] = i
const query = world.query(Position)

const run = async (label, fn) => {
  for (let i = 0; i < 3; i++) fn()
  const s = await measure(fn, { min_cpu_time: 1000e6 })
  console.log(
    label.padEnd(42),
    (s.avg / 1000).toFixed(0).padStart(5) + 'µs',
    (s.avg / N).toFixed(1).padStart(7) + ' ns/entity',
  )
}

await run('get + set, shuffled  (the benchmark)', () => {
  for (let i = 0; i < N; i++) {
    const e = live[shuffled[i]]
    world.set(e, Position.x, world.get(e, Position.x) + 1)
  }
})
await run('get + set, sequential order', () => {
  for (let i = 0; i < N; i++) {
    const e = live[sequential[i]]
    world.set(e, Position.x, world.get(e, Position.x) + 1)
  }
})
await run('get only, shuffled', () => {
  let acc = 0
  for (let i = 0; i < N; i++) acc += world.get(live[shuffled[i]], Position.x)
  return acc
})
await run('set only, shuffled', () => {
  for (let i = 0; i < N; i++) world.set(live[shuffled[i]], Position.x, 1)
})
await run('same 100k writes via each()', () => query.each((p) => (p.x += 1)))
