/**
 * The SPEC §12.1 budgets, and the reader that turns a vitest `--outputJson`
 * file into the medians they are stated against. Shared so the CI report and
 * the HTML report cannot drift into two different answers.
 */
import { readFileSync } from 'node:fs';

/** Every budget: what it measures, what it must be, and what §12.1 asks for. */
export const BUDGETS = [
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
    // Was 12: five traits in one process used to share one compiled driver and
    // one compiled cursor, and the sites inside them went megamorphic. Distinct
    // generated sources put this at ~2× (SPEC §12.2, rule 2).
    limit: 3,
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
    name: 'random-access · accessor vs baseline',
    spec: '25×',
    limit: 25,
    value: (m) => m('random-access', 'apecs accessor') / m('random-access', 'baseline'),
    format: (v) => `${v.toFixed(2)}×`,
  },
  {
    // Rows already in key order: the chunk walk plus one dirty check per archetype.
    name: 'ordered-iter · ordered chunks vs chunks',
    spec: '1.1×',
    limit: 1.1,
    value: (m) => m('ordered-iter', 'apecs ordered chunks') / m('ordered-iter', 'apecs chunks'),
    format: (v) => `${v.toFixed(2)}×`,
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
];

/**
 * Every benchmark in the file, keyed `suite name`, plus `median(suite, name)`.
 * Budgets read the median: one GC pause must not turn a ratio into a failure.
 */
export function readResults(path) {
  const files = JSON.parse(readFileSync(path, 'utf8')).files;
  const results = new Map();
  for (const file of files) {
    for (const group of file.groups) {
      const suite = group.fullName.split('>').pop().trim();
      for (const benchmark of group.benchmarks) {
        results.set(`${suite} ${benchmark.name}`, benchmark);
      }
    }
  }
  const median = (suite, name) => {
    const benchmark = results.get(`${suite} ${name}`);
    if (benchmark === undefined) {
      throw new Error(`no benchmark "${suite} > ${name}" in ${path}`);
    }
    return benchmark.median;
  };
  return { results, median };
}
