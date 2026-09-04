import { describe, expect, test, vi } from 'vitest';

import { Trait, World, f32 } from '../src/index';
import type { Entity } from '../src/index';
import { $archetypes, $entities, entityId } from '../src/internal';

const Position = new Trait({ x: f32(0), y: f32(0) });
const Velocity = new Trait({ x: f32(0), y: f32(0) });
const IsActive = new Trait();

const archetypeOf = (world: World, e: Entity) =>
  world[$archetypes].list[world[$entities].archetypes[entityId(e)]];
const rowOf = (world: World, e: Entity) => world[$entities].rows[entityId(e)];

const handles = (batch: Float64Array): Entity[] => Array.from(batch) as Entity[];

/** The rows a batch occupies form one uninterrupted run — the mark of a batched move. */
const expectContiguous = (world: World, batch: Entity[]) => {
  const rows = batch.map((e) => rowOf(world, e)).sort((a, b) => a - b);
  expect(rows).toEqual(rows.map((_, i) => rows[0] + i));
};

describe('spawnMany (§4.3)', () => {
  test('returns a Float64Array of live, distinct handles', () => {
    const world = new World();

    const batch = world.spawnMany(1000, Position);

    expect(batch).toBeInstanceOf(Float64Array);
    expect(batch).toHaveLength(1000);
    expect(new Set(batch).size).toBe(1000);
    for (const e of handles(batch)) {
      expect(world.isAlive(e)).toBe(true);
    }

    world.destroy();
  });

  test('the whole batch lands in one archetype at contiguous rows', () => {
    const world = new World({ pageSize: 8 });

    const batch = handles(world.spawnMany(20, Position, Velocity));
    const archetype = archetypeOf(world, batch[0]);

    expect(archetype.rows).toBe(20);
    for (const e of batch) {
      expect(archetypeOf(world, e)).toBe(archetype);
    }
    for (let row = 0; row < 20; row++) {
      expect(archetype.entityAt(row)).toBe(batch[row]);
    }
    expectContiguous(world, batch);

    world.destroy();
  });

  test('instance values are applied to every entity in the batch', () => {
    const world = new World();

    const batch = handles(world.spawnMany(5, Position({ x: 3 }), IsActive));

    for (const e of batch) {
      expect(world.get(e, Position)).toEqual({ x: 3, y: 0 });
      expect(world.has(e, IsActive)).toBe(true);
    }

    world.destroy();
  });

  test('defaults are copied per entity and an AoS factory runs n times', () => {
    const factory = vi.fn(() => ({ n: 0 }));
    const Mesh = new Trait(factory);
    const world = new World();

    const batch = handles(world.spawnMany(4, Position, Mesh));
    world.set(batch[0], Position.x, 9);

    expect(factory).toHaveBeenCalledTimes(4);
    expect(new Set(batch.map((e) => world.get(e, Mesh))).size).toBe(4);
    expect(world.get(batch[1], Position.x)).toBe(0);

    world.destroy();
  });

  test('a batch of zero allocates nothing and spawns nothing', () => {
    const world = new World();

    const batch = world.spawnMany(0, Position);

    expect(batch).toHaveLength(0);
    expect(world[$archetypes].list).toHaveLength(1);

    world.destroy();
  });

  test('batched ids interleave with single spawns and recycle the same way', () => {
    const world = new World();
    const before = world.spawn();

    const batch = handles(world.spawnMany(3, Position));

    expect(entityId(batch[0])).toBe(entityId(before) + 1);

    world.despawnMany(batch);

    expect(entityId(world.spawn())).toBe(entityId(batch[0]));

    world.destroy();
  });
});

