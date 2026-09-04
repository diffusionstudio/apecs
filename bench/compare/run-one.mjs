/**
 * Child process: measures every variant of ONE benchmark for ONE library and
 * prints a JSON line.
 *
 * One process per (library, benchmark) pair is not paranoia. Loading four ECS
 * libraries into one isolate makes the shared call sites in the iteration path
 * megamorphic, and V8 then deoptimises whichever library warmed up second.
 * That alone moves results by more than anything we are trying to measure.
 *
 *   node run-one.mjs <adapter> <benchmark>
 */
import { measure } from 'mitata';

import { BENCHMARKS } from './lib/spec.mjs';

const [adapterName, benchName] = process.argv.slice(2);
const adapter = await import(`./adapters/${adapterName}.mjs`);
const spec = BENCHMARKS[benchName] ?? { params: {} };

const out = {
  adapter: adapter.name,
  key: adapterName,
  version: adapter.version,
  notes: adapter.notes,
  benchmark: benchName,
  variants: {},
};

for (const [key, factory] of Object.entries(adapter.benchmarks)) {
  const [bench, tier] = key.split('/');
  if (bench !== benchName) {
    continue;
  }
  try {
    const run = await factory(spec.params);
    // Warm up outside the measurement so JIT tiering is not part of the number.
    for (let i = 0; i < 3; i++) {
      await run();
    }
    const stats = await measure(run, { min_cpu_time: 1_000e6, inner_gc: false });
    out.variants[tier] = {
      avg: stats.avg,
      p50: stats.p50,
      p75: stats.p75,
      p99: stats.p99,
      min: stats.min,
      samples: stats.samples.length,
    };
  } catch (error) {
    out.variants[tier] = { error: error.message };
  }
}

process.stdout.write(JSON.stringify(out) + '\n');
