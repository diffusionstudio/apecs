/**
 * Publishes the SPEC §12.1 benchmark numbers and fails on regression.
 *
 * The budgets are ratios between benchmarks of the same run, never absolute
 * times: a CI runner's absolute numbers say nothing, but "`chunks` is within
 * 1.1× of the hand-written loop" holds on any machine.
 *
 *   node scripts/bench-report.mjs [results.json]
 */
import { appendFileSync } from 'node:fs';

import { BUDGETS, readResults } from './bench-budgets.mjs';

const RESULTS = process.argv[2] ?? 'bench/results.json';

const { results, median } = readResults(RESULTS);

const lines = [
  '## Benchmarks (SPEC §12.1)',
  '',
  '| benchmark | median | mean | ops/s | ±rme |',
  '| --- | --- | --- | --- | --- |',
];
for (const [key, benchmark] of results) {
  const at = key.indexOf(' ');
  lines.push(
    `| ${key.slice(0, at)} · ${key.slice(at + 1)} | ${benchmark.median.toFixed(4)} ms | ` +
      `${benchmark.mean.toFixed(4)} ms | ${Math.round(benchmark.hz).toLocaleString('en-US')} | ` +
      `${benchmark.rme.toFixed(1)}% |`,
  );
}

lines.push('', '| budget | measured | limit | §12.1 target | |', '| --- | --- | --- | --- | --- |');

let failed = 0;
for (const budget of BUDGETS) {
  const value = budget.value(median);
  // A negative limit reads as "at least this much", for the ratios that must be large.
  const ok = budget.limit < 0 ? value >= -budget.limit : value <= budget.limit;
  if (!ok) {
    failed++;
  }
  const limit = budget.limit < 0 ? `≥ ${-budget.limit}×` : `≤ ${budget.format(budget.limit)}`;
  lines.push(
    `| ${budget.name} | ${budget.format(value)} | ${limit} | ${budget.spec} | ${ok ? '✅' : '❌'} |`,
  );
}

const report = lines.join('\n');
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
}

if (failed > 0) {
  console.error(`\n${failed} benchmark budget(s) exceeded`);
  process.exit(1);
}
