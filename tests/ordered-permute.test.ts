/**
 * T9.3, T9.4, T9.5 — the permutation is total: every column moves, the
 * entity index is rewritten, and per-row ticks travel with their row
 * (SPEC §6.8, §8.3, §10.2, §10.3).
 */
import { afterEach, describe, expect, test, vi } from 'vitest';

import { Added, Changed, Relation, Removed, Trait, World, f32, str } from '../src/index';
import type { Entity } from '../src/index';
import { $view } from '../src/internal';
import { archetypeOf, columnOf, rowOf } from './support/columns';

const Position = new Trait({ x: f32(0), y: f32(0) });
const SortIndex = new Trait({ value: 0 });
const Name = new Trait({ text: str('') });
const Mesh = new Trait(() => ({ id: 0 }));
const ChildOf = new Relation(undefined, { exclusive: true });
const IsActive = new Trait();

const PAGE = 4;
const N = 11;

afterEach(() => {
  vi.restoreAllMocks();
});

/** `N` entities over three pages, keys shuffled, every column kind populated. */
function populate(world: World) {
  const parents = [world.spawn(), world.spawn()];
  const spawned: Entity[] = [];
  for (let i = 0; i < N; i++) {
    spawned.push(
      world.spawn(
        SortIndex({ value: (i * 7) % N }),
        Position({ x: i, y: -i }),
        Name({ text: `e${i}` }),
        Mesh,
        ChildOf(parents[i & 1]),
      ),
    );
    world.get(spawned[i], Mesh).id = i;
  }
  return { parents, spawned };
}

function expectConsistent(world: World, spawned: readonly Entity[], parents: readonly Entity[]) {
  for (let i = 0; i < spawned.length; i++) {
    const entity = spawned[i];
    if (!world.isAlive(entity)) {
      continue;
    }
    const archetype = archetypeOf(world, entity);
    const row = rowOf(world, entity);
    expect(archetype.entityAt(row)).toBe(entity);
    expect(world.get(entity, SortIndex.value)).toBe((i * 7) % N);
    expect(world.get(entity, Position)).toEqual({ x: i, y: -i });
    expect(world.get(entity, Name.text)).toBe(`e${i}`);
    expect(world.get(entity, Mesh).id).toBe(i);
    expect(world.target(entity, ChildOf)).toBe(parents[i & 1]);
  }
}

describe('the permutation is total (§6.8, §10.2)', () => {
  test('struct, AoS, boxed and relation-target columns move together', () => {
    const world = new World({ pageSize: PAGE });
    const { parents, spawned } = populate(world);
    const ordered = world.query(SortIndex, Position, Name, Mesh, ChildOf).orderBy(SortIndex.value);

    const seen: number[] = [];
    for (const chunk of ordered.chunks()) {
      const s = chunk.get(SortIndex);
      const p = chunk.get(Position);
      const names = chunk.column(Name.text);
      const meshes = chunk.get(Mesh);
      for (let i = chunk.length - 1; i >= 0; i--) {
        const entity = chunk.entity(i);
        const at = spawned.indexOf(entity);
        expect(at).toBeGreaterThanOrEqual(0);
        expect(s.value[i]).toBe((at * 7) % N);
        expect(p.x[i]).toBe(at);
        expect(p.y[i]).toBe(-at);
        expect(names[i]).toBe(`e${at}`);
        expect(meshes[i].id).toBe(at);
        expect(world.target(entity, ChildOf)).toBe(parents[at & 1]);
        seen.push(s.value[i]);
      }
    }

    expect(seen).toEqual(Array.from({ length: N }, (_, i) => i));
    expectConsistent(world, spawned, parents);
    expect(ordered[$view].permutes).toBe(1);

    world.destroy();
  });

  test('the target index is entity-indexed and unaffected', () => {
    const world = new World({ pageSize: PAGE });
    const { parents, spawned } = populate(world);
    const even = world.query(ChildOf(parents[0]));
    const odd = world.query(ChildOf(parents[1]));
    expect(even.count).toBe(6);
    expect(odd.count).toBe(5);

    world.query(SortIndex).orderBy(SortIndex.value).first;

    expect(even.count).toBe(6);
    expect(odd.count).toBe(5);
    expect(new Set([...even])).toEqual(new Set(spawned.filter((_, i) => (i & 1) === 0)));
    expect(new Set([...odd])).toEqual(new Set(spawned.filter((_, i) => (i & 1) === 1)));

    world.destroy();
  });

  test('a second permute after key writes moves only what changed and stays consistent', () => {
    const world = new World({ pageSize: PAGE });
    const { parents, spawned } = populate(world);
    const ordered = world.query(SortIndex).orderBy(SortIndex.value);
    ordered.first;
    world.step();

    world.set(spawned[0], SortIndex.value, 100);
    world.set(spawned[5], SortIndex.value, -1);
    ordered.first;

    const keys = [...ordered].map((e) => world.get(e, SortIndex.value));
    expect(keys).toEqual([...keys].sort((a, b) => a - b));
    for (const entity of spawned) {
      const at = spawned.indexOf(entity);
      expect(world.get(entity, Position)).toEqual({ x: at, y: -at });
      expect(world.get(entity, Name.text)).toBe(`e${at}`);
      expect(world.get(entity, Mesh).id).toBe(at);
      expect(world.target(entity, ChildOf)).toBe(parents[at & 1]);
      expect(archetypeOf(world, entity).entityAt(rowOf(world, entity))).toBe(entity);
    }

    world.destroy();
  });
});

