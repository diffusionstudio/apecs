/**
 * SPEC §6.8 — ordered storage: `orderBy` puts the key order into the rows,
 * so every tier including `chunks` reads it. Public API only.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';

import { Trait, World, f32 } from '../../src/index';
import type { Entity, OrderedQueryResult } from '../../src/index';

const Position = new Trait({ x: f32(0), y: f32(0) });
const SortIndex = new Trait({ value: 0, layer: 0 });
const IsActive = new Trait();

const worlds: World[] = [];

function makeWorld(options?: ConstructorParameters<typeof World>[0]): World {
  const world = new World(options);
  worlds.push(world);
  return world;
}

function populate(world: World, values: readonly number[]): Entity[] {
  return values.map((value, i) => world.spawn(Position({ x: i }), SortIndex({ value })));
}

function keys(world: World, ordered: Iterable<Entity>): number[] {
  return [...ordered].map((entity) => world.get(entity, SortIndex.value));
}

/** Pages arrive last to first and the key order runs down each page (§6.8, §9). */
function chunkKeys(ordered: OrderedQueryResult): number[] {
  const out: number[] = [];
  for (const chunk of ordered.chunks()) {
    const { value } = chunk.get(SortIndex);
    for (let i = chunk.length - 1; i >= 0; i--) {
      out.push(value[i]);
    }
  }
  return out;
}

/** As for `sortBy`: the tick has to move past the writes before a view settles (§6.7). */
function settle(world: World, ordered: OrderedQueryResult): void {
  world.step();
  void ordered.first;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const world of worlds.splice(0)) {
    world.destroy();
  }
});

describe('ordering (§6.8)', () => {
  test('orderBy(field) orders ascending by default, and desc reverses', () => {
    const world = makeWorld({ pageSize: 4 });
    populate(world, [3, 1, 4, 1, 5, 9, 2, 6]);
    const query = world.query(Position, SortIndex);

    expect(keys(world, query.orderBy(SortIndex.value))).toEqual([1, 1, 2, 3, 4, 5, 6, 9]);
    expect(keys(world, query.orderBy(SortIndex.value, 'asc'))).toEqual([1, 1, 2, 3, 4, 5, 6, 9]);
    expect(keys(world, query.orderBy(SortIndex.value, 'desc'))).toEqual([9, 6, 5, 4, 3, 2, 1, 1]);
  });

  test('every tier yields the same order: Tier 1, each and chunks', () => {
    const world = makeWorld({ pageSize: 4 });
    populate(world, [3, 1, 4, 1, 5, 9, 2, 6]);
    const ordered = world.query(Position, SortIndex).orderBy(SortIndex.value);

    const walked: number[] = [];
    ordered.each((_p, s) => walked.push(s.value));

    expect(keys(world, ordered)).toEqual([1, 1, 2, 3, 4, 5, 6, 9]);
    expect(walked).toEqual([1, 1, 2, 3, 4, 5, 6, 9]);
    expect(chunkKeys(ordered)).toEqual([1, 1, 2, 3, 4, 5, 6, 9]);
    expect(Array.from(ordered.entities())).toEqual([...ordered]);
    expect(ordered.first).toBe([...ordered][0]);
  });

  test('chunk rows stay index-aligned across every column', () => {
    const world = makeWorld({ pageSize: 4 });
    const entities = populate(world, [3, 1, 4, 1, 5, 9, 2, 6]);
    const ordered = world.query(Position, SortIndex).orderBy(SortIndex.value);

    for (const chunk of ordered.chunks()) {
      const p = chunk.get(Position);
      const s = chunk.get(SortIndex);
      for (let i = 0; i < chunk.length; i++) {
        const entity = chunk.entity(i);
        const at = entities.indexOf(entity);
        expect(p.x[i]).toBe(at);
        expect(s.value[i]).toBe(world.get(entity, SortIndex.value));
        expect(world.get(entity, Position.x)).toBe(at);
      }
    }
  });

  test('ties keep their previous order', () => {
    const world = makeWorld();
    const entities = populate(world, [1, 1, 1, 1]);
    const query = world.query(SortIndex);
    const before = [...query];
    expect(new Set(before)).toEqual(new Set(entities));

    expect([...query.orderBy(SortIndex.value)]).toEqual(before);
  });

  test('a key written since the last access is picked up', () => {
    const world = makeWorld();
    const entities = populate(world, [1, 2, 3]);
    const ordered = world.query(SortIndex).orderBy(SortIndex.value);
    settle(world, ordered);

    world.set(entities[0], SortIndex.value, 9);

    expect(keys(world, ordered)).toEqual([2, 3, 9]);
    expect(chunkKeys(ordered)).toEqual([2, 3, 9]);
  });

  test('a chunk write needs markChanged to be seen (§6.6)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const world = makeWorld();
    populate(world, [1, 2, 3]);
    const ordered = world.query(SortIndex).orderBy(SortIndex.value);
    settle(world, ordered);

    for (const chunk of world.query(SortIndex).chunks()) {
      const s = chunk.get(SortIndex);
      for (let i = 0; i < chunk.length; i++) {
        s.value[i] = -s.value[i];
      }
    }
    expect(ordered.isDirty).toBe('clean');
    expect(keys(world, ordered)).toEqual([-1, -2, -3]);

    for (const chunk of world.query(SortIndex).chunks()) {
      chunk.markChanged(SortIndex);
    }
    expect(ordered.isDirty).toBe('resort');
    expect(keys(world, ordered)).toEqual([-3, -2, -1]);
  });

  test('the order is per archetype', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const world = makeWorld();
    populate(world, [3, 1, 2]);
    for (const value of [6, 4, 5]) {
      world.spawn(SortIndex({ value }), IsActive);
    }
    const ordered = world.query(SortIndex).orderBy(SortIndex.value);

    const runs: number[][] = [];
    for (const chunk of ordered.chunks()) {
      const { value } = chunk.get(SortIndex);
      const run: number[] = [];
      for (let i = chunk.length - 1; i >= 0; i--) {
        run.push(value[i]);
      }
      runs.push(run);
    }

    expect(new Set(runs.map((run) => run.join()))).toEqual(new Set(['1,2,3', '4,5,6']));
    expect(ordered.count).toBe(6);
  });
});

