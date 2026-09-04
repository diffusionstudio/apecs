import { describe, expect, test } from 'vitest';

import { Trait, World, f32 } from '../src/index';
import type { Entity } from '../src/index';
import { $archetypes, $entities, $id, $traits, entityId } from '../src/internal';

const Position = new Trait({ x: f32(0), y: f32(0) });
const Velocity = new Trait({ x: f32(0), y: f32(0) });
const IsActive = new Trait();

const archetypeOf = (world: World, e: Entity) =>
  world[$archetypes].list[world[$entities].archetypes[entityId(e)]];

describe('local ids (§5.3)', () => {
  test('a trait the world has never seen has no local id and no storage', () => {
    const Unused = new Trait({ x: 0 });
    const world = new World();

    expect(world[$traits].localId(Unused)).toBe(-1);
    expect(world[$traits].size).toBe(0);

    world.destroy();
  });

  test('local ids are dense and handed out in order of first use', () => {
    const world = new World();

    world.spawn(Velocity, Position);

    expect(world[$traits].localId(Velocity)).toBe(0);
    expect(world[$traits].localId(Position)).toBe(1);
    expect(world[$traits].localId(IsActive)).toBe(-1);

    world.spawn(IsActive);

    expect(world[$traits].localId(IsActive)).toBe(2);
    expect(world[$traits].size).toBe(3);

    world.destroy();
  });

  test('the global id identifies the trait; the local id is per world', () => {
    const a = new World();
    const b = new World();

    a.spawn(Position, Velocity);
    b.spawn(Velocity, Position);

    expect(a[$traits].localId(Position)).toBe(0);
    expect(b[$traits].localId(Position)).toBe(1);
    expect(Position[$id]).toBeGreaterThan(0);
    expect(Position[$id]).not.toBe(Velocity[$id]);

    a.destroy();
    b.destroy();
  });

  test('a local id survives the last entity losing the trait', () => {
    const world = new World();
    const e = world.spawn(Position);
    const local = world[$traits].localId(Position);

    world.remove(e, Position);

    expect(world[$traits].localId(Position)).toBe(local);
    expect(world[$traits].size).toBe(1);

    world.destroy();
  });
});

describe('unused traits cost nothing (§5.3)', () => {
  test('a world only registers the traits it actually uses', () => {
    const many = Array.from({ length: 100 }, () => new Trait({ x: 0 }));
    const world = new World();

    const e = world.spawn(many[40], many[90]);

    expect(world[$traits].size).toBe(2);
    expect(world[$traits].localId(many[0])).toBe(-1);
    expect(archetypeOf(world, e).mask).toHaveLength(1);

    world.destroy();
  });

  test('masks grow one 32-bit block at a time (§10.1)', () => {
    const tags = Array.from({ length: 33 }, () => new Trait());
    const world = new World();

    const e = world.spawn(...tags);

    expect(world[$traits].size).toBe(33);
    expect(archetypeOf(world, e).mask).toHaveLength(2);

    world.destroy();
  });
});

describe('lazy storage (§5.3, §10.2)', () => {
  test('the root archetype holds no columns', () => {
    const world = new World();

    expect(archetypeOf(world, world.spawn()).columns).toHaveLength(0);

    world.destroy();
  });

  test('columns are allocated on first use, one per field', () => {
    const world = new World();
    const e = world.spawn();

    world.add(e, Position);

    const archetype = archetypeOf(world, e);
    expect(archetype.columns).toHaveLength(2);
    expect(archetype.column(Position.x)).toBeDefined();
    expect(archetype.column(Position.y)).toBeDefined();
    expect(archetype.column(Velocity.x)).toBeUndefined();

    world.destroy();
  });

  test('a tag never allocates a column', () => {
    const world = new World();

    const e = world.spawn(IsActive);

    expect(world[$traits].localId(IsActive)).toBeGreaterThanOrEqual(0);
    expect(archetypeOf(world, e).columns).toHaveLength(0);

    world.destroy();
  });
});

describe('isolation across worlds (§5.3)', () => {
  test('the same trait has independent storage in each world', () => {
    const a = new World();
    const b = new World();
    const ea = a.spawn(Position({ x: 1 }));
    const eb = b.spawn(Position({ x: 2 }));

    expect(a.get(ea, Position.x)).toBe(1);
    expect(b.get(eb, Position.x)).toBe(2);

    a.set(ea, Position.x, 9);

    expect(b.get(eb, Position.x)).toBe(2);

    a.destroy();
    b.destroy();
  });

  test('despawning in one world leaves the other untouched', () => {
    const a = new World();
    const b = new World();
    const ea = a.spawn(Position({ x: 1 }));
    const eb = b.spawn(Position({ x: 2 }));

    a.despawn(ea);

    expect(a.isAlive(ea)).toBe(false);
    expect(b.isAlive(eb)).toBe(true);
    expect(b.get(eb, Position.x)).toBe(2);

    a.destroy();
    b.destroy();
  });
});
