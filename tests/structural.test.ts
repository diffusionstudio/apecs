import { describe, expect, test, vi } from 'vitest';

import { Trait, World, f32 } from '../src/index';
import type { Entity } from '../src/index';
import { $archetypes, $entities, entityId } from '../src/internal';

const Position = new Trait({ x: f32(0), y: f32(0) });
const Velocity = new Trait({ x: f32(1), y: f32(2) });
const IsActive = new Trait();

const archetypeOf = (world: World, e: Entity) =>
  world[$archetypes].list[world[$entities].archetypes[entityId(e)]];
const rowOf = (world: World, e: Entity) => world[$entities].rows[entityId(e)];

describe('add / has (§4.4)', () => {
  test('add applies the instance value and moves the entity', () => {
    const world = new World();
    const e = world.spawn();
    const before = archetypeOf(world, e);

    world.add(e, Position({ x: 1, y: 2 }));

    expect(archetypeOf(world, e)).not.toBe(before);
    expect(world.has(e, Position)).toBe(true);
    expect(world.get(e, Position)).toEqual({ x: 1, y: 2 });

    world.destroy();
  });

  test('a bare trait takes the schema defaults', () => {
    const world = new World();
    const e = world.spawn();

    world.add(e, Velocity);

    expect(world.get(e, Velocity)).toEqual({ x: 1, y: 2 });

    world.destroy();
  });

  test('an instance value is partial — unspecified fields fall back to the default', () => {
    const world = new World();

    const e = world.spawn(Velocity({ y: 9 }));

    expect(world.get(e, Velocity)).toEqual({ x: 1, y: 9 });

    world.destroy();
  });

  test('has is false for a trait that was never added', () => {
    const world = new World();

    const e = world.spawn(Position);

    expect(world.has(e, Position)).toBe(true);
    expect(world.has(e, Velocity)).toBe(false);
    expect(world.has(e, IsActive)).toBe(false);

    world.destroy();
  });

  test('adding several traits at once preserves the data already there', () => {
    const world = new World();
    const e = world.spawn(Position({ x: 1, y: 2 }));

    world.add(e, Velocity({ x: 3 }), IsActive);

    expect(world.get(e, Position)).toEqual({ x: 1, y: 2 });
    expect(world.get(e, Velocity)).toEqual({ x: 3, y: 2 });
    expect(world.has(e, IsActive)).toBe(true);

    world.destroy();
  });
});

describe('re-adding (§4.4)', () => {
  test('re-adding with a value overwrites in place, without a transition', () => {
    const world = new World();
    const e = world.spawn(Position({ x: 1, y: 2 }));
    const archetype = archetypeOf(world, e);
    const row = rowOf(world, e);

    world.add(e, Position({ x: 9 }));

    expect(archetypeOf(world, e)).toBe(archetype);
    expect(rowOf(world, e)).toBe(row);
    expect(world.get(e, Position)).toEqual({ x: 9, y: 0 });

    world.destroy();
  });

  test('re-adding a bare trait is idempotent and leaves the data alone', () => {
    const world = new World();
    const e = world.spawn(Position({ x: 1, y: 2 }));

    world.add(e, Position);

    expect(world.get(e, Position)).toEqual({ x: 1, y: 2 });

    world.destroy();
  });

  test('re-adding a tag is a no-op', () => {
    const world = new World();
    const e = world.spawn(IsActive);
    const archetype = archetypeOf(world, e);

    world.add(e, IsActive);

    expect(archetypeOf(world, e)).toBe(archetype);
    expect(archetype.rows).toBe(1);

    world.destroy();
  });
});

describe('remove (§4.4)', () => {
  test('remove drops the trait and its data', () => {
    const world = new World();
    const e = world.spawn(Position({ x: 1 }), Velocity);

    world.remove(e, Position);

    expect(world.has(e, Position)).toBe(false);
    expect(world.get(e, Velocity)).toEqual({ x: 1, y: 2 });

    world.destroy();
  });

  test('re-adding after a remove starts from the defaults again', () => {
    const world = new World();
    const e = world.spawn(Position({ x: 7, y: 8 }));

    world.remove(e, Position);
    world.add(e, Position);

    expect(world.get(e, Position)).toEqual({ x: 0, y: 0 });

    world.destroy();
  });

  test('removing a trait the entity does not have changes nothing', () => {
    const world = new World();
    const e = world.spawn(Position({ x: 1 }));
    const archetype = archetypeOf(world, e);
    const row = rowOf(world, e);

    world.remove(e, Velocity);

    expect(archetypeOf(world, e)).toBe(archetype);
    expect(rowOf(world, e)).toBe(row);
    expect(world.get(e, Position.x)).toBe(1);

    world.destroy();
  });

  test('removing several traits at once leaves the rest intact', () => {
    const world = new World();
    const e = world.spawn(Position({ x: 1 }), Velocity, IsActive);

    world.remove(e, Velocity, IsActive);

    expect(world.has(e, Velocity)).toBe(false);
    expect(world.has(e, IsActive)).toBe(false);
    expect(world.get(e, Position.x)).toBe(1);

    world.destroy();
  });
});

describe('defaults are per entity (§3.1)', () => {
  test('each entity gets its own copy of the struct defaults', () => {
    const world = new World();
    const a = world.spawn(Position);
    const b = world.spawn(Position);

    world.set(a, Position.x, 5);

    expect(world.get(a, Position.x)).toBe(5);
    expect(world.get(b, Position.x)).toBe(0);

    world.destroy();
  });

  test('an AoS factory runs once per entity, yielding distinct references', () => {
    const factory = vi.fn(() => ({ n: 0 }));
    const Mesh = new Trait(factory);
    const world = new World();

    const a = world.spawn(Mesh);
    const b = world.spawn(Mesh);

    expect(factory).toHaveBeenCalledTimes(2);
    expect(world.get(a, Mesh)).not.toBe(world.get(b, Mesh));

    world.destroy();
  });

  test('an AoS instance adopts the reference instead of calling the factory', () => {
    const factory = vi.fn(() => ({ n: 0 }));
    const Mesh = new Trait(factory);
    const world = new World();
    const existing = { n: 7 };

    const e = world.spawn(Mesh(existing));

    expect(factory).not.toHaveBeenCalled();
    expect(world.get(e, Mesh)).toBe(existing);

    world.destroy();
  });

  test('the factory runs again when the trait is removed and re-added bare', () => {
    const factory = vi.fn(() => ({ n: 0 }));
    const Mesh = new Trait(factory);
    const world = new World();
    const e = world.spawn(Mesh);
    const first = world.get(e, Mesh);

    world.remove(e, Mesh);
    world.add(e, Mesh);

    expect(factory).toHaveBeenCalledTimes(2);
    expect(world.get(e, Mesh)).not.toBe(first);

    world.destroy();
  });
});

describe('dev guards (§12.2)', () => {
  test.runIf(__DEV__)('structural ops on a dead entity throw', () => {
    const world = new World();
    const e = world.spawn();
    world.despawn(e);

    expect(() => world.add(e, Position)).toThrowError(/apecs/);
    expect(() => world.remove(e, Position)).toThrowError(/apecs/);
    expect(() => world.has(e, Position)).toThrowError(/apecs/);

    world.destroy();
  });
});
