/**
 * `sorted-static` and `sorted-drift` (SPEC §12.1): iterating a sorted view
 * whose key nobody touched must cost one `lastWriteTick` compare per
 * archetype, and a 1% drift must cost one key pass plus an adaptive resort —
 * both far below what rebuilding the view from scratch costs.
 *
 * `ordered-iter` (SPEC §6.8): walking `orderBy(...).chunks()` on a clean
 * frame is the plain chunk walk plus the dirty check, against the
 * materialised `sortBy(...).each()` walk over the same order.
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

/** Ordered storage, settled: rows already in key order, so a walk pays only the dirty check. */
const orderedWorld = sortable(N);
const ordered = orderedWorld.world.query(Position, SortKey).orderBy(SortKey.value);
orderedWorld.world.step();
ordered.first;
const sortedWorld = sortable(N);
const sorted = sortedWorld.world.query(Position, SortKey).sortBy(SortKey.value);
sortedWorld.world.step();
sorted.first;
const plain = sortable(N).world.query(Position, SortKey);
let sink = 0;

describe('ordered-iter', () => {
  bench('apecs ordered chunks', () => {
    let sum = 0;
    for (const chunk of ordered.chunks()) {
      const { x } = chunk.get(Position);
      for (let i = chunk.length - 1; i >= 0; i--) {
        sum += x[i];
      }
    }
    sink += sum;
  });

  bench('apecs sorted each', () => {
    let sum = 0;
    sorted.each((p) => {
      sum += p.x;
    });
    sink += sum;
  });

  bench('apecs chunks', () => {
    let sum = 0;
    for (const chunk of plain.chunks()) {
      const { x } = chunk.get(Position);
      for (let i = chunk.length - 1; i >= 0; i--) {
        sum += x[i];
      }
    }
    sink += sum;
  });
});

export { sink };
