import { describe, expect, test } from 'vitest';

import { Not, Optional, Or, Trait, With, World, f32 } from '../src/index';
import { $archetypes } from '../src/internal';

const Position = new Trait({ x: f32(0), y: f32(0) });
const Velocity = new Trait({ x: f32(0), y: f32(0) });
const Health = new Trait({ hp: 0 });

describe('signature hashing (§6.2)', () => {
  test('the same term list returns the identical object', () => {
    const world = new World();

    expect(world.query(Position, Velocity)).toBe(world.query(Position, Velocity));
    expect(world.query(Position)).toBe(world.query(Position));

    world.destroy();
  });

  test('modifiers hash structurally, not by identity', () => {
    const world = new World();

    expect(world.query(Position, Not(Velocity))).toBe(world.query(Position, Not(Velocity)));
    expect(world.query(Or(Not(Velocity), Health))).toBe(world.query(Or(Not(Velocity), Health)));
    expect(world.query(Optional(Velocity))).toBe(world.query(Optional(Velocity)));

    world.destroy();
  });

  test('term order is part of the signature, because it is the argument order', () => {
    const world = new World();

    expect(world.query(Position, Velocity)).not.toBe(world.query(Velocity, Position));

    world.destroy();
  });

  test('a different modifier is a different query', () => {
    const world = new World();
    const plain = world.query(Position, Velocity);

    expect(world.query(Position, Not(Velocity))).not.toBe(plain);
    expect(world.query(Position, With(Velocity))).not.toBe(plain);
    expect(world.query(Position, Optional(Velocity))).not.toBe(plain);
    expect(world.query(Position)).not.toBe(plain);

    world.destroy();
  });

  test('the cache is per world', () => {
    const a = new World();
    const b = new World();

    expect(a.query(Position)).not.toBe(b.query(Position));

    a.destroy();
    b.destroy();
  });
});

describe('createQuery and dispose (§6.2)', () => {
  test('createQuery hoists the identical object the cache hands out', () => {
    const world = new World();
    const hoisted = world.createQuery(Position, Velocity);

    expect(world.query(Position, Velocity)).toBe(hoisted);
    expect(world.createQuery(Position, Velocity)).toBe(hoisted);

    world.destroy();
  });

  test('dispose drops the query from the cache', () => {
    const world = new World();
    const query = world.createQuery(Position);

    query.dispose();

    expect(world.query(Position)).not.toBe(query);

    world.destroy();
  });

  test('a disposed query stops tracking new archetypes', () => {
    const world = new World();
    const query = world.createQuery(Position);
    world.spawn(Position);

    expect(query[$archetypes]).toHaveLength(1);

    query.dispose();
    world.spawn(Position, Velocity);

    expect(query[$archetypes]).toHaveLength(1);

    world.destroy();
  });

  test('disposing twice is a no-op, and the replacement is fully live', () => {
    const world = new World();
    const query = world.createQuery(Position);
    world.spawn(Position);

    query.dispose();
    query.dispose();
    const replacement = world.query(Position);
    world.spawn(Position, Velocity);

    expect(replacement).not.toBe(query);
    expect(replacement[$archetypes]).toHaveLength(2);
    expect(replacement.count).toBe(2);

    world.destroy();
  });
});

describe('queryFirst (§6.3)', () => {
  test('queryFirst is sugar for the first entity of the query', () => {
    const world = new World();
    world.spawnMany(3, Position);

    expect(world.queryFirst(Position)).toBe(world.query(Position).first);

    world.destroy();
  });

  test('queryFirst is undefined when nothing matches', () => {
    const world = new World();
    world.spawn(Position);

    expect(world.queryFirst(Velocity)).toBeUndefined();
    expect(world.queryFirst(Position, Not(Position))).toBeUndefined();

    world.destroy();
  });

  test('queryFirst goes through the same cache', () => {
    const world = new World();
    const query = world.createQuery(Position);
    world.spawn(Position);

    expect(world.queryFirst(Position)).toBe(query.first);
    expect(world.query(Position)).toBe(query);

    world.destroy();
  });
});
