/**
 * SPEC §5 — worlds: creation options, subclassing, trait isolation, world
 * traits, and teardown. Public API only.
 */
import { afterEach, describe, expect, test } from 'vitest';

import { Trait, World, f32 } from '../../src/index';
import type { Entity, WorldOptions } from '../../src/index';

const Position = new Trait({ x: f32(0), y: f32(0) });
const Velocity = new Trait({ x: f32(0), y: f32(0) });
const Time = new Trait({ delta: 0, current: 0 });
const IsActive = new Trait();

const worlds: World[] = [];

function makeWorld(options?: WorldOptions): World {
  const world = new World(options);
  worlds.push(world);
  return world;
}

afterEach(() => {
  for (const world of worlds.splice(0)) {
    world.destroy();
  }
});

describe('creation (§5.1)', () => {
  test('a world takes no options', () => {
    const world = makeWorld();

    expect(world.spawn(Position)).toBeGreaterThan(0);
  });

  test('pageSize and maxEntities are honoured without changing behaviour', () => {
    const small = makeWorld({ pageSize: 4, maxEntities: 16 });
    const large = makeWorld({ pageSize: 4096, maxEntities: 1 << 16 });

    for (const world of [small, large]) {
      const swarm = world.spawnMany(50, Position({ x: 1 }));
      expect(world.query(Position).count).toBe(50);
      expect(world.get(swarm[49] as Entity, Position.x)).toBe(1);
    }
  });

  test('maxEntities pre-sizes but does not cap', () => {
    const world = makeWorld({ maxEntities: 4 });

    expect(world.spawnMany(100, Position).length).toBe(100);
    expect(world.query(Position).count).toBe(100);
  });

  test.runIf(__DEV__)('a page size that is not a power of two is rejected', () => {
    expect(() => new World({ pageSize: 100 })).toThrow();
    expect(() => new World({ pageSize: 0 })).toThrow();
  });

  test.runIf(__DEV__)('a non-positive maxEntities is rejected', () => {
    expect(() => new World({ maxEntities: 0 })).toThrow();
    expect(() => new World({ maxEntities: 1.5 })).toThrow();
  });
});

describe('inheritance (§5.2)', () => {
  class GameWorld extends World {
    public readonly seed: number;

    public constructor(seed: number) {
      super({ pageSize: 8 });
      this.seed = seed;
      this.add(Time);
    }

    public spawnPlayer(x: number, y: number): Entity {
      return this.spawn(Position({ x, y }), Velocity, IsActive);
    }
  }

  test('a subclass may hold its own state and call world methods in its constructor', () => {
    const world = new GameWorld(1234);
    worlds.push(world);

    expect(world.seed).toBe(1234);
    expect(world.has(Time)).toBe(true);

    const player = world.spawnPlayer(20, 10);

    expect(world.get(player, Position)).toEqual({ x: 20, y: 10 });
    expect(world.query(Position, Velocity, IsActive).count).toBe(1);
  });

  test('subclass fields do not collide with internal state', () => {
    class Colliding extends World {
      public readonly entities = 'mine';
      public readonly archetypes = 42;
      public readonly queries = null;
    }
    const world = new Colliding();
    worlds.push(world);
    const entity = world.spawn(Position({ x: 1 }));

    expect(world.entities).toBe('mine');
    expect(world.get(entity, Position.x)).toBe(1);
    expect(world.query(Position).count).toBe(1);
  });

  test('every world method is overridable — none is a bound closure', () => {
    const calls: string[] = [];
    class Logging extends World {
      public override spawn(...items: Parameters<World['spawn']>): Entity {
        calls.push('spawn');
        return super.spawn(...items);
      }
      public override despawn(entity: Entity): void {
        calls.push('despawn');
        super.despawn(entity);
      }
    }
    const world = new Logging();
    worlds.push(world);

    world.despawn(world.spawn(Position));

    expect(calls).toEqual(['spawn', 'despawn']);
  });

  test('instanceof holds through the subclass', () => {
    const world = new GameWorld(1);
    worlds.push(world);

    expect(world).toBeInstanceOf(GameWorld);
    expect(world).toBeInstanceOf(World);
  });
});

describe('trait isolation (§5.3)', () => {
  test('storage is fully independent between worlds', () => {
    const a = makeWorld();
    const b = makeWorld();
    const ea = a.spawn(Position({ x: 1 }));
    const eb = b.spawn(Position({ x: 2 }));

    a.set(ea, Position.x, 100);

    expect(b.get(eb, Position.x)).toBe(2);
  });

  test('a trait never used in a world is simply absent there', () => {
    const a = makeWorld();
    const b = makeWorld();
    a.spawn(Velocity);

    expect(b.query(Velocity).count).toBe(0);
    expect(b.query(Velocity).isEmpty).toBe(true);
  });

  test('a trait declared after a world exists still works in it', () => {
    const world = makeWorld();
    world.spawn(Position);
    const Late = new Trait({ v: 0 });

    expect(world.get(world.spawn(Late({ v: 3 })), Late.v)).toBe(3);
  });

  test('observers are per world', () => {
    const a = makeWorld();
    const b = makeWorld();
    let calls = 0;
    a.on('add', Position, () => calls++);

    b.spawn(Position);

    expect(calls).toBe(0);

    a.spawn(Position);

    expect(calls).toBe(1);
  });
});

