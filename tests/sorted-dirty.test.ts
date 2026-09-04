import { afterEach, describe, expect, test, vi } from 'vitest';

import { Trait, World, f32 } from '../src/index';
import type { Entity } from '../src/index';
import { $archetypes, $view, resetWarnOnce } from '../src/internal';

const Position = new Trait({ x: f32(0), y: f32(0) });
const SortIndex = new Trait({ value: 0, layer: 0 });
const IsActive = new Trait();

afterEach(() => {
  vi.restoreAllMocks();
  resetWarnOnce();
});

function values(world: World, sorted: Iterable<number>): number[] {
  return Array.from(sorted, (e) => world.get(e as Entity, SortIndex.value) as number);
}

/** A world with three sorted entities, settled: the view is built and the tick has moved on. */
function settled() {
  const world = new World();
  const spawned = [3, 1, 2].map((value) => world.spawn(SortIndex({ value }), Position));
  const query = world.query(SortIndex, Position);
  const sorted = query.sortBy(SortIndex.value);
  world.step();
  expect(values(world, sorted)).toEqual([1, 2, 3]);
  expect(sorted.isDirty).toBe('clean');
  return { world, spawned, query, sorted };
}

describe('dirty levels (§6.7)', () => {
  test('a fresh view is rebuild-dirty and settles to clean once accessed', () => {
    const world = new World();
    world.spawn(SortIndex);
    world.step();
    const sorted = world.query(SortIndex).sortBy(SortIndex.value);

    expect(sorted.isDirty).toBe('rebuild');
    sorted.entities();
    expect(sorted.isDirty).toBe('clean');

    world.destroy();
  });

  test('clean costs nothing: the same ordered array comes back untouched', () => {
    const { world, sorted } = settled();
    const view = sorted[$view];
    const rebuilds = view.stamp.structural;
    const stamp = view.stamp.value;

    for (let frame = 0; frame < 3; frame++) {
      world.step();
      expect(sorted.first).toBeDefined();
    }

    expect(view.stamp.structural).toBe(rebuilds);
    expect(view.stamp.value).toBe(stamp);

    world.destroy();
  });

  test('calling sortBy every frame is a lookup: nothing is sorted until something changes', () => {
    const world = new World({ pageSize: 2 });
    const spawned = [3, 1, 2, 5, 4].map((value) => world.spawn(SortIndex({ value }), Position));
    world.step();
    const first = world.query(SortIndex, Position).sortBy(SortIndex.value);
    const view = first[$view];
    let walks = 0;
    first.each(() => walks++);
    expect(walks).toBe(5);
    const sortedAt = view.stamp.value;
    const rebuilds = view.stamp.structural;

    for (let frame = 0; frame < 5; frame++) {
      world.step();
      const sorted = world.query(SortIndex, Position).sortBy(SortIndex.value);
      expect(sorted).toBe(first);
      expect(sorted.isDirty).toBe('clean');
      sorted.each(() => walks++);
      expect(sorted.first).toBe(spawned[1]);
      expect(view.stamp.value).toBe(sortedAt);
      expect(view.stamp.structural).toBe(rebuilds);
    }
    expect(walks).toBe(30);

    world.set(spawned[1], SortIndex.value, 9);
    world
      .query(SortIndex, Position)
      .sortBy(SortIndex.value)
      .each(() => {});
    expect(view.stamp.value).toBe(world.tick);
    expect(view.stamp.structural).toBe(rebuilds);
    expect(values(world, first)).toEqual([2, 3, 4, 5, 9]);

    world.destroy();
  });

  test('a key written in the tick of the sort keeps the view resort-dirty for one more pass', () => {
    const { world, spawned, sorted } = settled();

    world.set(spawned[0], SortIndex.value, 0);
    expect(sorted.isDirty).toBe('resort');
    expect(values(world, sorted)).toEqual([0, 1, 2]);
    // The scalar cannot tell a write before the sort from one after it, so
    // the view stays conservative until a sort happens in a later tick.
    expect(sorted.isDirty).toBe('resort');
    world.step();
    expect(sorted.isDirty).toBe('resort');

    expect(values(world, sorted)).toEqual([0, 1, 2]);
    expect(sorted.isDirty).toBe('clean');

    world.destroy();
  });

  test('a write after the sort in the same tick is still seen', () => {
    const { world, spawned, sorted } = settled();

    world.set(spawned[1], SortIndex.value, 9);
    values(world, sorted);
    world.set(spawned[2], SortIndex.value, 10);
    world.step();

    expect(values(world, sorted)).toEqual([3, 9, 10]);

    world.destroy();
  });

  test('rebuild takes precedence over resort', () => {
    const { world, spawned, sorted } = settled();

    world.set(spawned[0], SortIndex.value, 0);
    world.spawn(SortIndex({ value: 5 }), Position);

    expect(sorted.isDirty).toBe('rebuild');
    expect(values(world, sorted)).toEqual([0, 1, 2, 5]);

    world.destroy();
  });
});

