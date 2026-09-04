/**
 * The layout tradeoff with no ECS in the way — just typed arrays.
 *
 * bitECS stores a component as one flat array indexed by entity id. apecs
 * stores it as dense per-archetype columns indexed by row. The two choices are
 * not independently optimisable: whichever one you index directly is fast, and
 * the other becomes a gather. This measures both directions on both layouts,
 * so the cost of "just do what bitECS does" is visible without any library
 * overhead confusing it.
 *
 *   node layout-physics.mjs
 */
import { measure } from 'mitata';
import { permutation } from './lib/spec.mjs';

const N = 100_000;
const SPREAD = 2; // live entity ids occupy 2x the space, as they do after churn

const dense = new Float32Array(N); // archetype column: row-indexed, compact
const flat = new Float32Array(N * SPREAD); // id-indexed, holes where ids are dead
const ids = new Uint32Array(N); // the live entity ids, ascending
for (let i = 0; i < N; i++) {
  ids[i] = i * SPREAD;
}
const rows = new Uint32Array(N); // row of each entity, ascending
for (let i = 0; i < N; i++) {
  rows[i] = i;
}
const shuffled = permutation(N);

const run = async (label, fn) => {
  for (let i = 0; i < 3; i++) {
    fn();
  }
  const s = await measure(fn, { min_cpu_time: 1000e6 });
  console.log(`  ${label.padEnd(46)} ${(s.avg / N).toFixed(2).padStart(6)} ns/entity`);
};

console.log('\nITERATE (walk everything once)');
await run('dense column, sequential  ← apecs chunks', () => {
  for (let i = 0; i < N; i++) {
    dense[i] += 1;
  }
});
await run('flat id-indexed, via id list  ← bitECS', () => {
  for (let i = 0; i < N; i++) {
    flat[ids[i]] += 1;
  }
});

console.log('\nRANDOM ACCESS (touch every entity once, shuffled order)');
await run('flat id-indexed, direct  ← bitECS', () => {
  for (let i = 0; i < N; i++) {
    const e = ids[shuffled[i]];
    flat[e] = flat[e] + 1;
  }
});
await run('dense column, id→row indirection  ← apecs', () => {
  for (let i = 0; i < N; i++) {
    const r = rows[shuffled[i]];
    dense[r] = dense[r] + 1;
  }
});
