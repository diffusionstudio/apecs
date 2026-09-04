import { describe, expect, test } from 'vitest';

import { Trait, World, f32 } from '../src/index';
import type { Entity } from '../src/index';

const Position = new Trait({ x: f32(0), y: f32(0) });
const Velocity = new Trait({ x: f32(0), y: f32(0) });
const IsActive = new Trait();
const Time = new Trait({ delta: 0 });

describe('observer dispatch (§8.1)', () => {
  test('onAdd dispatches inside the operation with the value applied', () => {
    const world = new World();
    const seen: [Entity, number][] = [];
    world.onAdd(Position, (entity, target) => {
      expect(target).toBeUndefined();
      seen.push([entity, world.get(entity, Position.x)]);
    });

    const spawned = world.spawn(Position({ x: 1 }));
    expect(seen).toEqual([[spawned, 1]]);

    const added = world.spawn();
    world.add(added, Position({ x: 2 }));
    expect(seen).toEqual([
      [spawned, 1],
      [added, 2],
    ]);

    world.destroy();
  });

  test('spawn fires onAdd for every trait it carries, tags included', () => {
    const world = new World();
    const log: string[] = [];
    world.onAdd(Position, () => log.push('position'));
    world.onAdd(IsActive, () => log.push('active'));

    world.spawn(Position, IsActive);

    expect(log.sort()).toEqual(['active', 'position']);

    world.destroy();
  });

  test('onRemove fires before the data is destroyed', () => {
    const world = new World();
    const e = world.spawn(Position({ x: 7 }));
    let seen = -1;
    world.onRemove(Position, (entity) => {
      seen = world.get(entity, Position.x);
    });

    world.remove(e, Position);

    expect(seen).toBe(7);
    expect(world.has(e, Position)).toBe(false);

    world.destroy();
  });

  test('despawn fires onRemove for every trait, data intact', () => {
    const world = new World();
    const removed: string[] = [];
    world.onRemove(Position, (entity) => removed.push(`pos:${world.get(entity, Position.x)}`));
    world.onRemove(IsActive, () => removed.push('tag'));

    const e = world.spawn(Position({ x: 3 }), IsActive);
    world.despawn(e);

    expect(removed.sort()).toEqual(['pos:3', 'tag']);
    expect(world.isAlive(e)).toBe(false);

    world.destroy();
  });

  test('onRemove is usable for resource disposal', () => {
    const Mesh = new Trait(() => ({ disposed: false }));
    const world = new World();
    world.onRemove(Mesh, (entity) => {
      world.get(entity, Mesh).disposed = true;
    });

    const mesh = { disposed: false };
    const e = world.spawn(Mesh(mesh));
    world.despawn(e);

    expect(mesh.disposed).toBe(true);

    world.destroy();
  });

  test('a no-op remove dispatches nothing', () => {
    const world = new World();
    let calls = 0;
    world.onRemove(Velocity, () => calls++);

    const e = world.spawn(Position);
    world.remove(e, Velocity);

    expect(calls).toBe(0);

    world.destroy();
  });

  test('onChange fires for trait writes, field writes and world.markChanged', () => {
    const world = new World();
    const e = world.spawn(Position);
    const seen: Entity[] = [];
    world.onChange(Position, (entity) => seen.push(entity));

    world.set(e, Position, { x: 1 });
    world.set(e, Position.y, 2);
    world.markChanged(e, Position);

    expect(seen).toEqual([e, e, e]);

    world.destroy();
  });

  test('a write to a different trait does not cross-fire', () => {
    const world = new World();
    const e = world.spawn(Position, Velocity);
    let calls = 0;
    world.onChange(Position, () => calls++);

    world.set(e, Velocity.x, 1);

    expect(calls).toBe(0);

    world.destroy();
  });

  test('world traits dispatch with the world entity (§5.4)', () => {
    const world = new World();
    const events: Entity[] = [];
    world.onAdd(Time, (entity) => events.push(entity));

    world.add(Time);

    expect(events).toEqual([world.entity]);

    world.destroy();
  });
});

describe('ordering (§8.4)', () => {
  test('observers for one trait fire in registration order', () => {
    const world = new World();
    const order: string[] = [];
    world.onAdd(IsActive, () => order.push('first'));
    world.onAdd(IsActive, () => order.push('second'));

    world.spawn(IsActive);

    expect(order).toEqual(['first', 'second']);

    world.destroy();
  });

  test('a batch fires every handler for entity n before entity n+1', () => {
    const world = new World();
    const log: string[] = [];
    world.onAdd(IsActive, (e) => log.push(`a${e}`));
    world.onAdd(IsActive, (e) => log.push(`b${e}`));

    const [x, y] = world.spawnMany(2, IsActive);
    expect(log).toEqual([`a${x}`, `b${x}`, `a${y}`, `b${y}`]);

    const c = world.spawn();
    const d = world.spawn();
    log.length = 0;
    world.addMany([c, d], IsActive);
    expect(log).toEqual([`a${c}`, `b${c}`, `a${d}`, `b${d}`]);

    world.destroy();
  });

  test('unsubscribing stops dispatch and leaves other observers alone', () => {
    const world = new World();
    const log: string[] = [];
    const off = world.onAdd(IsActive, () => log.push('a'));
    world.onAdd(IsActive, () => log.push('b'));

    world.spawn(IsActive);
    off();
    off(); // a second call is a no-op
    world.spawn(IsActive);

    expect(log).toEqual(['a', 'b', 'b']);

    world.destroy();
  });
});

describe('reentrancy (§8.4)', () => {
  test('structural changes inside an observer apply immediately', () => {
    const world = new World();
    const seen: boolean[] = [];
    world.onAdd(Position, (entity) => world.add(entity, IsActive));
    world.onAdd(IsActive, (entity) => seen.push(world.has(entity, Position)));

    const e = world.spawn(Position);

    expect(world.has(e, IsActive)).toBe(true);
    expect(seen).toEqual([true]);

    world.destroy();
  });

  test('a bounded cascade runs to completion', () => {
    const Chain = new Trait();
    const world = new World();
    let depth = 0;
    world.onAdd(Chain, () => {
      if (++depth < 16) {
        world.spawn(Chain);
      }
    });

    world.spawn(Chain);

    expect(depth).toBe(16);

    world.destroy();
  });

  test.runIf(__DEV__)('dev throws when a cascade exceeds the depth cap', () => {
    const Chain = new Trait();
    const world = new World();
    world.onAdd(Chain, () => world.spawn(Chain));

    expect(() => world.spawn(Chain)).toThrowError(/apecs/);

    world.destroy();
  });
});
