/**
 * SPEC §4.1–4.4 — entity handles, lifecycle, bulk operations, and the
 * per-entity data operations. Public API only.
 */
import { afterEach, describe, expect, test } from 'vitest';

import { Trait, World, eid, f32 } from '../../src/index';
import type { Entity } from '../../src/index';

const Position = new Trait({ x: f32(0), y: f32(0) });
const Velocity = new Trait({ x: f32(0), y: f32(0) });
const Health = new Trait({ current: 100, max: 100 });
const IsActive = new Trait();
const Mesh = new Trait(() => ({ disposed: false }));

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

describe('representation (§4.1)', () => {
  test('an entity is a number, not an object', () => {
    const world = makeWorld();

    expect(typeof world.spawn()).toBe('number');
  });

  test('handles are integers inside the safe range', () => {
    const world = makeWorld();

    for (const entity of world.spawnMany(64)) {
      expect(Number.isSafeInteger(entity)).toBe(true);
      expect(entity).toBeGreaterThan(0);
    }
  });

  test('handles are unique across worlds', () => {
    const a = makeWorld();
    const b = makeWorld();
    const seen = new Set<number>();

    for (const world of [a, b]) {
      for (const entity of world.spawnMany(100)) {
        seen.add(entity);
      }
    }

    expect(seen.size).toBe(200);
  });

  test('a handle from another world is not alive here', () => {
    const a = makeWorld();
    const b = makeWorld();

    expect(b.isAlive(a.spawn())).toBe(false);
  });

  test('the world entity is distinct from every spawned entity', () => {
    const world = makeWorld();

    expect(world.isAlive(world.entity)).toBe(true);
    expect(world.spawn()).not.toBe(world.entity);
  });
});

describe('lifecycle (§4.2)', () => {
  test('spawn takes traits and instances together', () => {
    const world = makeWorld();
    const entity = world.spawn(Position({ x: 20 }), Velocity, IsActive);

    expect(world.get(entity, Position)).toEqual({ x: 20, y: 0 });
    expect(world.get(entity, Velocity)).toEqual({ x: 0, y: 0 });
    expect(world.has(entity, IsActive)).toBe(true);
  });

  test('spawn with no traits still produces a live entity', () => {
    const world = makeWorld();
    const entity = world.spawn();

    expect(world.isAlive(entity)).toBe(true);
    expect(world.has(entity, Position)).toBe(false);
  });

  test('despawn is immediate and generation-checked', () => {
    const world = makeWorld();
    const entity = world.spawn(Position);

    expect(world.isAlive(entity)).toBe(true);

    world.despawn(entity);

    expect(world.isAlive(entity)).toBe(false);
    expect(world.query(Position).count).toBe(0);
  });

  test('a recycled id does not resurrect the old handle', () => {
    const world = makeWorld();
    const stale = world.spawn(Position);
    world.despawn(stale);

    // FIFO recycling: churn enough to guarantee the id comes back.
    const fresh: Entity[] = [];
    for (let i = 0; i < 64; i++) {
      fresh.push(world.spawn(Position));
    }

    expect(world.isAlive(stale)).toBe(false);
    for (const entity of fresh) {
      expect(entity).not.toBe(stale);
    }
  });

  test('despawn is not destroy — the world survives it', () => {
    const world = makeWorld();
    world.despawn(world.spawn());

    expect(world.isAlive(world.entity)).toBe(true);
    expect(world.spawn(Position)).toBeGreaterThan(0);
  });

  test.runIf(__DEV__)('operating on a dead handle throws', () => {
    const world = makeWorld();
    const entity = world.spawn(Position);
    world.despawn(entity);

    expect(() => world.get(entity, Position)).toThrow();
    expect(() => world.set(entity, Position.x, 1)).toThrow();
    expect(() => world.add(entity, Velocity)).toThrow();
    expect(() => world.despawn(entity)).toThrow();
  });

  test.runIf(__DEV__)('the world entity cannot be despawned', () => {
    const world = makeWorld();

    expect(() => world.despawn(world.entity)).toThrow();
  });
});

