/**
 * T9.1, T9.2, T9.6, T9.7 — `orderBy`: surface and memoisation, key order in
 * storage, the dirty levels lifted from §6.7, and the identity fast path
 * (SPEC §6.8).
 */
import { afterEach, describe, expect, test, vi } from 'vitest';

import { Trait, World, f32 } from '../src/index';
import type { Entity, OrderedQueryResult } from '../src/index';
import { $archetypes, $view, resetWarnOnce } from '../src/internal';
import { columnOf, rowOf } from './support/columns';

const Position = new Trait({ x: f32(0), y: f32(0) });
const SortIndex = new Trait({ value: 0, layer: 0 });
const IsActive = new Trait();

afterEach(() => {
  vi.restoreAllMocks();
  resetWarnOnce();
});

function values(world: World, entities: Iterable<number>): number[] {
  return Array.from(entities, (e) => world.get(e as Entity, SortIndex.value) as number);
}

/** Every walk runs back to front, so the chunk order is pages last-first, rows high-low (§6.8). */
function chunkValues(ordered: OrderedQueryResult): number[] {
  const out: number[] = [];
  for (const chunk of ordered.chunks()) {
    const { value } = chunk.get(SortIndex);
    for (let i = chunk.length - 1; i >= 0; i--) {
      out.push(value[i]);
    }
  }
  return out;
}

function eachValues(
  ordered: OrderedQueryResult<readonly [typeof Position, typeof SortIndex]>,
): number[] {
  const out: number[] = [];
  ordered.each((_p, s) => out.push(s.value));
  return out;
}

/** A settled view: built, permuted, and the tick moved past the writes that built it. */
function settled(keys: readonly number[] = [3, 1, 2]) {
  const world = new World();
  const spawned = keys.map((value) => world.spawn(SortIndex({ value }), Position));
  const query = world.query(SortIndex, Position);
  const ordered = query.orderBy(SortIndex.value);
  world.step();
  expect(values(world, ordered)).toEqual([...keys].sort((a, b) => a - b));
  expect(ordered.isDirty).toBe('clean');
  return { world, spawned, query, ordered };
}

