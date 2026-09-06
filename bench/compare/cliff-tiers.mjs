/**
 * The trait-count sweep across apecs' own two tiers: `each` and `chunks`.
 * N entities carrying k distinct traits, one pass per trait, each pass at its
 * OWN call site — one system per trait, the way a program is actually written.
 *
 * ONE k per process, as cliff-cross.mjs: sweeping k inside a single process
 * pollutes every earlier k's shapes into the dispatch sites being measured, so
 * the cliff would appear even if k alone did not cause it.
 *
 *   node cliff-tiers.mjs <each|chunks> <k>
 */
import { measure } from 'mitata';

const N = 1000;
const tier = process.argv[2];
const k = Number(process.argv[3]);

const { Trait, World, f32 } = await import('../../dist/index.js');
const traits = Array.from({ length: k }, () => new Trait({ value: f32(0) }));
const world = new World();
for (let i = 0; i < N; i++) {
  world.spawn(...traits);
}
const queries = traits.map((t) => world.query(t));

const site = {
  each: (i) => `qs[${i}].each((t) => (t.value += 1));\n`,
  chunks: (i) =>
    `for (const c of qs[${i}].chunks()) { const v = c.get(ts[${i}]).value;` +
    ` for (let r = 0, n = c.length; r < n; r++) { v[r] += 1; } }\n`,
};

let source = '';
for (let i = 0; i < k; i++) {
  source += site[tier](i);
}
const fn = new Function('qs', 'ts', source).bind(null, queries, traits);

for (let i = 0; i < 5; i++) {
  fn();
}
const ns = (await measure(fn, { min_cpu_time: 700e6 })).avg / (k * N);
console.log(JSON.stringify({ tier, k, ns }));
