/**
 * The one-entry inline cache looked great with every entity in one archetype.
 * Real worlds are fragmented, and a shuffled walk then thrashes a 1-entry
 * cache into a Map.get per access. Compares it against a dense table indexed
 * by archetype id, over 1 / 4 / 26 archetypes.
 *
 *   node proto-accessor-frag.mjs <archetypeCount>
 */
import { measure } from 'mitata';
import { Trait, World, f32 } from '../../dist/index.js';
import { $archetypes, $entities, $id, $index, entityId } from '../../dist/internal.js';
import { permutation } from './lib/spec.mjs';

const N = 100_000;
const K = Number(process.argv[2] ?? 1);
const Position = new Trait({ x: f32(0), y: f32(0) });
const FILLER = Array.from({ length: 26 }, () => new Trait({ v: f32(0) }));

const world = new World({ maxEntities: N + 16 });
const live = new Float64Array(N);
for (let i = 0; i < N; i++) {
  live[i] = world.spawn(Position, FILLER[i % K]);
}
const order = permutation(N);

const entities = world[$entities];
const graph = world[$archetypes];
const traitId = Position[$id];
const fi = Position.x[$index];

const bindOf = (a) => {
  const column = graph.list[a].columnsOf.get(traitId)[fi];
  return {
    pages: column.pages,
    shift: 31 - Math.clz32(column.pageSize),
    mask: column.pageSize - 1,
  };
};

/** C1 — one-entry inline cache. */
function oneEntry() {
  let key = -1,
    pages = null,
    shift = 0,
    mask = 0;
  return (e, d) => {
    const id = entityId(e);
    const a = entities.archetypes[id];
    if (a !== key) {
      const b = bindOf(a);
      pages = b.pages;
      shift = b.shift;
      mask = b.mask;
      key = a;
    }
    const row = entities.rows[id];
    pages[row >>> shift][row & mask] += d;
  };
}

/** C2 — dense table indexed by archetype id, filled lazily. */
function denseTable() {
  const table = [];
  return (e, d) => {
    const id = entityId(e);
    const a = entities.archetypes[id];
    let b = table[a];
    if (b === undefined) {
      b = table[a] = bindOf(a);
    }
    const row = entities.rows[id];
    b.pages[row >>> b.shift][row & b.mask] += d;
  };
}

const c1 = oneEntry(),
  c2 = denseTable();
const run = async (label, fn) => {
  for (let i = 0; i < 3; i++) {
    fn();
  }
  const s = await measure(fn, { min_cpu_time: 1200e6 });
  console.log(`  ${label.padEnd(34)} ${(s.avg / N).toFixed(1).padStart(6)} ns/entity`);
};

console.log(`${K} archetype(s), ${N} entities, shuffled:`);
await run('world.get + world.set (today)', () => {
  for (let i = 0; i < N; i++) {
    const e = live[order[i]];
    world.set(e, Position.x, world.get(e, Position.x) + 1);
  }
});
await run('C1 · one-entry inline cache', () => {
  for (let i = 0; i < N; i++) {
    c1(live[order[i]], 1);
  }
});
await run('C2 · dense table by archetype', () => {
  for (let i = 0; i < N; i++) {
    c2(live[order[i]], 1);
  }
});
