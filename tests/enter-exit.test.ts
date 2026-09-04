import { describe, expect, test } from 'vitest';

import { Trait, World, f32 } from '../src/index';
import type { Entity } from '../src/index';

const Position = new Trait({ x: f32(0), y: f32(0) });
const Velocity = new Trait({ x: f32(0), y: f32(0) });
const IsActive = new Trait();

describe('query enter and exit (§8.2)', () => {
  test('add fires onEnter the moment the entity starts matching', () => {
    const world = new World();
    const query = world.query(Position, IsActive);
    const entered: Entity[] = [];
    let matchedDuring = false;
    world.on('enter', query, (entity) => {
      matchedDuring = world.has(entity, Position) && world.has(entity, IsActive);
      entered.push(entity);
    });

    const e = world.spawn(Position);
    expect(entered).toEqual([]);

    world.add(e, IsActive);
    expect(entered).toEqual([e]);
    expect(matchedDuring).toBe(true);

    world.destroy();
  });

  test('spawn and despawn count as transitions', () => {
    const world = new World();
    const query = world.query(Position, IsActive);
    const log: string[] = [];
    world.on('enter', query, (e) => log.push(`enter:${e}`));
    world.on('exit', query, (e) => log.push(`exit:${e}`));

    const e = world.spawn(Position, IsActive);
    world.despawn(e);

    expect(log).toEqual([`enter:${e}`, `exit:${e}`]);

    world.destroy();
  });

  test('exit on despawn fires once the entity is gone', () => {
    const world = new World();
    const query = world.query(Position, IsActive);
    let aliveDuring = true;
    world.on('exit', query, (e) => {
      aliveDuring = world.isAlive(e);
    });

    world.despawn(world.spawn(Position, IsActive));

    expect(aliveDuring).toBe(false);

    world.destroy();
  });

  test('losing any required trait fires onExit', () => {
    const world = new World();
    const query = world.query(Position, IsActive);
    const exited: Entity[] = [];
    world.on('exit', query, (entity) => exited.push(entity));

    const a = world.spawn(Position, IsActive);
    const b = world.spawn(Position, IsActive);
    world.remove(a, IsActive);
    world.remove(b, Position);

    expect(exited).toEqual([a, b]);

    world.destroy();
  });

  test('a move between two matching archetypes fires neither', () => {
    const world = new World();
    const query = world.query(Position, IsActive);
    let events = 0;
    world.on('enter', query, () => events++);
    world.on('exit', query, () => events++);

    const e = world.spawn(Position, IsActive); // the one enter
    world.add(e, Velocity);
    world.remove(e, Velocity);

    expect(events).toBe(1);

    world.destroy();
  });

  test('an entity that never matched fires nothing', () => {
    const world = new World();
    const query = world.query(Position, IsActive);
    let events = 0;
    world.on('enter', query, () => events++);
    world.on('exit', query, () => events++);

    const e = world.spawn(Velocity);
    world.add(e, IsActive); // IsActive alone is not a match
    world.despawn(e);

    expect(events).toBe(0);

    world.destroy();
  });

  test('each query sees only its own boundary', () => {
    const world = new World();
    const log: string[] = [];
    world.on('enter', world.query(Position), (e) => log.push(`pos:${e}`));
    world.on('enter', world.query(Position, IsActive), (e) => log.push(`active:${e}`));

    const e = world.spawn(Position);
    world.add(e, IsActive); // already inside query(Position); only the second fires

    expect(log).toEqual([`pos:${e}`, `active:${e}`]);

    world.destroy();
  });

  test('a batch fires per entity, in order (§8.4)', () => {
    const world = new World();
    const query = world.query(Position, IsActive);
    const entered: Entity[] = [];
    world.on('enter', query, (entity) => entered.push(entity));

    const batch = world.spawnMany(2, Position);
    world.addMany(batch, IsActive);

    expect(entered).toEqual([batch[0], batch[1]]);

    world.destroy();
  });

  test('unsubscribe stops enter and exit dispatch', () => {
    const world = new World();
    const query = world.query(Position, IsActive);
    let entered = 0;
    let exited = 0;
    const offEnter = world.on('enter', query, () => entered++);
    const offExit = world.on('exit', query, () => exited++);

    const e = world.spawn(Position, IsActive);
    offEnter();
    offExit();
    world.remove(e, IsActive);
    world.add(e, IsActive);

    expect(entered).toBe(1);
    expect(exited).toBe(0);

    world.destroy();
  });
});
