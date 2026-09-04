/**
 * Merges several `run.mjs` outputs into one result set.
 *
 * A single pass on a laptop is not trustworthy: across three runs some
 * competitor cells moved 30-75% while apecs's moved under 2%, which is
 * background load, not a property of any library. So each cell keeps the
 * MINIMUM across runs — the least-contaminated sample, and the standard robust
 * estimator for a benchmark — and records the observed spread so the report
 * can say how noisy the measurement was.
 *
 *   node merge.mjs out.json run-a.json run-b.json run-c.json
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [out, ...inputs] = process.argv.slice(2);
if (inputs.length < 2) {
  throw new Error('need at least two runs to merge');
}
const runs = inputs.map((f) => JSON.parse(readFileSync(f, 'utf8')));
const merged = structuredClone(runs[0]);
merged.meta.runs = runs.length;
merged.meta.mergedFrom = inputs;
merged.meta.estimator = 'per-cell minimum across runs';

let worst = { cell: null, spread: 0 };

for (const [bench, byLib] of Object.entries(merged.timings)) {
  for (const [lib, entry] of Object.entries(byLib)) {
    for (const [tier, stats] of Object.entries(entry.variants)) {
      if (stats.error) {
        continue;
      }
      const seen = runs
        .map((r) => r.timings[bench]?.[lib]?.variants?.[tier])
        .filter((v) => v && !v.error)
        .map((v) => v.avg);
      if (seen.length === 0) {
        continue;
      }
      const lo = Math.min(...seen);
      const hi = Math.max(...seen);
      stats.avg = lo;
      stats.spread = (hi - lo) / lo;
      stats.samples = seen.length;
      if (stats.spread > worst.spread) {
        worst = { cell: `${bench} · ${lib} · ${tier}`, spread: stats.spread };
      }
    }
  }
}

for (const [lib, mem] of Object.entries(merged.memory)) {
  const seen = runs.map((r) => r.memory[lib]?.perEntity).filter((v) => typeof v === 'number');
  mem.perEntity = Math.min(...seen);
  mem.spread = (Math.max(...seen) - Math.min(...seen)) / Math.min(...seen);
}

merged.meta.worstSpread = worst;
writeFileSync(out, JSON.stringify(merged, null, 2));
console.log(`merged ${runs.length} runs -> ${out}`);
console.log(`worst per-cell spread: ${worst.cell} at ${(worst.spread * 100).toFixed(0)}%`);
