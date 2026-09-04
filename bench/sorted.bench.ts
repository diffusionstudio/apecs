/**
 * `sorted-static` and `sorted-drift` (SPEC §12.1): iterating a sorted view
 * whose key nobody touched must cost one `lastWriteTick` compare per
 * archetype, and a 1% drift must cost one key pass plus an adaptive resort —
 * both far below what rebuilding the view from scratch costs.
 */
import { bench, describe } from 'vitest';

import { Position, SortKey, sortable } from './support';

const N = 100_000;

/**
 * A view settles only once the tick moves past the writes that built it, so
 * every world here takes a step before its first walk (SPEC §8.3).
 */
function settled() {
  const built = sortable(N);
  const view = built.world.query(Position, SortKey).sortBy(SortKey.value);
  built.world.step();
  view.entities();
  return { ...built, view };
}

const stable = settled();
const drifting = settled();
const rebuilding = settled();
let cursor = 0;

/** `first` materialises the order and reads one row: the access cost, nothing else. */
describe('sorted-static', () => {
  bench('apecs sorted (clean)', () => {
    if (stable.view.first === undefined) {
      throw new Error('unreachable');
    }
  });

  bench('apecs sorted (rebuild)', () => {
    rebuilding.view.rebuild();
    if (rebuilding.view.first === undefined) {
      throw new Error('unreachable');
    }
  });
});

/** The same 1% of keys rewritten, without a sorted view watching them. */
const unsorted = sortable(N);

describe('sorted-drift', () => {
  bench('apecs sorted (1% drift)', () => {
    const world = drifting.world;
    world.step();
    for (let i = 0; i < N / 100; i++) {
      const entity = drifting.entities[(cursor = (cursor + 7919) % N)];
      world.set(entity, SortKey.value, (cursor * 31) % N);
    }
    if (drifting.view.first === undefined) {
      throw new Error('unreachable');
    }
  });

  bench('apecs drift writes', () => {
    const world = unsorted.world;
    world.step();
    for (let i = 0; i < N / 100; i++) {
      const entity = unsorted.entities[(cursor = (cursor + 7919) % N)];
      world.set(entity, SortKey.value, (cursor * 31) % N);
    }
  });
});
