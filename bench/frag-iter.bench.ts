/**
 * `frag-iter` (SPEC §12.1): the same 100 000 entities spread over 26
 * archetypes and over one. Budget — the difference divided by the 25 extra
 * archetypes is the per-archetype fixed cost, and must stay under ~200ns.
 */
import { bench, describe } from 'vitest';

import { Data, fragmented } from './support';

const N = 100_000;

const spread = fragmented(N, 26);
const single = fragmented(N, 1);
const spreadQuery = spread.query(Data);
const singleQuery = single.query(Data);

describe('frag-iter', () => {
  bench('apecs each x26', () => {
    spreadQuery.each((d) => (d.value += 1));
  });

  bench('apecs each x1', () => {
    singleQuery.each((d) => (d.value += 1));
  });
});