describe('orderBy surface and memoisation (§6.8, §11)', () => {
  test('the same (signature, field, direction) returns the identical object', () => {
    const world = new World();
    const ordered = world.query(Position, SortIndex).orderBy(SortIndex.value);

    expect(world.query(Position, SortIndex).orderBy(SortIndex.value)).toBe(ordered);
    expect(world.query(Position, SortIndex).orderBy(SortIndex.value, 'asc')).toBe(ordered);
    expect(world.createQuery(Position, SortIndex).orderBy(SortIndex.value)).toBe(ordered);

    world.destroy();
  });

  test('direction, field and signature each key a distinct view', () => {
    const world = new World();
    const query = world.query(Position, SortIndex);
    const asc = query.orderBy(SortIndex.value);

    expect(query.orderBy(SortIndex.value, 'desc')).not.toBe(asc);
    expect(query.orderBy(SortIndex.value, 'desc')).toBe(query.orderBy(SortIndex.value, 'desc'));
    expect(query.orderBy(SortIndex.layer)).not.toBe(asc);
    expect(world.query(SortIndex, Position).orderBy(SortIndex.value)).not.toBe(asc);

    world.destroy();
  });

  test('it is a distinct object from the query and from its sortBy', () => {
    const world = new World();
    const query = world.query(SortIndex);
    const ordered = query.orderBy(SortIndex.value);

    expect(ordered).not.toBe(query);
    expect(ordered).not.toBe(query.sortBy(SortIndex.value));
    expect(query.sortBy(SortIndex.value)).not.toBe(ordered);

    world.destroy();
  });

  test('count, isEmpty and first', () => {
    const world = new World();
    const ordered = world.query(SortIndex).orderBy(SortIndex.value, 'desc');
    expect(ordered.count).toBe(0);
    expect(ordered.isEmpty).toBe(true);
    expect(ordered.first).toBeUndefined();

    world.spawn(SortIndex({ value: 1 }));
    const top = world.spawn(SortIndex({ value: 5 }));
    world.spawn(SortIndex({ value: 3 }));

    expect(ordered.count).toBe(3);
    expect(ordered.isEmpty).toBe(false);
    expect(ordered.first).toBe(top);
    expect(values(world, ordered)).toEqual([5, 3, 1]);

    world.destroy();
  });

  test('chunks is the base query’s chunk walk', () => {
    const world = new World();
    world.spawn(SortIndex({ value: 2 }));
    world.spawn(SortIndex({ value: 1 }));
    const ordered = world.query(SortIndex).orderBy(SortIndex.value);

    expect(typeof ordered.chunks).toBe('function');
    expect(chunkValues(ordered)).toEqual([1, 2]);

    world.destroy();
  });

  test('entities() is an ordered snapshot copy', () => {
    const world = new World();
    const b = world.spawn(SortIndex({ value: 2 }));
    const a = world.spawn(SortIndex({ value: 1 }));
    const ordered = world.query(SortIndex).orderBy(SortIndex.value);

    const snapshot = ordered.entities();
    expect(snapshot).toBeInstanceOf(Float64Array);
    expect(Array.from(snapshot)).toEqual([a, b]);
    expect(ordered.entities()).not.toBe(snapshot);

    world.destroy();
  });

  test('dispose drops the view from the cache and from the archetypes', () => {
    const world = new World();
    world.spawn(SortIndex);
    const query = world.query(SortIndex);
    const ordered = query.orderBy(SortIndex.value);
    expect([...ordered]).toHaveLength(1);
    const archetype = query[$archetypes][0];
    expect(archetype.sortedViews).toContain(ordered[$view]);

    ordered.dispose();

    expect(archetype.sortedViews).not.toContain(ordered[$view]);
    expect(query.orderBy(SortIndex.value)).not.toBe(ordered);

    world.destroy();
  });

  test('disposing the query disposes its ordered views', () => {
    const world = new World();
    world.spawn(SortIndex);
    const query = world.query(SortIndex);
    const ordered = query.orderBy(SortIndex.value);
    const archetype = query[$archetypes][0];

    query.dispose();

    expect(archetype.sortedViews).not.toContain(ordered[$view]);

    world.destroy();
  });

  test('the key trait need not be a query term: the view covers the narrowed query', () => {
    const world = new World();
    world.spawn(Position({ x: 1 }));
    const b = world.spawn(Position({ x: 2 }), SortIndex({ value: 2 }));
    const a = world.spawn(Position({ x: 3 }), SortIndex({ value: 1 }));
    const query = world.query(Position);

    const ordered = query.orderBy(SortIndex.value);

    expect([...ordered]).toEqual([a, b]);
    expect(ordered.count).toBe(2);
    expect(query.count).toBe(3);
    const seen: number[] = [];
    ordered.each((p) => seen.push(p.x));
    expect(seen).toEqual([3, 2]);

    world.destroy();
  });
});

