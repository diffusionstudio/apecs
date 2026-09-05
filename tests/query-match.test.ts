import { describe, expect, test, vi } from 'vitest';

import { Added, Changed, Not, Optional, Or, Removed, Trait, With, World, f32 } from '../src/index';
import type { Entity, Term } from '../src/index';
import {
  $archetypes,
  $entities,
  $plan,
  $traits,
  compileTerms,
  createMask,
  entityId,
  maskWith,
  type Mask,
} from '../src/internal';

const Position = new Trait({ x: f32(0), y: f32(0) });
const Velocity = new Trait({ x: f32(0), y: f32(0) });
const Health = new Trait({ hp: 0 });
const IsActive = new Trait();

const archetypeOf = (world: World, e: Entity) =>
  world[$archetypes].list[world[$entities].archetypes[entityId(e)]];

const planFor = (world: World, ...terms: Term[]) => compileTerms(world[$traits], terms);

/** The mask an archetype holding exactly `traits` would carry. */
const maskFor = (world: World, ...traits: Trait[]): Mask => {
  let mask = createMask();
  for (const trait of traits) {
    mask = maskWith(mask, world[$traits].register(trait));
  }
  return mask;
};

describe('terms compile to a mask predicate (§6.1, §10.4)', () => {
  test('an all-of list requires every trait and tolerates extras', () => {
    const world = new World();
    const plan = planFor(world, Position, Velocity);

    expect(plan.test(maskFor(world, Position, Velocity))).toBe(true);
    expect(plan.test(maskFor(world, Position, Velocity, Health))).toBe(true);
    expect(plan.test(maskFor(world, Position))).toBe(false);
    expect(plan.test(maskFor(world, Velocity))).toBe(false);
    expect(plan.test(maskFor(world))).toBe(false);

    world.destroy();
  });

  test('Not excludes the archetypes that carry the trait', () => {
    const world = new World();
    const plan = planFor(world, Position, Not(Velocity));

    expect(plan.test(maskFor(world, Position))).toBe(true);
    expect(plan.test(maskFor(world, Position, Health))).toBe(true);
    expect(plan.test(maskFor(world, Position, Velocity))).toBe(false);
    expect(plan.test(maskFor(world, Velocity))).toBe(false);

    world.destroy();
  });

  test('Or matches when any operand matches', () => {
    const world = new World();
    const plan = planFor(world, Or(Velocity, Health));

    expect(plan.test(maskFor(world, Velocity))).toBe(true);
    expect(plan.test(maskFor(world, Health))).toBe(true);
    expect(plan.test(maskFor(world, Velocity, Health))).toBe(true);
    expect(plan.test(maskFor(world, Position))).toBe(false);

    world.destroy();
  });

  test('With constrains exactly like a bare trait', () => {
    const world = new World();
    const plan = planFor(world, Position, With(IsActive));

    expect(plan.test(maskFor(world, Position, IsActive))).toBe(true);
    expect(plan.test(maskFor(world, Position))).toBe(false);
    expect(plan.test(maskFor(world, IsActive))).toBe(false);

    world.destroy();
  });

  test('Optional constrains nothing', () => {
    const world = new World();
    const plan = planFor(world, Position, Optional(Velocity));

    expect(plan.test(maskFor(world, Position))).toBe(true);
    expect(plan.test(maskFor(world, Position, Velocity))).toBe(true);
    expect(plan.test(maskFor(world, Velocity))).toBe(false);

    world.destroy();
  });

  test('modifiers nest', () => {
    const world = new World();
    const plan = planFor(world, Or(Not(Position), Velocity));

    expect(plan.test(maskFor(world, Health))).toBe(true);
    expect(plan.test(maskFor(world, Position, Velocity))).toBe(true);
    expect(plan.test(maskFor(world, Position))).toBe(false);

    world.destroy();
  });

  test('Added and Changed require their trait; Removed cannot', () => {
    const world = new World();
    const added = planFor(world, Added(Velocity));
    const changed = planFor(world, Changed(Position));
    const removed = planFor(world, Position, Removed(Velocity));

    expect(added.test(maskFor(world, Velocity))).toBe(true);
    expect(added.test(maskFor(world, Position))).toBe(false);

    expect(changed.test(maskFor(world, Position))).toBe(true);
    expect(changed.test(maskFor(world, Velocity))).toBe(false);

    // The trait is gone by the time `Removed` reports it, so the mask must match
    // an archetype without it (SPEC §8.3).
    expect(removed.test(maskFor(world, Position))).toBe(true);

    world.destroy();
  });

  test('compiling registers the traits, so every term owns a mask bit', () => {
    const world = new World();
    const Fresh = new Trait({ n: 0 });

    expect(world[$traits].localId(Fresh)).toBe(-1);

    const plan = planFor(world, Fresh);

    expect(world[$traits].localId(Fresh)).toBeGreaterThanOrEqual(0);
    expect(plan.test(maskFor(world, Fresh))).toBe(true);
    expect(plan.test(maskFor(world))).toBe(false);

    world.destroy();
  });

  test('the predicate reads an archetype mask straight out of the graph', () => {
    const world = new World();
    const plan = planFor(world, Position, Not(Velocity));

    expect(plan.test(archetypeOf(world, world.spawn(Position, Health)).mask)).toBe(true);
    expect(plan.test(archetypeOf(world, world.spawn(Position, Velocity)).mask)).toBe(false);
    expect(plan.test(world[$archetypes].root.mask)).toBe(false);

    world.destroy();
  });
});

