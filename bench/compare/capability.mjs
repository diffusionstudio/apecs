/**
 * Capability benchmark: iterating a query in sorted order, every frame.
 *
 * apecs caches the order and rebuilds only when a key actually moves (SPEC
 * §12.1 budgets *zero work* when nothing changed), and offers two ways to get
 * it: `sortBy` keeps the order in a side array, `orderBy` permutes the
 * archetype's own rows so the order *is* the storage layout and `chunks` works
 * (SPEC §6.8). koota's QueryResult.sort() re-sorts on demand. bitECS and becsy
 * ship no sorting, so their honest cost is the hand-written one: copy the ids
 * out and Array.sort them — which is also what an apecs or koota user would
 * write without the feature.
 *
 * Two regimes: `static` (no key ever changes) and `drift` (1% of keys change
 * per frame). The gap between them is the whole point of caching the order.
 *
 * Every apecs frame includes the `world.step()` a real frame pays: the dirty
 * check is tick-based (SPEC §8.3), so a view only settles once the tick has
 * moved past the writes that built it. Without it apecs would be measured
 * re-sorting every frame in the regime that exists to show it does not.
 *
 *   node capability.mjs <apecs|apecs-ordered|apecs-ordered-chunks|koota|handwritten> <static|drift>
 */
import { measure } from 'mitata';

const N = 100_000;
const CHURN = N / 100;
const [which, regime] = process.argv.slice(2);
const key = (i) => (i * 2654435761) % N;

let fn;
let label;
/** apecs only: the dirty level the last measured frame left behind, as a check
 *  that `static` really is measuring a clean view and not a hidden resort. */
let probe = () => undefined;

if (which.startsWith('apecs')) {
  const { Trait, World, f32 } = await import('../../dist/index.js');
  const Position = new Trait({ x: f32(0) });
  const SortKey = new Trait({ value: f32(0) });
  const world = new World({ maxEntities: N + 16 });
  const live = [];
  for (let i = 0; i < N; i++) {
    live.push(world.spawn(Position({ x: i }), SortKey({ value: key(i) })));
  }
  const query = world.query(Position, SortKey);
  const ordered = which !== 'apecs';
  const view = ordered ? query.orderBy(SortKey.value) : query.sortBy(SortKey.value);
  const x = Position.x;
  probe = () => view.isDirty;
  let tick = 0;
  const frame = () => {
    world.step();
    if (regime === 'drift') {
      for (let i = 0; i < CHURN; i++) {
        const e = live[(tick * CHURN + i) % N];
        world.set(e, SortKey.value, (tick * 7919 + i) % N);
      }
      tick++;
    }
  };
  if (which === 'apecs-ordered-chunks') {
    fn = () => {
      frame();
      // The permute happens on first access, before any walk is open (SPEC §6.8).
      for (const chunk of view.chunks()) {
        const column = chunk.column(x);
        for (let i = chunk.length - 1; i >= 0; i--) {
          column[i] += 1;
        }
      }
    };
    label = 'apecs orderBy + chunks';
  } else {
    fn = () => {
      frame();
      view.each((p) => (p.x += 1));
    };
    label = ordered ? 'apecs orderBy + each' : 'apecs sortBy';
  }
} else if (which === 'koota') {
  const { createWorld, getStore, trait } = await import('koota');
  const Position = trait({ x: 0 });
  const SortKey = trait({ value: 0 });
  const world = createWorld();
  const live = [];
  for (let i = 0; i < N; i++) {
    live.push(world.spawn(Position({ x: i }), SortKey({ value: key(i) })));
  }
  const store = getStore(world, SortKey);
  const ID = 0xfffff;
  let tick = 0;
  fn = () => {
    if (regime === 'drift') {
      for (let i = 0; i < CHURN; i++) {
        const e = live[(tick * CHURN + i) % N];
        e.set(SortKey, { value: (tick * 7919 + i) % N });
      }
      tick++;
    }
    const result = world
      .query(Position, SortKey)
      .sort((a, b) => store.value[a & ID] - store.value[b & ID]);
    result.updateEach(([p]) => (p.x += 1));
  };
  label = 'koota sort()';
} else {
  // What you write when the library has none: an id array sorted by key.
  const x = new Float32Array(N);
  const keys = new Float32Array(N);
  const ids = new Uint32Array(N);
  for (let i = 0; i < N; i++) {
    ids[i] = i;
    keys[i] = key(i);
  }
  let order = Array.from(ids);
  let tick = 0;
  fn = () => {
    if (regime === 'drift') {
      for (let i = 0; i < CHURN; i++) {
        keys[(tick * CHURN + i) % N] = (tick * 7919 + i) % N;
      }
      tick++;
    }
    order.sort((a, b) => keys[a] - keys[b]);
    for (let i = 0; i < N; i++) {
      x[order[i]] += 1;
    }
  };
  label = 'hand-written sort';
}

for (let i = 0; i < 3; i++) {
  fn();
}
const s = await measure(fn, { min_cpu_time: 1500e6 });
console.log(
  JSON.stringify({ library: which, label, regime, avgUs: s.avg / 1000, dirtyAfter: probe() }),
);
