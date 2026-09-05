/**
 * T9.8, T9.9, T9.10 — iteration safety around a permute, the per-archetype
 * guarantee and its warning, and two ordered views over one archetype
 * (SPEC §6.8, §9, §12.2).
 */
import { afterEach, describe, expect, test, vi } from 'vitest';

import { Trait, World, f32 } from '../src/index';
import type { Entity, OrderedQueryResult } from '../src/index';
import { ApecsError, resetWarnOnce } from '../src/internal';

const Position = new Trait({ x: f32(0), y: f32(0) });
const SortIndex = new Trait({ value: 0, layer: 0 });
const IsActive = new Trait();

const PAGE = 4;

afterEach(() => {
  vi.restoreAllMocks();
  resetWarnOnce();
});

function values(world: World, entities: Iterable<number>): number[] {
  return Array.from(entities, (e) => world.get(e as Entity, SortIndex.value) as number);
}

function chunkValues(ordered: OrderedQueryResult, field = SortIndex.value): number[] {
  const out: number[] = [];
  for (const chunk of ordered.chunks()) {
    const column = chunk.column(field);
    for (let i = chunk.length - 1; i >= 0; i--) {
      out.push(column[i]);
    }
  }
  return out;
}

function settled(keys: readonly number[]) {
  const world = new World({ pageSize: PAGE });
  const spawned = keys.map((value) => world.spawn(SortIndex({ value }), Position));
  const query = world.query(SortIndex, Position);
  const ordered = query.orderBy(SortIndex.value);
  world.step();
  expect(values(world, ordered)).toEqual([...keys].sort((a, b) => a - b));
  return { world, spawned, query, ordered };
}

describe('structural change during an ordered walk (§9)', () => {
  test('despawning back to front inside an ordered chunk visits every row once', () => {
    const keys = Array.from({ length: 11 }, (_, i) => (i * 7) % 11);
    const { world, spawned, ordered } = settled(keys);

    const visited: number[] = [];
    for (const chunk of ordered.chunks()) {
      const { value } = chunk.get(SortIndex);
      for (let i = chunk.length - 1; i >= 0; i--) {
        visited.push(value[i]);
        if (value[i] % 2 === 1) {
          world.despawn(chunk.entity(i));
        }
      }
    }

    expect(visited).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(ordered.count).toBe(6);
    for (let i = 0; i < spawned.length; i++) {
      expect(world.isAlive(spawned[i])).toBe(keys[i] % 2 === 0);
    }
    expect(ordered.isDirty).toBe('rebuild');
    expect(values(world, ordered)).toEqual([0, 2, 4, 6, 8, 10]);

    world.destroy();
  });

  test('despawning the current entity in an ordered each is safe', () => {
    const { world, ordered } = settled([4, 0, 3, 1, 2]);

    const visited: number[] = [];
    ordered.each((s, _p, entity: Entity) => {
      visited.push(s.value);
      world.despawn(entity);
    });

    expect(visited).toEqual([0, 1, 2, 3, 4]);
    expect(ordered.count).toBe(0);

    world.destroy();
  });

  test('deferred work runs when the ordered walk exits', () => {
    const { world, ordered } = settled([1]);

    let flushed = false;
    ordered.each(() => {
      world.defer(() => {
        flushed = true;
        world.spawn(SortIndex({ value: 0 }), Position);
      });
      expect(flushed).toBe(false);
    });

    expect(flushed).toBe(true);
    expect(values(world, ordered)).toEqual([0, 1]);

    world.destroy();
  });

  test('a clean view nested in a walk over the same archetype is served as is', () => {
    const { world, query, ordered } = settled([3, 1, 2]);

    const outer: number[] = [];
    const inner: number[][] = [];
    ordered.each((s) => {
      outer.push(s.value);
      inner.push(chunkValues(ordered));
      inner.push(values(world, ordered));
    });
    query.each(() => {
      inner.push(chunkValues(ordered));
    });

    expect(outer).toEqual([1, 2, 3]);
    for (const run of inner) {
      expect(run).toEqual([1, 2, 3]);
    }

    world.destroy();
  });

  test.runIf(__DEV__)('a permute inside an open walk throws', () => {
    const { world, spawned, query, ordered } = settled([3, 1, 2]);

    expect(() =>
      query.each(() => {
        world.set(spawned[0], SortIndex.value, 0);
        ordered.first;
      }),
    ).toThrowError(ApecsError);
    expect(() =>
      ordered.each(() => {
        ordered.rebuild();
        for (const _chunk of ordered.chunks()) {
          // unreachable
        }
      }),
    ).toThrowError(/apecs/);

    // Nothing moved, and the next access outside the walk permutes.
    expect(ordered.isDirty).not.toBe('clean');
    expect(values(world, ordered)).toEqual([0, 1, 2]);

    world.destroy();
  });

  test.runIf(!__DEV__)('production serves the stale order inside a walk and permutes after', () => {
    const { world, spawned, query, ordered } = settled([3, 1, 2]);

    const during: number[][] = [];
    query.each(() => {
      if (during.length === 0) {
        world.set(spawned[0], SortIndex.value, 0);
        during.push(values(world, ordered));
      }
    });

    expect(during).toEqual([[1, 2, 0]]);
    expect(values(world, ordered)).toEqual([0, 1, 2]);

    world.destroy();
  });
});

