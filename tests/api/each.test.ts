/**
 * SPEC §6.5 — tier 2: `each` and the cursors it hands out. Public API only.
 */
import { afterEach, describe, expect, test } from 'vitest';

import { Not, Optional, Trait, With, World, f32, str } from '../../src/index';
import type { Entity } from '../../src/index';

const Position = new Trait({ x: f32(0), y: f32(0) });
const Velocity = new Trait({ x: f32(0), y: f32(0) });
const Body = new Trait({ pos: { x: 0, y: 0 }, mass: 1 });
const Label = new Trait({ text: str(''), visible: false });
const Mesh = new Trait(() => ({ moved: false }));
const IsActive = new Trait();

const worlds: World[] = [];

function makeWorld(options?: ConstructorParameters<typeof World>[0]): World {
  const world = new World(options);
  worlds.push(world);
  return world;
}

afterEach(() => {
  for (const world of worlds.splice(0)) {
    world.destroy();
  }
});

describe('arguments (§6.5)', () => {
  test('data terms arrive positionally, then the entity', () => {
    const world = makeWorld();
    const entity = world.spawn(Position({ x: 1 }), Velocity({ x: 2 }));
    const seen: unknown[] = [];

    world.query(Position, Velocity).each((p, v, e) => seen.push(p.x, v.x, e));

    expect(seen).toEqual([1, 2, entity]);
  });

  test('the entity is always last, whatever the term count', () => {
    const world = makeWorld();
    const entity = world.spawn(Position, Velocity, IsActive);

    world.query(IsActive).each((e) => expect(e).toBe(entity));
    world.query(Position, IsActive).each((_p, e) => expect(e).toBe(entity));
    world.query(Position, Velocity, IsActive).each((_p, _v, e) => expect(e).toBe(entity));
  });

  test('tags, Not and With contribute nothing', () => {
    const world = makeWorld();
    world.spawn(Position, IsActive);
    let arity = -1;

    world.query(Position, IsActive, Not(Velocity), With(IsActive)).each((...args) => {
      arity = args.length;
    });

    expect(arity).toBe(2);
  });

  test('an AoS trait arrives as the reference itself', () => {
    const world = makeWorld();
    const entity = world.spawn(Mesh);
    const reference = world.get(entity, Mesh);

    world.query(Mesh).each((mesh) => {
      expect(mesh).toBe(reference);
      mesh.moved = true;
    });

    expect(world.get(entity, Mesh).moved).toBe(true);
  });

  test('Optional hands out a cursor or null in its own position', () => {
    const world = makeWorld();
    world.spawn(Position({ x: 1 }));
    world.spawn(Position({ x: 2 }), Velocity({ x: 5 }));
    const seen: (number | null)[] = [];

    world.query(Position, Optional(Velocity)).each((_p, v) => seen.push(v === null ? null : v.x));

    expect(seen.sort()).toEqual([5, null]);
  });
});

describe('cursors read and write (§6.5)', () => {
  test('a cursor setter writes through to storage', () => {
    const world = makeWorld();
    const entity = world.spawn(Position({ x: 1, y: 1 }), Velocity({ x: 2, y: 3 }));

    world.query(Position, Velocity).each((p, v) => {
      p.x += v.x;
      p.y += v.y;
    });

    expect(world.get(entity, Position)).toEqual({ x: 3, y: 4 });
  });

  test('a cursor mirrors the declared shape — nested schemas stay nested', () => {
    const world = makeWorld();
    const entity = world.spawn(Body);

    world.query(Body).each((b) => {
      expect(b.pos.y).toBe(0);
      b.pos.x = 4;
      b.mass = 9;
    });

    expect(world.get(entity, Body)).toEqual({ pos: { x: 4, y: 0 }, mass: 9 });
  });

  test('the cursor nests where the field key is dotted', () => {
    // `Body['pos.x']` names the column (§3.3); the cursor mirrors the schema.
    const world = makeWorld();
    const entity = world.spawn(Body);

    world.set(entity, Body['pos.x'], 2);
    world.query(Body).each((b) => expect(b.pos.x).toBe(2));
  });

  test('bool and str columns round-trip through a cursor', () => {
    const world = makeWorld();
    const entity = world.spawn(Label);

    world.query(Label).each((l) => {
      expect(l.visible).toBe(false);
      l.visible = true;
      l.text = 'ready';
    });

    expect(world.get(entity, Label)).toEqual({ text: 'ready', visible: true });
  });

  test('each entity sees its own row', () => {
    const world = makeWorld({ pageSize: 4 });
    const swarm = world.spawnMany(10, Position);
    for (let i = 0; i < swarm.length; i++) {
      world.set(swarm[i] as Entity, Position.x, i);
    }
    const seen: number[] = [];

    world.query(Position).each((p) => seen.push(p.x));

    expect(seen.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test('every match is visited exactly once, across archetypes and pages', () => {
    const world = makeWorld({ pageSize: 4 });
    world.spawnMany(10, Position);
    world.spawnMany(10, Position, Velocity);
    world.spawnMany(10, Position, IsActive);
    const seen: Entity[] = [];

    world.query(Position).each((_p, e) => seen.push(e));

    expect(seen).toHaveLength(30);
    expect(new Set(seen).size).toBe(30);
  });

  test('each over an empty query never calls the callback', () => {
    const world = makeWorld();
    let calls = 0;

    world.query(Position).each(() => calls++);

    expect(calls).toBe(0);
  });

  test('each is re-runnable and reflects the current state', () => {
    const world = makeWorld();
    const query = world.query(Position);
    world.spawn(Position);
    const counts: number[] = [];
    const run = () => {
      let n = 0;
      query.each(() => n++);
      counts.push(n);
    };

    run();
    world.spawn(Position);
    run();

    expect(counts).toEqual([1, 2]);
  });
});

describe('cursors are borrowed (§6.5)', () => {
  test.runIf(__DEV__)('retaining a cursor past the callback is an error', () => {
    const world = makeWorld();
    world.spawn(Position);
    let escaped: { x: number } | undefined;

    world.query(Position).each((p) => {
      escaped = p;
    });

    expect(() => escaped!.x).toThrow();
    expect(() => {
      escaped!.x = 1;
    }).toThrow();
  });

  test('the same cursor object is reused across rows', () => {
    const world = makeWorld();
    world.spawnMany(4, Position);
    const seen = new Set<unknown>();

    world.query(Position).each((p) => seen.add(p));

    expect(seen.size).toBe(1);
  });
});

describe('nesting (§6.5, §9)', () => {
  test('a query may be walked inside another walk', () => {
    const world = makeWorld();
    world.spawnMany(3, Position);
    world.spawnMany(2, Velocity);
    let pairs = 0;

    world.query(Position).each(() => {
      world.query(Velocity).each(() => pairs++);
    });

    expect(pairs).toBe(6);
  });

  test('the same query may be walked inside itself', () => {
    const world = makeWorld();
    world.spawnMany(3, Position);
    let pairs = 0;

    world.query(Position).each(() => {
      world.query(Position).each(() => pairs++);
    });

    expect(pairs).toBe(9);
  });
});
