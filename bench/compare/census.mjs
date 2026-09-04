/**
 * The fairness gate: every library must match the same number of entities on
 * every query-shaped benchmark. A library whose query silently matches nothing
 * would post a spectacular, meaningless time — this is what catches that.
 *
 *   node census.mjs <adapter>     (one adapter per process; becsy is async)
 */
import { BENCHMARKS } from './lib/spec.mjs';

const key = process.argv[2];
const adapter = await import(`./adapters/${key}.mjs`);
const params = {
  entities: BENCHMARKS.frag_iter.params.entities,
  archetypes: BENCHMARKS.frag_iter.params.archetypes,
  excluded: BENCHMARKS.mixed_query.params.excluded,
};
// packed_* use their own entity counts.
const counts = await adapter.census({
  ...params,
  entities: BENCHMARKS.packed_1.params.entities,
});
const fragCounts = await adapter.census(params);
process.stdout.write(
  JSON.stringify({
    adapter: key,
    packed_1: counts.packed_1,
    packed_5: counts.packed_5,
    simple_iter: fragCounts.simple_iter,
    frag_iter: fragCounts.frag_iter,
    mixed_query: fragCounts.mixed_query,
  }) + '\n',
);