describe('the guarantee is per archetype (§6.8, §12.2)', () => {
  function twoArchetypes() {
    const world = new World({ pageSize: PAGE });
    for (const value of [5, 1, 3]) {
      world.spawn(SortIndex({ value }));
    }
    for (const value of [4, 0, 2]) {
      world.spawn(SortIndex({ value }), IsActive);
    }
    const ordered = world.query(SortIndex).orderBy(SortIndex.value);
    return { world, ordered };
  }

  test('each matching archetype comes out internally ordered', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { world, ordered } = twoArchetypes();

    const runs: number[][] = [];
    for (const chunk of ordered.chunks()) {
      const { value } = chunk.get(SortIndex);
      const run: number[] = [];
      for (let i = chunk.length - 1; i >= 0; i--) {
        run.push(value[i]);
      }
      runs.push(run);
    }

    expect(runs).toHaveLength(2);
    expect(new Set(runs.map((run) => run.join()))).toEqual(new Set(['1,3,5', '0,2,4']));
    expect(new Set(values(world, ordered))).toEqual(new Set([0, 1, 2, 3, 4, 5]));

    world.destroy();
  });

  test.runIf(__DEV__)('dev warns once per call site that the order is not global', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { world, ordered } = twoArchetypes();

    for (let frame = 0; frame < 3; frame++) {
      ordered.first;
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/archetype/);

    for (let frame = 0; frame < 3; frame++) {
      chunkValues(ordered);
    }
    expect(warn).toHaveBeenCalledTimes(2);

    world.destroy();
  });

  test.runIf(__DEV__)(
    'a single-archetype view does not warn, until a second archetype joins',
    () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const world = new World();
      world.spawn(SortIndex({ value: 1 }));
      const ordered = world.query(SortIndex).orderBy(SortIndex.value);
      ordered.first;
      expect(warn).not.toHaveBeenCalled();

      world.spawn(SortIndex({ value: 0 }), IsActive);
      ordered.first;
      expect(warn).toHaveBeenCalledTimes(1);

      world.destroy();
    },
  );

  test.runIf(!__DEV__)('prod does not warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { world, ordered } = twoArchetypes();

    ordered.first;
    chunkValues(ordered);

    expect(warn).not.toHaveBeenCalled();

    world.destroy();
  });
});

describe('two ordered views over one archetype (§6.8)', () => {
  function conflicting() {
    const world = new World({ pageSize: PAGE });
    const pairs: Array<[number, number]> = [
      [3, 30],
      [1, 20],
      [2, 10],
      [0, 40],
    ];
    for (const [value, layer] of pairs) {
      world.spawn(SortIndex({ value, layer }));
    }
    const query = world.query(SortIndex);
    return { world, query };
  }

  test.runIf(__DEV__)('dev warns once per call site', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { world, query } = conflicting();

    query.orderBy(SortIndex.value);
    expect(warn).not.toHaveBeenCalled();
    for (let i = 0; i < 3; i++) {
      query.orderBy(SortIndex.layer);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/orderBy/);

    query.orderBy(SortIndex.value, 'desc');
    expect(warn).toHaveBeenCalledTimes(2);

    world.destroy();
  });

  test.runIf(!__DEV__)('prod does not warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { world, query } = conflicting();

    query.orderBy(SortIndex.value);
    query.orderBy(SortIndex.layer);

    expect(warn).not.toHaveBeenCalled();

    world.destroy();
  });

  test('last writer wins and neither view is corrupted', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { world, query } = conflicting();
    const byValue = query.orderBy(SortIndex.value);
    const byLayer = query.orderBy(SortIndex.layer);
    world.step();

    expect(chunkValues(byValue)).toEqual([0, 1, 2, 3]);
    expect(chunkValues(byLayer, SortIndex.layer)).toEqual([10, 20, 30, 40]);
    expect(byValue.isDirty).toBe('rebuild');
    expect(chunkValues(byValue)).toEqual([0, 1, 2, 3]);
    expect(byLayer.isDirty).toBe('rebuild');
    expect(chunkValues(byValue, SortIndex.layer)).toEqual([40, 20, 10, 30]);

    for (const entity of query) {
      expect(world.get(entity, SortIndex.layer)).toBe(
        [40, 20, 10, 30][world.get(entity, SortIndex.value)],
      );
    }

    world.destroy();
  });

  test('a sortBy view over a permuted archetype rebuilds and stays correct', () => {
    const { world, query } = conflicting();
    const sorted = query.sortBy(SortIndex.layer);
    const ordered = query.orderBy(SortIndex.value);
    world.step();
    expect(values(world, sorted)).toEqual([2, 1, 3, 0]);
    expect(sorted.isDirty).toBe('clean');

    world.set(query.first!, SortIndex.value, -1);
    ordered.first;

    expect(sorted.isDirty).toBe('rebuild');
    expect([...sorted].map((e) => world.get(e, SortIndex.layer))).toEqual([10, 20, 30, 40]);

    world.destroy();
  });
});