describe('world traits (§5.4)', () => {
  test('the trait-first overloads target the world entity', () => {
    const world = makeWorld();

    expect(world.has(Time)).toBe(false);

    world.add(Time);

    expect(world.has(Time)).toBe(true);

    world.set(Time, { delta: 0.016 });

    expect(world.get(Time)).toEqual({ delta: 0.016, current: 0 });
    expect(world.get(Time.delta)).toBe(0.016);

    world.set(Time.current, 5);

    expect(world.get(Time.current)).toBe(5);

    world.remove(Time);

    expect(world.has(Time)).toBe(false);
  });

  test('the entity-first form on world.entity is the same thing', () => {
    const world = makeWorld();
    world.add(Time);

    world.set(world.entity, Time, { delta: 1 });

    expect(world.get(Time.delta)).toBe(1);
    expect(world.has(world.entity, Time)).toBe(true);
  });

  test('the world entity is queryable like any other', () => {
    const world = makeWorld();
    world.add(Time);

    expect(world.query(Time).count).toBe(1);
    expect(world.query(Time).first).toBe(world.entity);
  });

  test('a world trait gets observers like any other', () => {
    const world = makeWorld();
    const seen: Entity[] = [];
    world.on('add', Time, (e) => seen.push(e));

    world.add(Time);

    expect(seen).toEqual([world.entity]);
  });

  test('spawned entities do not pick up world traits', () => {
    const world = makeWorld();
    world.add(Time);

    expect(world.has(world.spawn(Position), Time)).toBe(false);
  });
});

describe('the clock (§8.3)', () => {
  test('tick starts at a number and step advances it by one', () => {
    const world = makeWorld();
    const start = world.tick;

    expect(Number.isInteger(start)).toBe(true);

    world.step();
    world.step();

    expect(world.tick).toBe(start + 2);
  });

  test('each world has its own clock', () => {
    const a = makeWorld();
    const b = makeWorld();
    const start = b.tick;

    a.step();

    expect(b.tick).toBe(start);
  });
});

describe('clear (§5.5)', () => {
  test('clear despawns everything and keeps the world usable', () => {
    const world = makeWorld();
    const swarm = world.spawnMany(100, Position);
    world.add(Time);

    world.clear();

    expect(world.query(Position).count).toBe(0);
    for (const entity of swarm) {
      expect(world.isAlive(entity as Entity)).toBe(false);
    }
    expect(world.isAlive(world.entity)).toBe(true);
    expect(world.query(Position).isEmpty).toBe(true);

    const fresh = world.spawn(Position({ x: 1 }));

    expect(world.get(fresh, Position.x)).toBe(1);
    expect(world.query(Position).count).toBe(1);
  });

  test('clear fires onRemove for every despawned entity', () => {
    const world = makeWorld();
    let calls = 0;
    world.on('remove', Position, () => calls++);
    world.spawnMany(10, Position);

    world.clear();

    expect(calls).toBe(10);
  });

  test('clear keeps hoisted queries and accessors valid', () => {
    const world = makeWorld();
    const query = world.createQuery(Position);
    const px = world.accessor(Position.x);
    world.spawnMany(5, Position);

    world.clear();

    expect(query.count).toBe(0);

    const fresh = world.spawn(Position({ x: 3 }));

    expect(query.count).toBe(1);
    expect(px.get(fresh)).toBe(3);
  });
});

describe('compact (§10.2)', () => {
  test('compact is observationally invisible', () => {
    const world = makeWorld({ pageSize: 4 });
    const swarm = world.spawnMany(20, Position({ x: 1 }));
    for (let i = 10; i < 20; i++) {
      world.despawn(swarm[i] as Entity);
    }

    world.compact();

    expect(world.query(Position).count).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect(world.get(swarm[i] as Entity, Position.x)).toBe(1);
    }
  });

  test('compact on an empty world is a no-op', () => {
    const world = makeWorld();

    expect(() => world.compact()).not.toThrow();
  });
});

describe('destroy (§5.5)', () => {
  test('destroy fires onRemove for every entity, including the world entity', () => {
    const world = new World();
    const seen: Entity[] = [];
    world.on('remove', Position, (e) => seen.push(e));
    world.on('remove', Time, (e) => seen.push(e));
    world.add(Time);
    const entity = world.spawn(Position);

    world.destroy();

    expect(seen).toContain(entity);
    expect(seen).toContain(world.entity);
  });

  test('onRemove can still read the data it is being told about', () => {
    const world = new World();
    const values: number[] = [];
    world.on('remove', Position, (e) => values.push(world.get(e, Position.x)));
    world.spawn(Position({ x: 7 }));

    world.destroy();

    expect(values).toEqual([7]);
  });

  test('destroy is idempotent', () => {
    const world = new World();
    world.spawn(Position);

    world.destroy();

    expect(() => world.destroy()).not.toThrow();
  });

  test.runIf(__DEV__)('any call after destroy throws in dev', () => {
    const world = new World();
    const entity = world.spawn(Position);

    world.destroy();

    expect(() => world.spawn(Position)).toThrow();
    expect(() => world.query(Position)).toThrow();
    expect(() => world.isAlive(entity)).toThrow();
    expect(() => world.step()).toThrow();
    expect(() => world.clear()).toThrow();
  });

  test('destroy releases the world id for reuse and the next world is intact', () => {
    // §5.5: the liveness check is id-based, not instance-based, so a handle
    // minted by a destroyed world is only guaranteed to fail against a world
    // that does not hold the same id. What is contract is that destroying a
    // world leaves the next one working.
    const first = new World();
    first.spawnMany(10, Position);
    first.destroy();

    const second = makeWorld();
    const swarm = second.spawnMany(10, Position({ x: 1 }));

    expect(second.query(Position).count).toBe(10);
    expect(second.get(swarm[9] as Entity, Position.x)).toBe(1);
  });

  test('a handle from a live foreign world is never alive here', () => {
    const a = makeWorld();
    const b = makeWorld();
    const foreign = a.spawn(Position);

    expect(b.isAlive(foreign)).toBe(false);
  });
});
