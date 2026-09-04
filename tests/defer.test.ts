import { describe, expect, test } from 'vitest';

import { Trait, World, f32 } from '../src/index';
import type { Entity } from '../src/index';

const Position = new Trait({ x: f32(0), y: f32(0) });
const Velocity = new Trait({ x: f32(0), y: f32(0) });
const Health = new Trait({ current: 0 });
const IsEnemy = new Trait();

describe('defer and flush (§9)', () => {
  test('defer queues without running; flush drains in FIFO order', () => {
    const world = new World();
    const log: number[] = [];

    world.defer(() => log.push(1));
    world.defer(() => log.push(2));
    world.defer(() => log.push(3));
    expect(log).toEqual([]);

    world.flush();
    expect(log).toEqual([1, 2, 3]);

    world.destroy();
  });

  test('a flushed closure runs exactly once', () => {
    const world = new World();
    let runs = 0;
    world.defer(() => runs++);

    world.flush();
    world.flush();
    world.query(Position).each(() => {});

    expect(runs).toBe(1);

    world.destroy();
  });

  test('flush with nothing queued is a no-op', () => {
    const world = new World();

    expect(() => world.flush()).not.toThrow();

    world.destroy();
  });

  test('closures deferred while flushing run in the same flush, after those already queued', () => {
    const world = new World();
    const log: string[] = [];

    world.defer(() => {
      log.push('a');
      world.defer(() => log.push('a.child'));
    });
    world.defer(() => log.push('b'));
    world.flush();

    expect(log).toEqual(['a', 'b', 'a.child']);

    world.destroy();
  });

  test('a deferred structural change is applied by flush', () => {
    const world = new World();
    const e = world.spawn(Position);

    world.defer(() => world.add(e, Velocity));
    world.defer(() => world.despawn(e));
    expect(world.has(e, Velocity)).toBe(false);

    world.flush();
    expect(world.isAlive(e)).toBe(false);

    world.destroy();
  });
});

describe('implicit flush (§9)', () => {
  test('each flushes when it exits, not before', () => {
    const world = new World();
    world.spawnMany(3, Position);
    const query = world.query(Position);
    const countsDuring: number[] = [];

    query.each(() => {
      world.defer(() => world.spawn(Position));
      countsDuring.push(query.count);
    });

    expect(countsDuring).toEqual([3, 3, 3]);
    expect(query.count).toBe(6);

    world.destroy();
  });

  test('chunks flushes when the walk completes', () => {
    const world = new World();
    world.spawnMany(3, Position);
    const query = world.query(Position);

    for (const chunk of query.chunks()) {
      world.defer(() => world.spawn(Position));
      expect(chunk.length).toBe(3);
      expect(query.count).toBe(3);
    }

    expect(query.count).toBe(4);

    world.destroy();
  });

  test('breaking out of chunks still flushes', () => {
    const world = new World();
    world.spawnMany(2, Position);
    world.spawnMany(2, Position, Velocity);
    const query = world.query(Position);

    for (const _chunk of query.chunks()) {
      world.defer(() => world.spawn(Position));
      break;
    }

    expect(query.count).toBe(5);

    world.destroy();
  });

  test('nested iteration flushes once, at the outermost exit', () => {
    const world = new World();
    world.spawnMany(2, Position);
    world.spawnMany(2, Velocity);
    const positions = world.query(Position);
    const velocities = world.query(Velocity);
    let runs = 0;
    let ranBeforeOuterExit = false;

    positions.each(() => {
      velocities.each(() => world.defer(() => runs++));
      for (const _chunk of velocities.chunks()) {
        world.defer(() => runs++);
      }
      if (runs !== 0) {
        ranBeforeOuterExit = true;
      }
    });

    expect(ranBeforeOuterExit).toBe(false);
    expect(runs).toBe(2 * (2 + 1));

    world.destroy();
  });

  test('a walk inside a deferred closure does not restart the flush', () => {
    const world = new World();
    world.spawnMany(2, Position);
    const log: string[] = [];

    world.defer(() => {
      world.query(Position).each(() => log.push('inner'));
      world.defer(() => log.push('late'));
    });
    world.defer(() => log.push('second'));
    world.query(Velocity).each(() => {});

    expect(log).toEqual(['inner', 'inner', 'second', 'late']);

    world.destroy();
  });

  test('a callback that throws still closes the walk', () => {
    const world = new World();
    world.spawn(Position);
    let runs = 0;

    expect(() =>
      world.query(Position).each(() => {
        throw new Error('boom');
      }),
    ).toThrow('boom');

    world.defer(() => runs++);
    world.query(Position).each(() => {});
    expect(runs).toBe(1);

    world.destroy();
  });

  test('the reap pattern from the worked example (§13)', () => {
    const world = new World();
    const dead: Entity[] = [];
    const alive: Entity[] = [];
    for (let i = 0; i < 6; i++) {
      const e = world.spawn(Health({ current: i % 2 === 0 ? 0 : 10 }), IsEnemy);
      (i % 2 === 0 ? dead : alive).push(e);
    }

    world.query(Health, IsEnemy).each((hp, e: Entity) => {
      if (hp.current <= 0) {
        world.defer(() => world.despawn(e));
      }
    });

    expect(dead.every((e) => !world.isAlive(e))).toBe(true);
    expect(alive.every((e) => world.isAlive(e))).toBe(true);

    world.destroy();
  });
});