describe('structural invalidation through archetype.sortedViews (§6.7)', () => {
  test('the view registers on every matching archetype, present and future', () => {
    const world = new World();
    world.spawn(SortIndex);
    const query = world.query(SortIndex);
    const sorted = query.sortBy(SortIndex.value);
    const view = sorted[$view];
    expect(query[$archetypes][0].sortedViews).toEqual([view]);

    world.spawn(SortIndex, IsActive);

    expect(query[$archetypes]).toHaveLength(2);
    expect(query[$archetypes][1].sortedViews).toEqual([view]);

    world.destroy();
  });

  test('archetypes no sorted query matches carry an empty list', () => {
    const world = new World();
    world.spawn(Position);
    world.spawn(SortIndex);
    world.query(SortIndex).sortBy(SortIndex.value);

    for (const archetype of world.query(Position)[$archetypes]) {
      expect(archetype.sortedViews).toEqual([]);
    }

    world.destroy();
  });

  test('a row insert flips structuralDirty', () => {
    const { world, sorted } = settled();
    const view = sorted[$view];

    world.spawn(SortIndex({ value: 0 }), Position);

    expect(view.structuralDirty).toBe(true);
    expect(sorted.isDirty).toBe('rebuild');
    expect(values(world, sorted)).toEqual([0, 1, 2, 3]);
    expect(view.structuralDirty).toBe(false);

    world.destroy();
  });

  test('a row removal flips structuralDirty', () => {
    const { world, spawned, sorted } = settled();

    world.despawn(spawned[2]);

    expect(sorted.isDirty).toBe('rebuild');
    expect(values(world, sorted)).toEqual([1, 3]);

    world.destroy();
  });

  test('a row move between archetypes flips structuralDirty', () => {
    const { world, spawned, sorted } = settled();

    world.add(spawned[1], IsActive);
    expect(sorted.isDirty).toBe('rebuild');
    expect(values(world, sorted)).toEqual([1, 2, 3]);

    world.remove(spawned[1], Position);
    expect(sorted.isDirty).toBe('rebuild');
    expect(values(world, sorted)).toEqual([2, 3]);

    world.destroy();
  });

  test('a spawn into a brand-new matching archetype is picked up', () => {
    const { world, sorted } = settled();

    world.spawn(SortIndex({ value: 0 }), Position, IsActive);

    expect(sorted.isDirty).toBe('rebuild');
    expect(values(world, sorted)).toEqual([0, 1, 2, 3]);

    world.destroy();
  });

  test('a spawn into a non-matching archetype leaves the view clean', () => {
    const { world, sorted } = settled();

    world.spawn(SortIndex({ value: 0 }));
    world.spawn(Position);

    expect(sorted.isDirty).toBe('clean');

    world.destroy();
  });

  test('a rebuild counts once, whatever accumulated since the last access', () => {
    const { world, spawned, sorted } = settled();
    const rebuilds = sorted[$view].stamp.structural;

    world.spawn(SortIndex({ value: 0 }), Position);
    world.spawn(SortIndex({ value: 4 }), Position);
    world.despawn(spawned[1]);
    world.step();
    sorted.entities();

    expect(sorted[$view].stamp.structural).toBe(rebuilds + 1);
    expect(sorted.isDirty).toBe('clean');

    world.destroy();
  });
});

describe('value invalidation through lastWriteTick (§6.7, §8.3)', () => {
  test('world.set on the key field schedules a resort', () => {
    const { world, spawned, sorted } = settled();

    world.set(spawned[2], SortIndex.value, 9);

    expect(sorted.isDirty).toBe('resort');
    expect(values(world, sorted)).toEqual([1, 3, 9]);

    world.destroy();
  });

  test('world.set on the whole trait schedules a resort', () => {
    const { world, spawned, sorted } = settled();

    world.set(spawned[0], SortIndex, { value: 0 });

    expect(sorted.isDirty).toBe('resort');
    expect(values(world, sorted)).toEqual([0, 1, 2]);

    world.destroy();
  });

  test('a cursor write through the unsorted query schedules a resort', () => {
    const { world, query, sorted } = settled();

    query.each((s) => {
      s.value = 10 - s.value;
    });

    expect(sorted.isDirty).toBe('resort');
    expect(values(world, sorted)).toEqual([7, 8, 9]);

    world.destroy();
  });

  test('a cursor write through the sorted walk itself schedules the next resort', () => {
    const { world, sorted } = settled();

    sorted.each((s) => {
      s.value = -s.value;
    });

    expect(sorted.isDirty).toBe('resort');
    expect(values(world, sorted)).toEqual([-3, -2, -1]);

    world.destroy();
  });

  test('world.changed schedules a resort without touching the data', () => {
    const { world, spawned, sorted } = settled();

    world.changed(spawned[0], SortIndex);

    expect(sorted.isDirty).toBe('resort');

    world.destroy();
  });

  test('a write to another field of the key trait is not a key change', () => {
    const { world, spawned, sorted } = settled();

    world.set(spawned[0], SortIndex.layer, 5);

    expect(sorted.isDirty).toBe('clean');

    world.destroy();
  });

  test('a write to an unrelated trait is not a key change', () => {
    const { world, spawned, sorted } = settled();

    world.set(spawned[0], Position.x, 5);

    expect(sorted.isDirty).toBe('clean');

    world.destroy();
  });

  test('the check is per matching archetype: a key column elsewhere does not count', () => {
    const { world, sorted } = settled();
    const elsewhere = world.spawn(SortIndex({ value: 0 }));
    world.step();
    sorted.entities();

    world.set(elsewhere, SortIndex.value, 1);

    expect(sorted.isDirty).toBe('clean');

    world.destroy();
  });
});