describe('bulk operations (§4.3)', () => {
  test('spawnMany returns a Float64Array of n live handles', () => {
    const world = makeWorld();
    const swarm = world.spawnMany(1000, Position, Velocity);

    expect(swarm).toBeInstanceOf(Float64Array);
    expect(swarm.length).toBe(1000);
    expect(new Set(swarm).size).toBe(1000);
    for (const entity of swarm) {
      expect(world.isAlive(entity as Entity)).toBe(true);
    }
    expect(world.query(Position, Velocity).count).toBe(1000);
  });

  test('spawnMany applies the same initial values to every entity', () => {
    const world = makeWorld();
    const swarm = world.spawnMany(10, Position({ x: 3, y: 4 }));

    for (const entity of swarm) {
      expect(world.get(entity as Entity, Position)).toEqual({ x: 3, y: 4 });
    }
  });

  test('spawnMany(0) is an empty batch, not an error', () => {
    const world = makeWorld();

    expect(world.spawnMany(0, Position).length).toBe(0);
  });

  test('addMany and removeMany move the whole batch', () => {
    const world = makeWorld();
    const swarm = world.spawnMany(500, Position);

    world.addMany(swarm, IsActive, Velocity({ x: 1 }));

    expect(world.query(Position, Velocity, IsActive).count).toBe(500);
    expect(world.get(swarm[0] as Entity, Velocity.x)).toBe(1);

    world.removeMany(swarm, Velocity);

    expect(world.query(Velocity).count).toBe(0);
    expect(world.query(Position, IsActive).count).toBe(500);
  });

  test('despawnMany accepts a batch', () => {
    const world = makeWorld();
    const swarm = world.spawnMany(200, Position);

    world.despawnMany(swarm);

    expect(world.query(Position).count).toBe(0);
    for (const entity of swarm) {
      expect(world.isAlive(entity as Entity)).toBe(false);
    }
  });

  test('a query is a valid batch', () => {
    const world = makeWorld();
    const Dead = new Trait();
    world.spawnMany(50, Position, Dead);
    world.spawnMany(20, Position);

    world.despawnMany(world.query(Dead));

    expect(world.query(Dead).count).toBe(0);
    expect(world.query(Position).count).toBe(20);
  });

  test('a batch and the loop it replaces produce the same world', () => {
    const bulk = makeWorld();
    const loop = makeWorld();
    const swarm = bulk.spawnMany(100, Position({ x: 2 }));
    for (let i = 0; i < 100; i++) {
      loop.spawn(Position({ x: 2 }));
    }

    bulk.addMany(swarm, IsActive);
    for (const entity of loop.query(Position).entities()) {
      loop.add(entity as Entity, IsActive);
    }

    expect(bulk.query(Position, IsActive).count).toBe(loop.query(Position, IsActive).count);
    expect(bulk.get(swarm[0] as Entity, Position.x)).toBe(2);
  });

  test('spawning across a page boundary keeps every value intact', () => {
    const world = makeWorld({ pageSize: 8 });
    const swarm = world.spawnMany(20, Position);

    for (let i = 0; i < swarm.length; i++) {
      world.set(swarm[i] as Entity, Position.x, i);
    }
    for (let i = 0; i < swarm.length; i++) {
      expect(world.get(swarm[i] as Entity, Position.x)).toBe(i);
    }
  });
});

