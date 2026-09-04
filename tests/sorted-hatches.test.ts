import { afterEach, describe, expect, test, vi } from 'vitest';

import { Trait, World } from '../src/index';
import type { Entity } from '../src/index';
import { $view, resetWarnOnce } from '../src/internal';

const SortIndex = new Trait({ value: 0 });
const IsActive = new Trait();

afterEach(() => {
  vi.restoreAllMocks();
  resetWarnOnce();
});

function values(world: World, sorted: Iterable<number>): number[] {
  return Array.from(sorted, (e) => world.get(e as Entity, SortIndex.value) as number);
}

function settled() {
  const world = new World();
  const spawned = [3, 1, 2].map((value) => world.spawn(SortIndex({ value })));
  const sorted = world.query(SortIndex).sortBy(SortIndex.value);
  world.step();
  expect(values(world, sorted)).toEqual([1, 2, 3]);
  expect(sorted.isDirty).toBe('clean');
  return { world, spawned, sorted };
}

/** Writes the key behind apecs’ back — what the hatches exist for. */
function writeUnseen(world: World, entity: Entity, value: number): void {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  for (const chunk of world.query(SortIndex).chunks()) {
    for (let i = 0; i < chunk.length; i++) {
      if (chunk.entity(i) === entity) {
        chunk.get(SortIndex).value[i] = value;
      }
    }
  }
}

describe('isDirty (§6.7)', () => {
  test('reports the level the next access will pay', () => {
    const world = new World();
    world.spawn(SortIndex({ value: 1 }));
    world.step();
    const sorted = world.query(SortIndex).sortBy(SortIndex.value);
    expect(sorted.isDirty).toBe('rebuild');

    sorted.entities();
    expect(sorted.isDirty).toBe('clean');

    world.set(sorted.first!, SortIndex.value, 2);
    expect(sorted.isDirty).toBe('resort');

    world.spawn(SortIndex);
    expect(sorted.isDirty).toBe('rebuild');

    world.destroy();
  });

  test('reading it does no work', () => {
    const { world, spawned, sorted } = settled();
    const view = sorted[$view];
    const stamp = view.stamp.value;
    world.set(spawned[0], SortIndex.value, 0);

    expect(sorted.isDirty).toBe('resort');
    expect(sorted.isDirty).toBe('resort');

    expect(view.stamp.value).toBe(stamp);

    world.destroy();
  });
});

describe('invalidate (§6.7)', () => {
  test('forces a resort on the next access', () => {
    const { world, spawned, sorted } = settled();
    writeUnseen(world, spawned[1], 9);
    expect(sorted.isDirty).toBe('clean');
    expect(values(world, sorted)).toEqual([9, 2, 3]); // stale, as documented

    sorted.invalidate();

    expect(sorted.isDirty).toBe('resort');
    expect(values(world, sorted)).toEqual([2, 3, 9]);

    world.destroy();
  });

  test('does not demote a rebuild', () => {
    const { world, sorted } = settled();
    world.spawn(SortIndex({ value: 0 }));

    sorted.invalidate();

    expect(sorted.isDirty).toBe('rebuild');
    expect(values(world, sorted)).toEqual([0, 1, 2, 3]);

    world.destroy();
  });

  test('resorts without rebuilding', () => {
    const { world, sorted } = settled();
    const view = sorted[$view];
    const rebuilds = view.stamp.structural;

    sorted.invalidate();
    world.step();
    sorted.entities();

    expect(view.stamp.structural).toBe(rebuilds);
    expect(sorted.isDirty).toBe('clean');

    world.destroy();
  });
});

describe('rebuild (§6.7)', () => {
  test('forces a full rebuild on the next access', () => {
    const { world, sorted } = settled();
    const view = sorted[$view];
    const rebuilds = view.stamp.structural;

    sorted.rebuild();

    expect(sorted.isDirty).toBe('rebuild');
    world.step();
    expect(values(world, sorted)).toEqual([1, 2, 3]);
    expect(view.stamp.structural).toBe(rebuilds + 1);
    expect(sorted.isDirty).toBe('clean');

    world.destroy();
  });

  test('picks up a key written behind apecs’ back', () => {
    const { world, spawned, sorted } = settled();
    writeUnseen(world, spawned[2], -1);

    sorted.rebuild();

    expect(values(world, sorted)).toEqual([-1, 1, 3]);

    world.destroy();
  });
});

describe('the comparator overload (§6.7)', () => {
  test('is always resort-dirty, so it re-sorts on every access', () => {
    const world = new World();
    const spawned = [1, 2, 3].map((value) => world.spawn(SortIndex({ value })));
    let flip = 1;
    const sorted = world
      .query(SortIndex)
      .sortBy((a, b) => flip * (world.get(a, SortIndex.value) - world.get(b, SortIndex.value)));

    expect([...sorted]).toEqual(spawned);
    world.step();
    expect(sorted.isDirty).toBe('resort');

    flip = -1; // state apecs cannot see
    expect([...sorted]).toEqual([...spawned].reverse());
    expect(sorted.isDirty).toBe('resort');

    world.destroy();
  });

  test('still rebuilds on structural change', () => {
    const world = new World();
    const cmp = (a: Entity, b: Entity) =>
      world.get(a, SortIndex.value) - world.get(b, SortIndex.value);
    const spawned = [2, 1].map((value) => world.spawn(SortIndex({ value })));
    const sorted = world.query(SortIndex).sortBy(cmp);
    expect([...sorted]).toEqual([spawned[1], spawned[0]]);

    const late = world.spawn(SortIndex({ value: 0 }), IsActive);
    expect(sorted.isDirty).toBe('rebuild');
    expect([...sorted]).toEqual([late, spawned[1], spawned[0]]);

    world.despawn(spawned[1]);
    expect([...sorted]).toEqual([late, spawned[0]]);

    world.destroy();
  });

  test('keys stay untouched: the comparator view extracts nothing', () => {
    const world = new World();
    world.spawn(SortIndex({ value: 1 }));
    const sorted = world.query(SortIndex).sortBy((a, b) => a - b);

    sorted.entities();

    expect(sorted[$view].keys.length).toBe(0);

    world.destroy();
  });

  test('ties keep their previous relative order', () => {
    const world = new World();
    const spawned: Entity[] = [];
    for (let i = 0; i < 5; i++) {
      spawned.push(world.spawn(SortIndex({ value: 0 })));
    }
    const sorted = world.query(SortIndex).sortBy(() => 0);
    const initial = [...sorted];

    expect([...sorted]).toEqual(initial);
    world.spawn(SortIndex);
    expect([...sorted].filter((e) => spawned.includes(e))).toEqual(initial);

    world.destroy();
  });
});