describe('the matching list is maintained incrementally (§10.4)', () => {
  test('a query picks up the archetypes that already exist', () => {
    const world = new World();
    const a = archetypeOf(world, world.spawn(Position));
    const b = archetypeOf(world, world.spawn(Position, Velocity));
    archetypeOf(world, world.spawn(Health));

    const matching = world.query(Position)[$archetypes];

    expect(matching).toHaveLength(2);
    expect(matching).toContain(a);
    expect(matching).toContain(b);

    world.destroy();
  });

  test('an archetype created later is appended to the queries it matches', () => {
    const world = new World();
    const positions = world.query(Position);
    const velocities = world.query(Velocity);
    world.spawn(Position);

    expect(positions[$archetypes]).toHaveLength(1);
    expect(velocities[$archetypes]).toHaveLength(0);

    const both = archetypeOf(world, world.spawn(Position, Velocity));

    expect(positions[$archetypes]).toHaveLength(2);
    expect(positions[$archetypes]).toContain(both);
    expect(velocities[$archetypes]).toEqual([both]);

    world.destroy();
  });

  test('an archetype is listed once, however many entities pass through it', () => {
    const world = new World();
    const query = world.query(Position);
    const e = world.spawn(Position);

    for (let i = 0; i < 4; i++) {
      world.spawn(Position);
    }
    world.add(e, Velocity);
    world.remove(e, Velocity);
    world.despawn(e);

    expect(query[$archetypes]).toHaveLength(2);
    expect(new Set(query[$archetypes]).size).toBe(2);

    world.destroy();
  });

  test('each archetype is tested once, when it is created', () => {
    const world = new World();
    world.spawn(Position);
    const query = world.query(Position, Velocity);
    const plan = vi.spyOn(query[$plan], 'test');

    world.spawn(Position, Velocity);

    expect(plan).toHaveBeenCalledTimes(1);

    world.spawn(Position, Velocity);
    world.spawn(Position);

    expect(plan).toHaveBeenCalledTimes(1);

    world.destroy();
  });

  test('per-frame matching is free — running the query does not re-test anything', () => {
    const world = new World();
    world.spawnMany(8, Position, Velocity);
    const query = world.query(Position, Velocity);
    const plan = vi.spyOn(query[$plan], 'test');

    for (let frame = 0; frame < 3; frame++) {
      world.query(Position, Velocity).each(() => {});
      expect(query.count).toBe(8);
    }

    expect(plan).not.toHaveBeenCalled();

    world.destroy();
  });

  test('a query matches whatever local trait id the world happened to assign', () => {
    // Local ids are dense and assigned on first use, so a world with a few
    // dozen traits puts one of them on the sign bit of a mask block. Nothing
    // about that trait is special, and a query on it must not come back empty.
    const many = Array.from({ length: 40 }, () => new Trait({ v: f32(0) }));
    const world = new World();
    for (const trait of many) {
      world.spawn(trait);
    }

    for (let id = 0; id < many.length; id++) {
      expect([id, world.query(many[id]).count]).toEqual([id, 1]);
    }

    world.destroy();
  });
});