describe('addMany / removeMany (§4.3)', () => {
  test('addMany moves the whole batch into one destination archetype', () => {
    const world = new World({ pageSize: 8 });
    const batch = handles(world.spawnMany(20, Position({ x: 2 })));
    const source = archetypeOf(world, batch[0]);

    world.addMany(batch, Velocity({ x: 5 }), IsActive);

    const destination = archetypeOf(world, batch[0]);
    expect(destination).not.toBe(source);
    expect(source.rows).toBe(0);
    expect(destination.rows).toBe(20);
    expectContiguous(world, batch);
    for (const e of batch) {
      expect(archetypeOf(world, e)).toBe(destination);
      expect(world.get(e, Position.x)).toBe(2);
      expect(world.get(e, Velocity.x)).toBe(5);
      expect(world.has(e, IsActive)).toBe(true);
    }

    world.destroy();
  });

  test('a batch spread across archetypes is routed per source', () => {
    const world = new World();
    const plain = handles(world.spawnMany(3, Position));
    const moving = handles(world.spawnMany(3, Position, Velocity));

    world.addMany([...plain, ...moving], IsActive);

    for (const e of plain) {
      expect(world.has(e, Velocity)).toBe(false);
    }
    for (const e of [...plain, ...moving]) {
      expect(world.has(e, IsActive)).toBe(true);
    }
    expect(archetypeOf(world, plain[0])).not.toBe(archetypeOf(world, moving[0]));

    world.destroy();
  });

  test('removeMany strips the traits and leaves the rest of the data', () => {
    const world = new World({ pageSize: 8 });
    const batch = handles(world.spawnMany(20, Position({ x: 2 }), Velocity, IsActive));

    world.removeMany(batch, Velocity);

    expectContiguous(world, batch);
    for (const e of batch) {
      expect(world.has(e, Velocity)).toBe(false);
      expect(world.has(e, IsActive)).toBe(true);
      expect(world.get(e, Position.x)).toBe(2);
    }

    world.destroy();
  });

  test('removing a trait the batch does not carry is a no-op', () => {
    const world = new World();
    const batch = handles(world.spawnMany(5, Position));
    const archetype = archetypeOf(world, batch[0]);

    world.removeMany(batch, Velocity);

    expect(archetypeOf(world, batch[0])).toBe(archetype);
    expect(archetype.rows).toBe(5);

    world.destroy();
  });
});

describe('despawnMany (§4.3)', () => {
  test('every entity in the batch dies and its row is released', () => {
    const world = new World({ pageSize: 8 });
    const batch = handles(world.spawnMany(20, Position));
    const archetype = archetypeOf(world, batch[0]);

    world.despawnMany(batch);

    expect(archetype.rows).toBe(0);
    for (const e of batch) {
      expect(world.isAlive(e)).toBe(false);
    }

    world.destroy();
  });

  test('survivors outside the batch keep their data', () => {
    const world = new World({ pageSize: 8 });
    const all = handles(world.spawnMany(10, Position));
    all.forEach((e, i) => world.set(e, Position.x, i));
    const doomed = all.filter((_, i) => i % 2 === 0);

    world.despawnMany(doomed);

    all.forEach((e, i) => {
      if (i % 2 === 0) {
        return;
      }
      expect(world.isAlive(e)).toBe(true);
      expect(world.get(e, Position.x)).toBe(i);
    });

    world.destroy();
  });
});

describe('batch inputs (§4.3)', () => {
  test('any iterable of handles is a batch, which is what makes a query result one', () => {
    const world = new World();
    const typed = world.spawnMany(3, Position);
    const array = handles(world.spawnMany(3, Position));
    const set = new Set(handles(world.spawnMany(3, Position)));

    world.addMany(typed, IsActive);
    world.addMany(array, IsActive);
    world.addMany(set, IsActive);

    for (const e of [...handles(typed), ...array, ...set]) {
      expect(world.has(e, IsActive)).toBe(true);
    }

    world.despawnMany(set);
    for (const e of set) {
      expect(world.isAlive(e)).toBe(false);
    }

    world.destroy();
  });

  test('an empty batch is accepted everywhere', () => {
    const world = new World();

    expect(() => world.addMany([], IsActive)).not.toThrow();
    expect(() => world.removeMany([], IsActive)).not.toThrow();
    expect(() => world.despawnMany([])).not.toThrow();

    world.destroy();
  });

  test.runIf(__DEV__)('dev rejects a dead handle inside a batch', () => {
    const world = new World();
    const batch = handles(world.spawnMany(3, Position));
    world.despawn(batch[1]);

    expect(() => world.addMany(batch, IsActive)).toThrowError(/apecs/);
    expect(() => world.despawnMany(batch)).toThrowError(/apecs/);

    world.destroy();
  });
});
