/**
 * "Could the accessor just do what bitECS does and reach 1.3x?"
 *
 * bitECS's random access is fast because of a LAYOUT choice, not an accessor
 * trick: every component is a flat typed array indexed by entity id, so a read
 * is one array index with no indirection. apecs stores data in dense
 * per-archetype columns, so it pays entity -> archetype -> row -> page.
 *
 * Copying the layout would reach bitECS's number trivially — it *is* bitECS's
 * number. The question is what the layout costs everywhere else, which is what
 * this measures: random access AND iteration, on a fresh world and after
 * entity churn has fragmented the id space.
 *
 *   node layout-tradeoff.mjs
 */
import { measure } from 'mitata'
import * as bit from 'bitecs'
import { Trait, World, f32 } from '../../dist/index.js'
import { permutation } from './lib/spec.mjs'

const N = 100_000
const order = permutation(N)

const run = async (label, fn) => {
  for (let i = 0; i < 3; i++) fn()
  const s = await measure(fn, { min_cpu_time: 1000e6 })
  console.log(
    `  ${label.padEnd(44)} ${(s.avg / 1000).toFixed(0).padStart(5)}µs  ${(s.avg / N).toFixed(2).padStart(6)} ns/entity`,
  )
  return s.avg / N
}

/** Churn: despawn every other entity, then refill. Fragments the id space. */
function churn(despawn, spawn, live) {
  for (let i = 0; i < live.length; i += 2) despawn(live[i])
  for (let i = 0; i < live.length; i += 2) live[i] = spawn()
}

console.log('\n== apecs: table storage (today) ==')
{
  const P = new Trait({ x: f32(0) })
  const w = new World({ maxEntities: N * 2 })
  const live = new Float64Array(N)
  for (let i = 0; i < N; i++) live[i] = w.spawn(P)
  const acc = w.accessor(P.x)
  const q = w.query(P)
  await run('random access · accessor', () => {
    for (let i = 0; i < N; i++) {
      const e = live[order[i]]
      acc.set(e, acc.get(e) + 1)
    }
  })
  await run('iterate · chunks (fresh)', () => {
    for (const c of q.chunks()) {
      const col = c.column(P.x)
      for (let i = 0, n = c.length; i < n; i++) col[i] += 1
    }
  })
  churn(
    (e) => w.despawn(e),
    () => w.spawn(P),
    live,
  )
  await run('iterate · chunks (after churn)', () => {
    for (const c of q.chunks()) {
      const col = c.column(P.x)
      for (let i = 0, n = c.length; i < n; i++) col[i] += 1
    }
  })
}

console.log('\n== bitECS: flat array indexed by entity id ==')
{
  const w = bit.createWorld()
  const P = { x: new Float32Array(N * 2 + 1024) }
  const live = new Uint32Array(N)
  for (let i = 0; i < N; i++) {
    const e = bit.addEntity(w)
    bit.addComponent(w, e, P)
    live[i] = e
  }
  const terms = [P]
  await run('random access · direct index', () => {
    const x = P.x
    for (let i = 0; i < N; i++) {
      const e = live[order[i]]
      x[e] = x[e] + 1
    }
  })
  await run('iterate · query + index (fresh)', () => {
    const ents = bit.query(w, terms)
    const x = P.x
    for (let i = 0, n = ents.length; i < n; i++) x[ents[i]] += 1
  })
  churn(
    (e) => bit.removeEntity(w, e),
    () => {
      const e = bit.addEntity(w)
      bit.addComponent(w, e, P)
      return e
    },
    live,
  )
  await run('iterate · query + index (after churn)', () => {
    const ents = bit.query(w, terms)
    const x = P.x
    for (let i = 0, n = ents.length; i < n; i++) x[ents[i]] += 1
  })
}
