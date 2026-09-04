/**
 * SPEC §9 — what is safe to do while iterating, and the deferral that covers
 * the rest. Public API only.
 */
import { afterEach, describe, expect, test } from 'vitest';

import { Trait, World, f32 } from '../../src/index';
import type { Entity } from '../../src/index';

const Position = new Trait({ x: f32(0), y: f32(0) });
const Velocity = new Trait({ x: f32(0), y: f32(0) });
const Splash = new Trait({ at: 0 });
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

describe('safe during iteration (§9)', () => {
  test('reading and writing values on any entity', () => {
    const world = makeWorld({ pageSize: 4 });
    const swarm = world.spawnMany(20, Position, Velocity);
    const other = swarm[0] as Entity;

    world.query(Position, Velocity).each((p, v, e) => {
      p.x = 1;
      v.x = world.get(other, Position.x);
      world.set(e, Position.y, 2);
    });

    for (const entity of swarm) {
      expect(world.get(entity as Entity, Position)).toEqual({ x: 1, y: 2 });
    }
  });

  test('adding a trait to the current entity', () => {
    const world = makeWorld({ pageSize: 4 });
    world.spawnMany(20, Position);

    world.query(Position).each((_p, e) => world.add(e, IsActive));

    expect(world.query(Position, IsActive).count).toBe(20);
  });

  test('removing a trait from the current entity', () => {
    const world = makeWorld({ pageSize: 4 });
    world.spawnMany(20, Position, Velocity);

    world.query(Position, Velocity).each((_p, _v, e) => world.remove(e, Velocity));

    expect(world.query(Velocity).count).toBe(0);
    expect(world.query(Position).count).toBe(20);
  });

  test('despawning the current entity', () => {
    const world = makeWorld({ pageSize: 4 });
    world.spawnMany(20, Position);
    let visited = 0;

    world.query(Position).each((_p, e) => {
      visited++;
      world.despawn(e);
    });

    expect(visited).toBe(20);
    expect(world.query(Position).count).toBe(0);
  });

  test('the same holds while walking chunks', () => {
    const world = makeWorld({ pageSize: 4 });
    world.spawnMany(20, Position);
    let visited = 0;

    for (const chunk of world.query(Position).chunks()) {
      const entities = chunk.entities.slice(0, chunk.length);
      for (const entity of entities) {
        visited++;
        world.despawn(entity as Entity);
      }
    }

    expect(visited).toBe(20);
    expect(world.query(Position).count).toBe(0);
  });

  test('entities() is the snapshot escape hatch', () => {
    const world = makeWorld();
    const swarm = world.spawnMany(20, Position);

    for (const entity of world.query(Position).entities()) {
      world.despawn(entity as Entity);
      world.spawn(Position, IsActive);
    }

    expect(world.query(Position, IsActive).count).toBe(20);
    for (const entity of swarm) {
      expect(world.isAlive(entity as Entity)).toBe(false);
    }
  });
});