describe('entity-index fixup (§4.5, §10.3)', () => {
  test('every matched entity resolves to its new row', () => {
    const world = new World({ pageSize: PAGE });
    const { parents, spawned } = populate(world);

    world.query(SortIndex).orderBy(SortIndex.value).first;

    const rows = new Set<number>();
    for (const entity of spawned) {
      const row = rowOf(world, entity);
      expect(archetypeOf(world, entity).entityAt(row)).toBe(entity);
      rows.add(row);
    }
    expect(rows.size).toBe(N);
    expectConsistent(world, spawned, parents);

    world.destroy();
  });

  test('world.get / set and accessors land on the right row', () => {
    const world = new World({ pageSize: PAGE });
    const { spawned } = populate(world);
    const x = world.accessor(Position.x);
    const ordered = world.query(SortIndex, Position).orderBy(SortIndex.value);
    ordered.first;

    for (let i = 0; i < spawned.length; i++) {
      world.set(spawned[i], Position.y, i * 10);
      x.set(spawned[i], i * 100);
    }

    for (const chunk of ordered.chunks()) {
      const p = chunk.get(Position);
      for (let i = 0; i < chunk.length; i++) {
        const at = spawned.indexOf(chunk.entity(i));
        expect(p.y[i]).toBe(at * 10);
        expect(p.x[i]).toBe(at * 100);
        expect(x.get(chunk.entity(i))).toBe(at * 100);
        expect(world.get(chunk.entity(i), Position.x)).toBe(at * 100);
      }
    }

    world.destroy();
  });

  test('a following add, remove and despawn land on the right row', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const world = new World({ pageSize: PAGE });
    const { parents, spawned } = populate(world);
    const ordered = world.query(SortIndex).orderBy(SortIndex.value);
    ordered.first;

    world.add(spawned[3], IsActive);
    expect(world.has(spawned[3], IsActive)).toBe(true);
    expect(world.get(spawned[3], Position)).toEqual({ x: 3, y: -3 });
    expectConsistent(world, spawned, parents);

    world.remove(spawned[3], IsActive);
    world.remove(spawned[8], Name);
    expect(world.has(spawned[8], Name)).toBe(false);
    expect(world.get(spawned[8], Position)).toEqual({ x: 8, y: -8 });

    world.despawn(spawned[1]);
    world.despawn(spawned[9]);
    expect(world.isAlive(spawned[1])).toBe(false);
    expect(world.isAlive(spawned[9])).toBe(false);
    for (const entity of spawned) {
      if (world.isAlive(entity)) {
        const at = spawned.indexOf(entity);
        expect(world.get(entity, Position)).toEqual({ x: at, y: -at });
        expect(world.get(entity, Mesh).id).toBe(at);
        expect(world.target(entity, ChildOf)).toBe(parents[at & 1]);
        expect(archetypeOf(world, entity).entityAt(rowOf(world, entity))).toBe(entity);
      }
    }
    expect(ordered.isDirty).toBe('rebuild');
    const keys = [...world.query(SortIndex, Name).orderBy(SortIndex.value)].map((e) =>
      world.get(e, SortIndex.value),
    );
    expect(keys).toEqual([...keys].sort((a, b) => a - b));
    expect(keys).toHaveLength(N - 3);

    world.destroy();
  });

  test('id recycling across a permute', () => {
    const world = new World({ pageSize: PAGE });
    const { spawned } = populate(world);
    const ordered = world.query(SortIndex).orderBy(SortIndex.value);
    ordered.first;

    world.despawn(spawned[4]);
    const reused = world.spawn(SortIndex({ value: 4 }), Position({ x: 40 }));
    expect(reused).not.toBe(spawned[4]);
    expect(world.isAlive(spawned[4])).toBe(false);
    expect(world.isAlive(reused)).toBe(true);

    ordered.first;
    expect(world.get(reused, Position.x)).toBe(40);
    expect(archetypeOf(world, reused).entityAt(rowOf(world, reused))).toBe(reused);
    expect(world.isAlive(spawned[4])).toBe(false);

    world.despawn(reused);
    world.set(spawned[0], SortIndex.value, 50);
    ordered.first;
    const again = world.spawn(SortIndex({ value: 4 }), Position({ x: 41 }));
    expect([...ordered]).toContain(again);
    expect(world.get(again, Position.x)).toBe(41);

    world.destroy();
  });
});

