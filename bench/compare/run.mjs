/**
 * Orchestrator. Runs every (library × benchmark) in its own child process,
 * collects timings, the memory fit and the fairness census, and writes
 * `results.json` for `report.mjs` to render.
 *
 *   node run.mjs [--quick]
 */
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { promisify } from 'node:util';

import { ADAPTERS, BENCHMARKS } from './lib/spec.mjs';

const exec = promisify(execFile);
const QUICK = process.argv.includes('--quick');
const SIZES = QUICK ? [0, 50_000, 100_000] : [0, 25_000, 50_000, 100_000, 200_000];

async function child(args, env = {}) {
  const { stdout } = await exec(process.execPath, args, {
    cwd: import.meta.dirname,
    maxBuffer: 32 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
    env: { ...process.env, ...env },
  });
  const line = stdout.trim().split('\n').at(-1);
  return JSON.parse(line);
}

/** Least squares over (n, bytes); the slope is bytes per entity. */
function fit(points) {
  const k = points.length;
  const sx = points.reduce((a, p) => a + p.n, 0);
  const sy = points.reduce((a, p) => a + p.bytes, 0);
  const sxx = points.reduce((a, p) => a + p.n * p.n, 0);
  const sxy = points.reduce((a, p) => a + p.n * p.bytes, 0);
  const slope = (k * sxy - sx * sy) / (k * sxx - sx * sx);
  return { perEntity: slope, fixed: (sy - slope * sx) / k };
}

const results = { meta: {}, census: {}, timings: {}, memory: {}, errors: [] };

results.meta = {
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  cpus: (await import('node:os')).cpus()[0]?.model ?? 'unknown',
  when: new Date().toISOString(),
  quick: QUICK,
  minCpuTimeMs: 1000,
};

console.log(`node ${results.meta.node} · ${results.meta.cpus}\n`);

console.log('census — every library must match the same entities');
for (const adapter of ADAPTERS) {
  results.census[adapter] = await child(['census.mjs', adapter]);
  console.log(`  ${adapter.padEnd(9)} ${JSON.stringify(results.census[adapter])}`);
}
{
  const ref = results.census.baseline;
  for (const [adapter, counts] of Object.entries(results.census)) {
    for (const key of Object.keys(ref)) {
      if (key === 'adapter') {
        continue;
      }
      if (counts[key] !== ref[key]) {
        results.errors.push(`${adapter} ${key}: matched ${counts[key]}, expected ${ref[key]}`);
      }
    }
  }
}
if (results.errors.length) {
  console.error('\nFAIRNESS FAILURE — refusing to publish timings:');
  for (const e of results.errors) {
    console.error('  ' + e);
  }
  writeFileSync('results.json', JSON.stringify(results, null, 2));
  process.exit(1);
}
console.log('  all libraries match identical entity counts\n');

console.log('timings');
const names = [...Object.keys(BENCHMARKS), 'frame_overhead'];
for (const bench of names) {
  results.timings[bench] = {};
  for (const adapter of ADAPTERS) {
    try {
      const out = await child(['run-one.mjs', adapter, bench]);
      if (Object.keys(out.variants).length === 0) {
        continue;
      }
      results.timings[bench][adapter] = out;
      const shown = Object.entries(out.variants)
        .map(([tier, s]) => `${tier} ${s.error ? 'ERR' : (s.avg / 1000).toFixed(1) + 'µs'}`)
        .join('  ');
      console.log(`  ${bench.padEnd(14)} ${adapter.padEnd(9)} ${shown}`);
    } catch (error) {
      results.errors.push(`${adapter} ${bench}: ${error.message}`);
      console.log(`  ${bench.padEnd(14)} ${adapter.padEnd(9)} FAILED`);
    }
  }
}

console.log('\nmemory');
for (const adapter of ADAPTERS) {
  const points = [];
  for (const n of SIZES) {
    const out = await child(['--expose-gc', 'memory.mjs', adapter, String(n)]);
    points.push({ n: out.n, bytes: out.bytes });
  }
  results.memory[adapter] = { points, ...fit(points) };
  console.log(`  ${adapter.padEnd(9)} ${results.memory[adapter].perEntity.toFixed(1)} B/entity`);
}

writeFileSync('results.json', JSON.stringify(results, null, 2));
console.log('\nwrote results.json');