describe('ordering in storage (§6.8)', () => {
  test('the walk yields key order, ascending and descending', () => {
    const world = new World();
    for (const value of [9, 2, 7, 4, 5, 6, 3, 8, 1]) {
      world.spawn(Position, SortIndex({ value }));
    }
    const query = world.query(Position, SortIndex);

    const asc = query.orderBy(SortIndex.value);
    expect(values(world, asc)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(chunkValues(asc)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(eachValues(query.orderBy(SortIndex.value))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    const desc = query.orderBy(SortIndex.value, 'desc');
    expect(values(world, desc)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(chunkValues(desc)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1]);

    world.destroy();
  });

  test('row order is the walk order reversed: the last row holds the first key', () => {
    const world = new World();
    for (const value of [2, 3, 1]) {
      world.spawn(SortIndex({ value }));
    }
    const query = world.query(SortIndex);
    query.orderBy(SortIndex.value).first;
    const archetype = query[$archetypes][0];

    expect([0, 1, 2].map((row) => world.get(archetype.entityAt(row), SortIndex.value))).toEqual([
      3, 2, 1,
    ]);

    world.destroy();
  });

  test('ties keep their previous walk order', () => {
    const world = new World();
    const spawned = [2, 1, 2, 1, 2].map((value) => world.spawn(SortIndex({ value })));
    const query = world.query(SortIndex);
    const before = [...query];
    expect(before).toEqual([...spawned].reverse());

    const ordered = query.orderBy(SortIndex.value);

    const ones = before.filter((e) => world.get(e, SortIndex.value) === 1);
    const twos = before.filter((e) => world.get(e, SortIndex.value) === 2);
    expect([...ordered]).toEqual([...ones, ...twos]);

    world.step();
    world.set(spawned[0], SortIndex.value, 0);
    expect([...ordered]).toEqual([spawned[0], ...ones, ...twos.filter((e) => e !== spawned[0])]);

    world.destroy();
  });

  test('empty and single-row archetypes', () => {
    const world = new World();
    const ordered = world.query(SortIndex).orderBy(SortIndex.value);
    expect([...ordered]).toEqual([]);
    expect(chunkValues(ordered)).toEqual([]);

    const only = world.spawn(SortIndex({ value: 7 }));
    expect([...ordered]).toEqual([only]);
    expect(chunkValues(ordered)).toEqual([7]);
    world.step();
    ordered.first;
    expect(ordered.isDirty).toBe('clean');

    world.destroy();
  });

  test('the order spans pages', () => {
    const world = new World({ pageSize: 4 });
    const keys = Array.from({ length: 11 }, (_, i) => (i * 7) % 11);
    for (const value of keys) {
      world.spawn(SortIndex({ value }), Position);
    }
    const query = world.query(Position, SortIndex);

    const asc = query.orderBy(SortIndex.value);
    expect(chunkValues(asc)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(values(world, asc)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    let chunks = 0;
    for (const chunk of asc.chunks()) {
      chunks++;
      expect(chunk.length).toBeLessThanOrEqual(4);
    }
    expect(chunks).toBe(3);

    const desc = query.orderBy(SortIndex.value, 'desc');
    expect(chunkValues(desc)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    expect(eachValues(query.orderBy(SortIndex.value, 'desc'))).toEqual([
      10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0,
    ]);

    world.destroy();
  });

  test('a key written after the permute is picked up by the next access', () => {
    const { world, spawned, ordered } = settled();

    world.set(spawned[1], SortIndex.value, 9);
    expect(chunkValues(ordered)).toEqual([2, 3, 9]);
    world.set(spawned[2], SortIndex.value, -1);
    expect(values(world, ordered)).toEqual([-1, 3, 9]);

    world.destroy();
  });
});

describe('dirty levels (§6.7, §6.8)', () => {
  test('a fresh view is rebuild-dirty and settles to clean once accessed', () => {
    const world = new World();
    world.spawn(SortIndex);
    world.step();
    const ordered = world.query(SortIndex).orderBy(SortIndex.value);

    expect(ordered.isDirty).toBe('rebuild');
    ordered.entities();
    expect(ordered.isDirty).toBe('clean');

    world.destroy();
  });

  test('a clean frame permutes nothing', () => {
    const { world, ordered } = settled();
    const view = ordered[$view];
    const permutes = view.permutes;
    const stamp = { ...view.stamp };

    for (let frame = 0; frame < 3; frame++) {
      world.step();
      expect(world.query(SortIndex, Position).orderBy(SortIndex.value)).toBe(ordered);
      expect(ordered.isDirty).toBe('clean');
      expect(chunkValues(ordered)).toEqual([1, 2, 3]);
      expect(ordered.first).toBeDefined();
    }

    expect(view.permutes).toBe(permutes);
    expect(view.stamp).toEqual(stamp);

    world.destroy();
  });

  test('a key write is resort', () => {
    const { world, spawned, query, ordered } = settled();

    world.set(spawned[2], SortIndex.value, 0);
    expect(ordered.isDirty).toBe('resort');
    expect(values(world, ordered)).toEqual([0, 1, 3]);

    world.step();
    expect(ordered.isDirty).toBe('resort');
    expect(values(world, ordered)).toEqual([0, 1, 3]);
    expect(ordered.isDirty).toBe('clean');

    query.each((s) => {
      s.value = 10 - s.value;
    });
    expect(ordered.isDirty).toBe('resort');
    expect(values(world, ordered)).toEqual([7, 9, 10]);

    world.markChanged(spawned[0], SortIndex);
    expect(ordered.isDirty).toBe('resort');

    world.destroy();
  });

  test('a write to another field, or another trait, is not a key change', () => {
    const { world, spawned, ordered } = settled();

    world.set(spawned[0], SortIndex.layer, 5);
    world.set(spawned[0], Position.x, 5);

    expect(ordered.isDirty).toBe('clean');

    world.destroy();
  });

  test('a spawn, despawn or archetype move is rebuild', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { world, spawned, ordered } = settled();
    const view = ordered[$view];

    world.spawn(SortIndex({ value: 0 }), Position);
    expect(view.structuralDirty).toBe(true);
    expect(ordered.isDirty).toBe('rebuild');
    expect(values(world, ordered)).toEqual([0, 1, 2, 3]);
    expect(view.structuralDirty).toBe(false);

    world.despawn(spawned[2]);
    expect(ordered.isDirty).toBe('rebuild');
    expect(values(world, ordered)).toEqual([0, 1, 3]);

    // The moved row lands in a second archetype: ordered within each, not across (§6.8).
    world.add(spawned[1], IsActive);
    expect(ordered.isDirty).toBe('rebuild');
    expect(values(world, ordered).sort()).toEqual([0, 1, 3]);

    world.remove(spawned[1], Position);
    expect(ordered.isDirty).toBe('rebuild');
    expect(values(world, ordered)).toEqual([0, 3]);

    world.destroy();
  });

  test('rebuild takes precedence over resort, and a non-matching spawn leaves it clean', () => {
    const { world, spawned, ordered } = settled();

    world.spawn(SortIndex({ value: 5 }));
    world.spawn(Position);
    expect(ordered.isDirty).toBe('clean');

    world.set(spawned[0], SortIndex.value, 0);
    world.spawn(SortIndex({ value: 5 }), Position);
    expect(ordered.isDirty).toBe('rebuild');
    expect(values(world, ordered)).toEqual([0, 1, 2, 5]);

    world.destroy();
  });

  test('invalidate forces a resort, rebuild forces a rebuild', () => {
    const { world, spawned, ordered } = settled();
    const view = ordered[$view];
    const rebuilds = view.stamp.structural;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const chunk of world.query(SortIndex).chunks()) {
      const { value } = chunk.get(SortIndex);
      for (let i = 0; i < chunk.length; i++) {
        if (chunk.entity(i) === spawned[1]) {
          value[i] = 9;
        }
      }
    }
    expect(ordered.isDirty).toBe('clean');
    expect(chunkValues(ordered)).toEqual([9, 2, 3]);

    ordered.invalidate();
    expect(ordered.isDirty).toBe('resort');
    expect(chunkValues(ordered)).toEqual([2, 3, 9]);
    expect(view.stamp.structural).toBe(rebuilds);

    ordered.rebuild();
    expect(ordered.isDirty).toBe('rebuild');
    world.step();
    expect(chunkValues(ordered)).toEqual([2, 3, 9]);
    expect(view.stamp.structural).toBe(rebuilds + 1);
    expect(ordered.isDirty).toBe('clean');

    world.destroy();
  });

  test.runIf(__DEV__)('the comparator overload is rejected', () => {
    const world = new World();
    const query = world.query(SortIndex);

    expect(() =>
      (query as unknown as { orderBy(cmp: (a: Entity, b: Entity) => number): unknown }).orderBy(
        (a, b) => a - b,
      ),
    ).toThrowError(/apecs/);
    expect(() => query.orderBy(SortIndex as never)).toThrowError(/apecs/);

    world.destroy();
  });
});

describe('the identity fast path (§6.8, §12.2)', () => {
  test('a resort whose permutation is the identity moves no data', () => {
    const { world, spawned, ordered } = settled([1, 2, 3]);
    const view = ordered[$view];
    const permutes = view.permutes;
    const rows = spawned.map((e) => rowOf(world, e));

    world.set(spawned[2], SortIndex.value, 9);
    expect(ordered.isDirty).toBe('resort');
    expect(values(world, ordered)).toEqual([1, 2, 9]);

    expect(view.permutes).toBe(permutes);
    expect(spawned.map((e) => rowOf(world, e))).toEqual(rows);

    world.destroy();
  });

  test('an identity resort leaves per-row ticks untouched', () => {
    const { world, spawned, ordered } = settled([1, 2, 3]);
    world.step();
    world.set(spawned[1], SortIndex.layer, 4);
    const column = columnOf(world, spawned[1], SortIndex.layer);
    const ticks = spawned.map((e) => column.tickOf(rowOf(world, e)));
    expect(ticks[1]).toBe(world.tick);

    world.set(spawned[2], SortIndex.value, 9);
    ordered.first;

    expect(spawned.map((e) => column.tickOf(rowOf(world, e)))).toEqual(ticks);

    world.destroy();
  });

  test('a permute that moves rows counts once per archetype moved', () => {
    const { world, spawned, ordered } = settled();
    const view = ordered[$view];
    const permutes = view.permutes;

    world.set(spawned[1], SortIndex.value, 9);
    ordered.first;

    expect(view.permutes).toBe(permutes + 1);

    world.destroy();
  });
});