describe('ticks travel with the row (§8.3)', () => {
  test('Changed() after a permute sees exactly the entities written', () => {
    const world = new World({ pageSize: PAGE });
    const { spawned } = populate(world);
    const changed = world.query(Position, Changed(Position));
    const ordered = world.query(SortIndex, Position).orderBy(SortIndex.value);
    ordered.first;
    changed.each(() => {});
    world.step();

    world.set(spawned[2], Position.x, 1);
    world.set(spawned[7], Position.x, 1);
    const before = [rowOf(world, spawned[2]), rowOf(world, spawned[7])];
    // Reverse the key order, so nearly every row moves.
    for (let i = 0; i < spawned.length; i++) {
      world.set(spawned[i], SortIndex.value, -world.get(spawned[i], SortIndex.value));
    }
    ordered.first;
    expect([rowOf(world, spawned[2]), rowOf(world, spawned[7])]).not.toEqual(before);

    const seen: Entity[] = [];
    changed.each((_p, entity: Entity) => seen.push(entity));
    expect(new Set(seen)).toEqual(new Set([spawned[2], spawned[7]]));

    const column = columnOf(world, spawned[2], Position.x);
    expect(column.tickOf(rowOf(world, spawned[2]))).toBe(world.tick);
    expect(column.tickOf(rowOf(world, spawned[3]))).toBe(0);

    world.destroy();
  });

  test('Added() and Removed() are entity-indexed and unaffected', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const world = new World({ pageSize: PAGE });
    const { spawned } = populate(world);
    const added = world.query(Added(IsActive));
    const removed = world.query(Removed(Name));
    const ordered = world.query(SortIndex).orderBy(SortIndex.value);
    ordered.first;
    world.step();

    world.add(spawned[5], IsActive);
    world.remove(spawned[6], Name);
    for (let i = 0; i < spawned.length; i++) {
      world.set(spawned[i], SortIndex.value, -world.get(spawned[i], SortIndex.value));
    }
    ordered.first;

    const gained: Entity[] = [];
    added.each((entity: Entity) => gained.push(entity));
    const lost: Entity[] = [];
    removed.each((entity: Entity) => lost.push(entity));
    expect(gained).toEqual([spawned[5]]);
    expect(lost).toEqual([spawned[6]]);

    world.destroy();
  });
});
