/**
 * `entity-cycle` (SPEC §12.1): spawn and despawn 100 000 entities per pass.
 * The allocation half of the budget is asserted in `tests/alloc.test.ts`.
 */
import { bench, describe } from 'vitest';

import { World } from '../src/index';
import type { Entity } from '../src/index';
import { Position, Velocity } from './support';

const N = 100_000;

const world = new World({ maxEntities: N });
const live: Entity[] = new Array(N);

/** The hand-written equivalent: an id free list over parallel arrays. */
const ids = new Uint32Array(N);
const generations = new Uint16Array(N);
let free = 0;

describe('entity-cycle', () => {
  bench('baseline', () => {
    for (let i = 0; i < N; i++) {
      ids[free++] = i;
    }
    while (free > 0) {
      generations[ids[--free]]++;
    }
  });

  bench('apecs spawn/despawn', () => {
    for (let i = 0; i < N; i++) {
      live[i] = world.spawn(Position, Velocity);
    }
    for (let i = 0; i < N; i++) {
      world.despawn(live[i]);
    }
  });
});
