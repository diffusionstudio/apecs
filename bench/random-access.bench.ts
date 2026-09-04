/**
 * `random-access` (SPEC §12.1, §4.5): 100 000 entities, one field read and
 * written in shuffled order, by handle. Budget — the accessor within 25× of a
 * flat typed array indexed by entity id: three dependent cache misses against one.
 */
import { bench, describe } from 'vitest';

import { World } from '../src/index';
import type { Entity } from '../src/index';
import { Position, permutation } from './support';

const N = 100_000;

const world = new World({ maxEntities: N + 16 });
const live: Entity[] = new Array(N);
for (let i = 0; i < N; i++) {
  live[i] = world.spawn(Position);
}
const order = permutation(N);
const flat = new Float32Array(N);
const x = Position.x;
const px = world.accessor(x);

describe('random-access', () => {
  bench('baseline', () => {
    for (let i = 0; i < N; i++) {
      const e = order[i];
      flat[e] = flat[e] + 1;
    }
  });

  bench('apecs get/set', () => {
    for (let i = 0; i < N; i++) {
      const e = live[order[i]];
      world.set(e, x, world.get(e, x) + 1);
    }
  });

  bench('apecs accessor', () => {
    for (let i = 0; i < N; i++) {
      const e = live[order[i]];
      px.set(e, px.get(e) + 1);
    }
  });
});