describe('per-entity operations (§4.4)', () => {
  test('add and remove change what an entity holds', () => {
    const world = makeWorld();
    const entity = world.spawn(Position);

    world.add(entity, Velocity({ x: 1 }), IsActive);

    expect(world.has(entity, Velocity)).toBe(true);
    expect(world.has(entity, IsActive)).toBe(true);

    world.remove(entity, Velocity);

    expect(world.has(entity, Velocity)).toBe(false);
    expect(world.has(entity, Position)).toBe(true);
  });

  test('re-adding a trait overwrites its value', () => {
    const world = makeWorld();
    const entity = world.spawn(Position({ x: 1 }));

    world.add(entity, Position({ x: 9 }));

    expect(world.get(entity, Position.x)).toBe(9);
  });

  test('removing a trait an entity does not hold is a no-op', () => {
    const world = makeWorld();
    const entity = world.spawn(Position);

    expect(() => world.remove(entity, Velocity)).not.toThrow();
    expect(world.has(entity, Position)).toBe(true);
  });

  test('get on a struct trait returns a copy, not a live view', () => {
    const world = makeWorld();
    const entity = world.spawn(Position({ x: 1, y: 2 }));
    const copy = world.get(entity, Position);

    copy.x = 99;

    expect(world.get(entity, Position.x)).toBe(1);
    expect(world.get(entity, Position)).not.toBe(copy);
  });

  test('get with an out object writes into it and returns it', () => {
    const world = makeWorld();
    const entity = world.spawn(Position({ x: 1, y: 2 }));
    const out = { x: 0, y: 0 };
    const returned = world.get(entity, Position, out);

    expect(returned).toBe(out);
    expect(out).toEqual({ x: 1, y: 2 });
  });

  test('set on a trait is a partial write', () => {
    const world = makeWorld();
    const entity = world.spawn(Health);

    world.set(entity, Health, { current: 30 });

    expect(world.get(entity, Health)).toEqual({ current: 30, max: 100 });
  });

  test('set on a field writes exactly one column', () => {
    const world = makeWorld();
    const entity = world.spawn(Position({ x: 1, y: 2 }));

    world.set(entity, Position.x, 5);

    expect(world.get(entity, Position)).toEqual({ x: 5, y: 2 });
  });

  test('has reports tags as well as data traits', () => {
    const world = makeWorld();
    const entity = world.spawn(IsActive);

    expect(world.has(entity, IsActive)).toBe(true);
    expect(world.has(entity, Position)).toBe(false);
  });

  test('an AoS reference survives archetype moves', () => {
    const world = makeWorld();
    const entity = world.spawn(Mesh);
    const mesh = world.get(entity, Mesh);

    world.add(entity, Position);
    world.remove(entity, Position);

    expect(world.get(entity, Mesh)).toBe(mesh);
  });

  test('values survive the archetype moves that add and remove cause', () => {
    const world = makeWorld();
    const entity = world.spawn(Position({ x: 1, y: 2 }), Health({ current: 50 }));

    world.add(entity, Velocity);
    world.add(entity, IsActive);
    world.remove(entity, Velocity);

    expect(world.get(entity, Position)).toEqual({ x: 1, y: 2 });
    expect(world.get(entity, Health)).toEqual({ current: 50, max: 100 });
  });

  test('a swap-removed neighbour keeps its own values', () => {
    const world = makeWorld();
    const a = world.spawn(Position({ x: 1 }));
    const b = world.spawn(Position({ x: 2 }));
    const c = world.spawn(Position({ x: 3 }));

    world.despawn(a);

    expect(world.get(b, Position.x)).toBe(2);
    expect(world.get(c, Position.x)).toBe(3);
  });

  test.runIf(__DEV__)('reading a trait the entity does not hold throws', () => {
    const world = makeWorld();
    const entity = world.spawn(Position);

    expect(() => world.get(entity, Velocity)).toThrow();
    expect(() => world.set(entity, Velocity.x, 1)).toThrow();
  });

  test.runIf(__DEV__)('a tag carries no value to get or set', () => {
    const world = makeWorld();
    const entity = world.spawn(IsActive);

    expect(() => world.get(entity, IsActive)).toThrow();
  });
});

describe('eid fields (§3.2, §8.5)', () => {
  test('an eid field stores and returns a handle', () => {
    const Following = new Trait({ target: eid(0) });
    const world = makeWorld();
    const leader = world.spawn();
    const follower = world.spawn(Following({ target: leader }));

    expect(world.get(follower, Following.target)).toBe(leader);
    expect(world.isAlive(world.get(follower, Following.target))).toBe(true);
  });
});