describe('memoisation and the dirty levels (§6.7, §6.8)', () => {
  test('orderBy on the same key returns the same object; direction and key distinguish', () => {
    const world = makeWorld();
    populate(world, [2, 1]);
    const query = world.query(SortIndex);

    expect(query.orderBy(SortIndex.value)).toBe(query.orderBy(SortIndex.value));
    expect(query.orderBy(SortIndex.value, 'asc')).toBe(query.orderBy(SortIndex.value));
    expect(query.orderBy(SortIndex.value) === query.orderBy(SortIndex.value, 'desc')).toBe(false);
    expect((query.orderBy(SortIndex.value) as unknown) === query.sortBy(SortIndex.value)).toBe(
      false,
    );
  });

  test('isDirty reports the work the next access will do', () => {
    const world = makeWorld();
    const entities = populate(world, [2, 1]);
    const ordered = world.query(SortIndex).orderBy(SortIndex.value);
    expect(ordered.isDirty).toBe('rebuild');
    settle(world, ordered);
    expect(ordered.isDirty).toBe('clean');

    world.set(entities[0], SortIndex.value, 0);
    expect(ordered.isDirty).toBe('resort');
    settle(world, ordered);

    world.spawn(SortIndex({ value: 5 }));
    expect(ordered.isDirty).toBe('rebuild');
    settle(world, ordered);

    world.despawn(entities[1]);
    expect(ordered.isDirty).toBe('rebuild');
    settle(world, ordered);

    world.set(entities[0], SortIndex.layer, 1);
    expect(ordered.isDirty).toBe('clean');
  });

  test('invalidate and rebuild are the escape hatches', () => {
    const world = makeWorld();
    populate(world, [1, 2]);
    const ordered = world.query(SortIndex).orderBy(SortIndex.value);
    settle(world, ordered);

    ordered.invalidate();
    expect(ordered.isDirty).toBe('resort');
    settle(world, ordered);
    expect(ordered.isDirty).toBe('clean');

    ordered.rebuild();
    expect(ordered.isDirty).toBe('rebuild');
    settle(world, ordered);
    expect(ordered.isDirty).toBe('clean');
  });

  test('dispose drops the ordered view from the cache', () => {
    const world = makeWorld();
    populate(world, [1]);
    const query = world.query(SortIndex);
    const ordered = query.orderBy(SortIndex.value);

    ordered.dispose();

    expect(query.orderBy(SortIndex.value) === ordered).toBe(false);
  });

  test.runIf(__DEV__)('a comparator is rejected', () => {
    const world = makeWorld();
    const query = world.query(SortIndex);

    expect(() =>
      (query as unknown as { orderBy(cmp: (a: Entity, b: Entity) => number): unknown }).orderBy(
        (a, b) => a - b,
      ),
    ).toThrowError(/apecs/);
  });
});

describe('a permute is structural (§6.8, §9)', () => {
  test('the current entity may be despawned from an ordered chunk, back to front', () => {
    const world = makeWorld({ pageSize: 4 });
    populate(world, [3, 1, 4, 1, 5, 9, 2, 6]);
    const ordered = world.query(Position, SortIndex).orderBy(SortIndex.value);

    const visited: number[] = [];
    for (const chunk of ordered.chunks()) {
      const { value } = chunk.get(SortIndex);
      for (let i = chunk.length - 1; i >= 0; i--) {
        visited.push(value[i]);
        if (value[i] > 3) {
          world.despawn(chunk.entity(i));
        }
      }
    }

    expect(visited).toEqual([1, 1, 2, 3, 4, 5, 6, 9]);
    expect(keys(world, ordered)).toEqual([1, 1, 2, 3]);
  });

  test.runIf(__DEV__)('a dirty ordered result accessed inside a walk throws', () => {
    const world = makeWorld();
    const entities = populate(world, [1, 2, 3]);
    const query = world.query(SortIndex);
    const ordered = query.orderBy(SortIndex.value);
    settle(world, ordered);

    expect(() =>
      query.each(() => {
        world.set(entities[2], SortIndex.value, 0);
        void ordered.first;
      }),
    ).toThrowError(/apecs/);

    expect(keys(world, ordered)).toEqual([0, 1, 2]);
  });

  test('deferring the access is the fix', () => {
    const world = makeWorld();
    const entities = populate(world, [1, 2, 3]);
    const query = world.query(SortIndex);
    const ordered = query.orderBy(SortIndex.value);
    settle(world, ordered);

    let seen: number[] = [];
    query.each(() => {
      world.set(entities[2], SortIndex.value, 0);
      world.defer(() => {
        seen = keys(world, ordered);
      });
    });

    expect(seen).toEqual([0, 1, 2]);
  });
});
