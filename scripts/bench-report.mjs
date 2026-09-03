/**
 * Publishes the SPEC §12.1 benchmark numbers and fails on regression.
 *
 * The budgets are ratios between benchmarks of the same run, never absolute
 * times: a CI runner's absolute numbers say nothing, but "`chunks` is within
 * 1.1× of the hand-written loop" holds on any machine.
 *
 *   node scripts/bench-report.mjs [results.json]
 */
import { appendFileSync, readFileSync } from 'node:fs'

const RESULTS = process.argv[2] ?? 'bench/results.json'

/** Every budget: what it measures, what it must be, and what §12.1 asks for. */
const BUDGETS = [
  {
    name: 'simple-iter · each vs baseline',
    spec: '1.5×',
    limit: 2.5,
    value: (m) => m('simple-iter', 'apecs each') / m('simple-iter', 'baseline'),
    format: (v) => `${v.toFixed(2)}×`,
  },
  {
    name: 'simple-iter · chunks vs baseline',
    spec: '1.1×',
    limit: 1.1,
    value: (m) => m('simple-iter', 'apecs chunks') / m('simple-iter', 'baseline'),
    format: (v) => `${v.toFixed(2)}×`,
  },
  {
    name: 'packed-5 · chunks vs baseline',
    spec: 'parity',
    limit: 1.3,
    value: (m) => m('packed-5', 'apecs chunks') / m('packed-5', 'baseline'),
    format: (v) => `${v.toFixed(2)}×`,
  },
  {
    name: 'packed-5 · each vs baseline',
    spec: 'parity',
    limit: 12,
    value: (m) => m('packed-5', 'apecs each') / m('packed-5', 'baseline'),
    format: (v) => `${v.toFixed(2)}×`,
  },
  {
    name: 'frag-iter · fixed cost per archetype',
    spec: '≤ 200ns',
    limit: 200,
    // 26 archetypes against one, over the same 100 000 entities.
    value: (m) =>
      Math.max(
        0,
        ((m('frag-iter', 'apecs each x26') - m('frag-iter', 'apecs each x1')) * 1e6) / 25,
      ),
    format: (v) => `${v.toFixed(0)}ns`,
  },
  {
    name: 'sorted-static · rebuild vs clean',
    spec: 'zero work',
    limit: -100,
    value: (m) =>
      m('sorted-static', 'apecs sorted (rebuild)') / m('sorted-static', 'apecs sorted (clean)'),
    format: (v) => `${v.toFixed(0)}× cheaper`,
  },
  {
    // The writes themselves are not the sort's cost, so they come off first.
    name: 'sorted-drift · resort vs rebuild',
    spec: 'no full n log n',
    limit: 1,
    value: (m) =>
      Math.max(
        0,
        m('sorted-drift', 'apecs sorted (1% drift)') - m('sorted-drift', 'apecs drift writes'),
      ) / m('sorted-static', 'apecs sorted (rebuild)'),
    format: (v) => `${v.toFixed(2)}×`,
  },
]

const files = JSON.parse(readFileSync(RESULTS, 'utf8')).files
const results = new Map()

for (const file of files) {
  for (const group of file.groups) {
    const suite = group.fullName.split('>').pop().trim()
    for (const benchmark of group.benchmarks) {
      results.set(`${suite} ${benchmark.name}`, benchmark)
    }
  }
}

/** Budgets read the median: one GC pause must not turn a ratio into a failure. */
function median(suite, name) {
  const benchmark = results.get(`${suite} ${name}`)
  if (benchmark === undefined) throw new Error(`no benchmark "${suite} > ${name}" in ${RESULTS}`)
  return benchmark.median
}

const lines = [
  '## Benchmarks (SPEC §12.1)',
  '',
  '| benchmark | median | mean | ops/s | ±rme |',
  '| --- | --- | --- | --- | --- |',
]
for (const [key, benchmark] of results) {
  const at = key.indexOf(' ')
  lines.push(
    `| ${key.slice(0, at)} · ${key.slice(at + 1)} | ${benchmark.median.toFixed(4)} ms | ` +
      `${benchmark.mean.toFixed(4)} ms | ${Math.round(benchmark.hz).toLocaleString('en-US')} | ` +
      `${benchmark.rme.toFixed(1)}% |`,
  )
}

lines.push('', '| budget | measured | limit | §12.1 target | |', '| --- | --- | --- | --- | --- |')

let failed = 0
for (const budget of BUDGETS) {
  const value = budget.value(median)
  // A negative limit reads as "at least this much", for the ratios that must be large.
  const ok = budget.limit < 0 ? value >= -budget.limit : value <= budget.limit
  if (!ok) failed++
  const limit = budget.limit < 0 ? `≥ ${-budget.limit}×` : `≤ ${budget.format(budget.limit)}`
  lines.push(
    `| ${budget.name} | ${budget.format(value)} | ${limit} | ${budget.spec} | ${ok ? '✅' : '❌'} |`,
  )
}

const report = lines.join('\n')
console.log(report)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`)

if (failed > 0) {
  console.error(`\n${failed} benchmark budget(s) exceeded`)
  process.exit(1)
}