describe('deferral (§9)', () => {
  test('defer queues and flush drains in FIFO order', () => {
    const world = makeWorld();
    const order: number[] = [];

    world.defer(() => order.push(1));
    world.defer(() => order.push(2));
    world.defer(() => order.push(3));

    expect(order).toEqual([]);

    world.flush();

    expect(order).toEqual([1, 2, 3]);
  });

  test('flush on an empty queue is a no-op', () => {
    const world = makeWorld();

    expect(() => world.flush()).not.toThrow();
  });

  test('each flushes automatically when it completes', () => {
    const world = makeWorld();
    const swarm = world.spawnMany(10, Position);
    for (const entity of swarm) {
      world.set(entity as Entity, Position.y, -1);
    }

    world.query(Position).each((p, e) => {
      if (p.y < 0) {
        world.defer(() => world.spawn(Splash({ at: e })));
      }
    });

    expect(world.query(Splash).count).toBe(10);
  });

  test('chunks flushes automatically when it completes', () => {
    const world = makeWorld({ pageSize: 4 });
    world.spawnMany(10, Position);

    for (const chunk of world.query(Position).chunks()) {
      const n = chunk.length;
      world.defer(() => world.spawnMany(n, Splash));
    }

    expect(world.query(Splash).count).toBe(10);
  });

  test('deferred work runs after the walk, not during it', () => {
    const world = makeWorld();
    world.spawnMany(5, Position);
    let visited = 0;

    world.query(Position).each(() => {
      visited++;
      world.defer(() => world.spawn(Position));
    });

    expect(visited).toBe(5);
    expect(world.query(Position).count).toBe(10);
  });

  test('nested iteration flushes once, at the outermost exit', () => {
    const world = makeWorld();
    world.spawnMany(2, Position);
    world.spawnMany(2, Velocity);
    const order: string[] = [];

    world.query(Position).each(() => {
      world.query(Velocity).each(() => {
        world.defer(() => order.push('deferred'));
      });
      order.push('inner done');
    });
    order.push('outer done');

    expect(order.filter((step) => step === 'deferred')).toHaveLength(4);
    expect(order.indexOf('deferred')).toBeGreaterThan(order.lastIndexOf('inner done'));
    expect(order[order.length - 1]).toBe('outer done');
  });

  test('deferred spawns are safe from inside a walk', () => {
    const world = makeWorld({ pageSize: 4 });
    world.spawnMany(20, Position);

    world.query(Position).each((_p, e) => {
      world.defer(() => world.spawn(Splash({ at: e })));
    });

    expect(world.query(Splash).count).toBe(20);
    expect(world.query(Position).count).toBe(20);
  });

  test('deferred despawns of other entities are safe', () => {
    const world = makeWorld({ pageSize: 4 });
    const swarm = world.spawnMany(20, Position);
    const victim = swarm[0] as Entity;

    world.query(Position).each((_p, e) => {
      if (e === victim) {
        return;
      }
      world.defer(() => {
        if (world.isAlive(victim)) {
          world.despawn(victim);
        }
      });
    });

    expect(world.isAlive(victim)).toBe(false);
    expect(world.query(Position).count).toBe(19);
  });

  test('a deferred closure may itself defer', () => {
    const world = makeWorld();
    const order: string[] = [];

    world.defer(() => {
      order.push('first');
      world.defer(() => order.push('second'));
    });
    world.flush();

    expect(order).toEqual(['first', 'second']);
  });

  test('flush inside a walk is available for callers who want it explicitly', () => {
    const world = makeWorld();
    world.spawn(Position);
    const order: string[] = [];

    world.query(Position).each(() => {
      world.defer(() => order.push('deferred'));
      world.flush();
      order.push('after flush');
    });

    expect(order).toEqual(['deferred', 'after flush']);
  });
});

describe('the dev guard (§9, §12.2)', () => {
  /** Rows are walked back to front, so `rows[0]` is the one reached last. */
  function rows(world: World, n: number): Entity[] {
    const out: Entity[] = [];
    for (let i = 0; i < n; i++) {
      out.push(world.spawn(Position({ x: i })));
    }
    return out;
  }

  test.runIf(__DEV__)('despawning an entity the walk has not reached is caught', () => {
    const world = makeWorld();
    const spawned = rows(world, 3);

    expect(() =>
      world.query(Position).each(() => {
        world.despawn(spawned[0]);
      }),
    ).toThrow(/apecs/);
  });

  test.runIf(__DEV__)('moving an entity the walk has not reached is caught', () => {
    const world = makeWorld();
    const spawned = rows(world, 3);

    expect(() =>
      world.query(Position).each(() => {
        world.add(spawned[0], IsActive);
      }),
    ).toThrow(/apecs/);
  });

  test.runIf(__DEV__)('the guard fires before anything has changed', () => {
    const world = makeWorld();
    const spawned = rows(world, 3);

    expect(() =>
      world.query(Position).each(() => {
        world.despawn(spawned[0]);
      }),
    ).toThrow(/apecs/);
    expect(spawned.every((entity) => world.isAlive(entity))).toBe(true);
    expect(world.query(Position).count).toBe(3);
  });

  test.runIf(__DEV__)('the guard does not outlive the walk', () => {
    const world = makeWorld();
    const spawned = rows(world, 3);

    world.query(Position).each(() => {});

    expect(() => world.despawn(spawned[0])).not.toThrow();
  });

  test.runIf(__DEV__)('deferring the same work is accepted', () => {
    const world = makeWorld();
    world.spawnMany(4, Position);

    expect(() =>
      world.query(Position).each(() => {
        world.defer(() => world.spawn(Position));
      }),
    ).not.toThrow();
  });
});
