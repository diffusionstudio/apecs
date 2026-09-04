/**
 * Isolates apecs's sorted iteration. SPEC §12.1 budgets "zero work" for a
 * sorted query whose keys never move — one lastWriteTick compare per matching
 * archetype, then iterate. So `sorted.each` on a clean view should cost about
 * what a gather over a precomputed order costs, and no more.
 */
import { measure } from 'mitata';
import { Trait, World, f32 } from '../../dist/index.js';

const N = 100_000;
const Position = new Trait({ x: f32(0) });
const SortKey = new Trait({ value: f32(0) });
const world = new World({ maxEntities: N + 16 });
for (let i = 0; i < N; i++) {
  world.spawn(Position({ x: i }), SortKey({ value: (i * 2654435761) % N }));
}

const plain = world.query(Position, SortKey);
const sorted = plain.sortBy(SortKey.value);

const run = async (label, fn) => {
  for (let i = 0; i < 3; i++) {
    fn();
  }
  const s = await measure(fn, { min_cpu_time: 1200e6 });
  console.log(
    label.padEnd(42),
    (s.avg / 1000).toFixed(0).padStart(6) + 'µs',
    (s.avg / N).toFixed(1).padStart(7) + ' ns/entity',
  );
  return s.avg;
};

await run('plain each (linear)', () => plain.each((p) => (p.x += 1)));
await run('sorted each, keys never touched', () => sorted.each((p) => (p.x += 1)));

// A hand-written gather over a fixed order: the floor for sorted iteration.
const order = new Uint32Array(N);
{
  const idx = Array.from({ length: N }, (_, i) => i);
  const keys = idx.map((i) => (i * 2654435761) % N);
  idx.sort((a, b) => keys[a] - keys[b]);
  order.set(idx);
}
const col = new Float32Array(N);
await run('hand-written gather over fixed order', () => {
  for (let i = 0; i < N; i++) {
    col[order[i]] += 1;
  }
});

// And the entities() call on its own, to see whether the cost is the rebuild
// check or the iteration.
await run('sorted.entities() only', () => sorted.entities());