describe('the chunk hazard (§6.6, §6.7)', () => {
  function sweep(world: World, mark: 'chunk' | 'row' | 'none'): void {
    for (const chunk of world.query(SortIndex, Position).chunks()) {
      const s = chunk.get(SortIndex);
      for (let i = 0; i < chunk.length; i++) {
        s.value[i] = 10 - s.value[i];
      }
      if (mark === 'chunk') {
        chunk.markChanged(SortIndex);
      }
      if (mark === 'row') {
        for (let i = 0; i < chunk.length; i++) {
          chunk.markChanged(SortIndex, i);
        }
      }
    }
  }

  test('markChanged on the chunk schedules the resort', () => {
    const { world, sorted } = settled();

    sweep(world, 'chunk');

    expect(sorted.isDirty).toBe('resort');
    expect(values(world, sorted)).toEqual([7, 8, 9]);

    world.destroy();
  });

  test('markChanged on a single row schedules the resort too', () => {
    const { world, sorted } = settled();

    sweep(world, 'row');

    expect(sorted.isDirty).toBe('resort');
    expect(values(world, sorted)).toEqual([7, 8, 9]);

    world.destroy();
  });

  test('a direct page write without markChanged leaves the view stale', () => {
    const { world, sorted } = settled();
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    sweep(world, 'none');

    expect(sorted.isDirty).toBe('clean');
    expect(values(world, sorted)).toEqual([9, 8, 7]);

    world.destroy();
  });
});

describe('structural change during a sorted walk (§9)', () => {
  test('despawning the current entity is safe and visits every entity once', () => {
    const world = new World({ pageSize: 2 });
    const spawned: Entity[] = [];
    for (const value of [4, 0, 3, 1, 2]) {
      spawned.push(world.spawn(SortIndex({ value })));
    }
    const sorted = world.query(SortIndex).sortBy(SortIndex.value);

    const visited: number[] = [];
    sorted.each((s, entity: Entity) => {
      visited.push(s.value);
      world.despawn(entity);
    });

    expect(visited).toEqual([0, 1, 2, 3, 4]);
    expect(sorted.count).toBe(0);
    expect(spawned.some((e) => world.isAlive(e))).toBe(false);

    world.destroy();
  });

  test('moving the current entity is safe and the walk keeps its order', () => {
    const world = new World({ pageSize: 2 });
    for (const value of [4, 0, 3, 1, 2]) {
      world.spawn(SortIndex({ value }));
    }
    const sorted = world.query(SortIndex).sortBy(SortIndex.value);

    const visited: number[] = [];
    sorted.each((s, entity: Entity) => {
      visited.push(s.value);
      world.add(entity, IsActive);
    });

    expect(visited).toEqual([0, 1, 2, 3, 4]);
    expect(world.query(SortIndex, IsActive).count).toBe(5);
    expect(sorted.isDirty).toBe('rebuild');
    expect(values(world, sorted)).toEqual([0, 1, 2, 3, 4]);

    world.destroy();
  });

  test('deferred work runs when the outermost sorted walk exits', () => {
    const world = new World();
    world.spawn(SortIndex({ value: 1 }));
    const sorted = world.query(SortIndex).sortBy(SortIndex.value);

    let flushed = false;
    sorted.each(() => {
      world.defer(() => {
        flushed = true;
        world.spawn(SortIndex({ value: 0 }));
      });
      expect(flushed).toBe(false);
    });

    expect(flushed).toBe(true);
    expect(values(world, sorted)).toEqual([0, 1]);

    world.destroy();
  });

  test('the walk is over a materialised list: an entity despawned ahead of it is skipped', () => {
    const world = new World();
    const spawned = [1, 2, 3].map((value) => world.spawn(SortIndex({ value })));
    const sorted = world.query(SortIndex).sortBy(SortIndex.value);

    const visited: Entity[] = [];
    sorted.each((_s, entity: Entity) => {
      visited.push(entity);
      if (entity === spawned[0]) {
        world.despawn(spawned[2]);
      }
    });

    expect(visited).toEqual([spawned[0], spawned[1]]);
    expect(values(world, sorted)).toEqual([1, 2]);

    world.destroy();
  });
});
