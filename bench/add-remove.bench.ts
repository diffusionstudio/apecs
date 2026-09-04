/**
 * `add-remove` (SPEC §12.1): 100 000 trait adds and removals — two map
 * lookups and one row move each.
 */
import { bench, describe } from 'vitest';

import { Position, Velocity, movers } from './support';

const N = 100_000;

const world = movers(0);
const live = Array.from({ length: N }, () => world.spawn(Position));

describe('add-remove', () => {
  bench('apecs add/remove', () => {
    for (let i = 0; i < N; i++) {
      world.add(live[i], Velocity);
    }
    for (let i = 0; i < N; i++) {
      world.remove(live[i], Velocity);
    }
  });

  bench('apecs addMany/removeMany', () => {
    world.addMany(live, Velocity);
    world.removeMany(live, Velocity);
  });
});
