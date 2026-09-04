/**
 * SPEC §8 — observers, query enter/exit, change ticks, ordering, and the
 * `eid` reference patching. Public API only.
 */
import { afterEach, describe, expect, test } from 'vitest';

import { Changed, Relation, Trait, World, eid, f32 } from '../../src/index';
import type { Entity, QueryResult } from '../../src/index';

const Position = new Trait({ x: f32(0), y: f32(0) });
const Velocity = new Trait({ x: f32(0), y: f32(0) });
const IsActive = new Trait();
const Mesh = new Trait(() => ({ disposed: false }));
const Following = new Trait({ target: eid(0) });
const Loose = new Trait({ target: 0 });

const worlds: World[] = [];

function makeWorld(options?: ConstructorParameters<typeof World>[0]): World {
  const world = new World(options);
  worlds.push(world);
  return world;
}

function drain(query: QueryResult): Entity[] {
  const seen: Entity[] = [];
  query.each((...args) => seen.push(args[args.length - 1] as Entity));
  return seen;
}

afterEach(() => {
  for (const world of worlds.splice(0)) {
    world.destroy();
  }
});

describe('observers (§8.1)', () => {
  test('onAdd fires for spawn and for add', () => {
    const world = makeWorld();
    const seen: Entity[] = [];
    world.onAdd(Position, (e) => seen.push(e));

    const spawned = world.spawn(Position);
    const added = world.spawn(Velocity);
    world.add(added, Position);

    expect(seen).toEqual([spawned, added]);
  });

  test('onRemove fires for remove and for despawn', () => {
    const world = makeWorld();
    const seen: Entity[] = [];
    world.onRemove(Position, (e) => seen.push(e));
    const a = world.spawn(Position);
    const b = world.spawn(Position);

    world.remove(a, Position);
    world.despawn(b);

    expect(seen).toEqual([a, b]);
  });

  test('onRemove fires before the data is destroyed', () => {
    const world = makeWorld();
    const values: number[] = [];
    world.onRemove(Mesh, (e) => {
      const mesh = world.get(e, Mesh);
      mesh.disposed = true;
      values.push(world.get(e, Position.x));
    });
    const entity = world.spawn(Position({ x: 7 }), Mesh);
    const mesh = world.get(entity, Mesh);

    world.despawn(entity);

    expect(values).toEqual([7]);
    expect(mesh.disposed).toBe(true);
  });

  test('onChange fires on world.set', () => {
    const world = makeWorld();
    const seen: Entity[] = [];
    world.onChange(Position, (e) => seen.push(e));
    const entity = world.spawn(Position);

    world.set(entity, Position.x, 1);
    world.set(entity, Position, { y: 2 });

    expect(seen).toEqual([entity, entity]);
  });

  test('a cursor write stamps the tick but does not call onChange', () => {
    // §6.5/§8.3: cursor setters write the change tick, which is what `Changed()`
    // reads. They do not dispatch the push observer — a call per row is exactly
    // the cost tier 2 exists to avoid. Pull, do not push, at scale.
    const world = makeWorld();
    const seen: Entity[] = [];
    world.onChange(Position, (e) => seen.push(e));
    const entity = world.spawn(Position);
    const changed = world.query(Position, Changed(Position));
    drain(changed);

    world.step();
    world.query(Position).each((p) => {
      p.x = 1;
    });

    expect(seen).toEqual([]);
    expect(drain(changed)).toEqual([entity]);
  });

  test('onChange fires on world.markChanged', () => {
    const world = makeWorld();
    const seen: Entity[] = [];
    world.onChange(Position, (e) => seen.push(e));
    const entity = world.spawn(Position);

    world.markChanged(entity, Position);

    expect(seen).toEqual([entity]);
  });

  test('every subscription returns an unsubscribe that stops the calls', () => {
    const world = makeWorld();
    let calls = 0;
    const offs = [
      world.onAdd(Position, () => calls++),
      world.onRemove(Position, () => calls++),
      world.onChange(Position, () => calls++),
    ];
    const entity = world.spawn(Position);
    world.set(entity, Position.x, 1);
    world.despawn(entity);
    const before = calls;

    for (const off of offs) {
      off();
    }

    const second = world.spawn(Position);
    world.set(second, Position.x, 1);
    world.despawn(second);

    expect(before).toBe(3);
    expect(calls).toBe(3);
  });

  test('unsubscribing twice is harmless', () => {
    const world = makeWorld();
    const off = world.onAdd(Position, () => {});

    off();

    expect(() => off()).not.toThrow();
  });

  test('handlers are dispatched immediately, before the operation returns', () => {
    const world = makeWorld();
    const order: string[] = [];
    world.onAdd(Position, () => order.push('observer'));

    order.push('before');
    world.spawn(Position);
    order.push('after');

    expect(order).toEqual(['before', 'observer', 'after']);
  });

  test('handlers for one trait fire in registration order', () => {
    const world = makeWorld();
    const order: number[] = [];
    world.onAdd(Position, () => order.push(1));
    world.onAdd(Position, () => order.push(2));
    world.onAdd(Position, () => order.push(3));

    world.spawn(Position);

    expect(order).toEqual([1, 2, 3]);
  });

  test('a relation observer receives the target', () => {
    const ChildOf = new Relation(undefined, { exclusive: true });
    const world = makeWorld();
    const seen: [Entity, Entity | undefined][] = [];
    world.onAdd(ChildOf, (e, target) => seen.push([e, target]));
    const parent = world.spawn();

    const child = world.spawn(ChildOf(parent));

    expect(seen).toEqual([[child, parent]]);
  });

  test('a non-relation observer receives undefined as the target', () => {
    const world = makeWorld();
    const targets: unknown[] = [];
    world.onAdd(Position, (_e, target) => targets.push(target));

    world.spawn(Position);

    expect(targets).toEqual([undefined]);
  });

  test('an observer on a relation fires for any target', () => {
    const ChildOf = new Relation(undefined, { exclusive: true });
    const world = makeWorld();
    let calls = 0;
    world.onAdd(ChildOf, () => calls++);
    const a = world.spawn();
    const b = world.spawn();

    world.spawn(ChildOf(a));
    world.spawn(ChildOf(b));

    expect(calls).toBe(2);
  });

  test('an observer on a pair fires for that pair alone', () => {
    const Likes = new Relation({ amount: 0 });
    const world = makeWorld();
    const a = world.spawn();
    const b = world.spawn();
    const seen: Entity[] = [];
    world.onAdd(Likes(a), (e) => seen.push(e));

    const first = world.spawn(Likes(a));
    world.spawn(Likes(b));

    expect(seen).toEqual([first]);
  });
});

describe('batch ordering (§8.4)', () => {
  test('all handlers for entity n fire before those for entity n+1', () => {
    const world = makeWorld();
    const order: string[] = [];
    world.onAdd(Position, (e) => order.push(`p${e}`));
    world.onAdd(Velocity, (e) => order.push(`v${e}`));

    const batch = world.spawnMany(3, Position, Velocity);

    expect(order).toEqual([
      `p${batch[0]}`,
      `v${batch[0]}`,
      `p${batch[1]}`,
      `v${batch[1]}`,
      `p${batch[2]}`,
      `v${batch[2]}`,
    ]);
  });

  test('observers fire only after every value is in place', () => {
    const world = makeWorld();
    const seen: { x: number; vx: number }[] = [];
    world.onAdd(Position, (e) =>
      seen.push({ x: world.get(e, Position.x), vx: world.get(e, Velocity.x) }),
    );

    world.spawn(Position({ x: 1 }), Velocity({ x: 2 }));

    expect(seen).toEqual([{ x: 1, vx: 2 }]);
  });

  test('a structural change inside an observer applies immediately', () => {
    const world = makeWorld();
    world.onAdd(Position, (e) => world.add(e, IsActive));

    const entity = world.spawn(Position);

    expect(world.has(entity, IsActive)).toBe(true);
  });

  test.runIf(__DEV__)('an unbounded observer cascade is caught', () => {
    const world = makeWorld();
    let n = 0;
    world.onAdd(Position, () => {
      n++;
      world.spawn(Position);
    });

    expect(() => world.spawn(Position)).toThrow();
    expect(n).toBeLessThan(1000);
  });
});

describe('query enter and exit (§8.2)', () => {
  test('enter fires when an entity starts matching', () => {
    const world = makeWorld();
    const query = world.query(Position, IsActive);
    const seen: Entity[] = [];
    world.onEnter(query, (e) => seen.push(e));

    const entity = world.spawn(Position);

    expect(seen).toEqual([]);

    world.add(entity, IsActive);

    expect(seen).toEqual([entity]);
  });

  test('exit fires when an entity stops matching', () => {
    const world = makeWorld();
    const query = world.query(Position, IsActive);
    const seen: Entity[] = [];
    world.onExit(query, (e) => seen.push(e));
    const entity = world.spawn(Position, IsActive);

    world.remove(entity, IsActive);

    expect(seen).toEqual([entity]);
  });

  test('exit fires on despawn', () => {
    const world = makeWorld();
    const seen: Entity[] = [];
    world.onExit(world.query(Position), (e) => seen.push(e));
    const entity = world.spawn(Position);

    world.despawn(entity);

    expect(seen).toEqual([entity]);
  });

  test('spawning straight into the match fires enter once', () => {
    const world = makeWorld();
    const seen: Entity[] = [];
    world.onEnter(world.query(Position, IsActive), (e) => seen.push(e));

    const entity = world.spawn(Position, IsActive);

    expect(seen).toEqual([entity]);
  });

  test('a move that keeps the entity matching fires neither', () => {
    const world = makeWorld();
    const query = world.query(Position);
    let calls = 0;
    world.onEnter(query, () => calls++);
    world.onExit(query, () => calls++);
    const entity = world.spawn(Position);

    expect(calls).toBe(1); // the spawn

    world.add(entity, Velocity);
    world.remove(entity, Velocity);

    expect(calls).toBe(1);
  });

  test('both return an unsubscribe', () => {
    const world = makeWorld();
    const query = world.query(Position);
    let calls = 0;
    const offEnter = world.onEnter(query, () => calls++);
    const offExit = world.onExit(query, () => calls++);

    offEnter();
    offExit();
    world.despawn(world.spawn(Position));

    expect(calls).toBe(0);
  });

  test('enter and exit fire for every member of a batch', () => {
    const world = makeWorld();
    const entered: Entity[] = [];
    const exited: Entity[] = [];
    const query = world.query(Position);
    world.onEnter(query, (e) => entered.push(e));
    world.onExit(query, (e) => exited.push(e));

    const batch = world.spawnMany(5, Position);
    world.despawnMany(batch);

    expect(entered).toHaveLength(5);
    expect(exited).toHaveLength(5);
    expect(new Set(entered)).toEqual(new Set(batch));
  });
});

describe('change ticks (§8.3)', () => {
  test('Changed sees a set, a cursor write, and world.markChanged alike', () => {
    const world = makeWorld();
    const bySet = world.spawn(Position, IsActive);
    const query = world.query(Position, Changed(Position));
    drain(query);

    world.step();
    world.set(bySet, Position.x, 1);

    expect(drain(query)).toEqual([bySet]);

    world.step();
    world.query(Position).each((p) => {
      p.y = 2;
    });

    expect(drain(query)).toEqual([bySet]);

    world.step();
    world.markChanged(bySet, Position);

    expect(drain(query)).toEqual([bySet]);
  });

  test('a write to a different trait is not a change to this one', () => {
    const world = makeWorld();
    const entity = world.spawn(Position, Velocity);
    const query = world.query(Position, Changed(Position));
    drain(query);

    world.step();
    world.set(entity, Velocity.x, 1);

    expect(drain(query)).toEqual([]);
  });

  test('a chunk write is invisible until it is marked', () => {
    const world = makeWorld();
    world.spawnMany(3, Position);
    const query = world.query(Position, Changed(Position));
    drain(query);

    world.step();
    for (const chunk of world.query(Position).chunks()) {
      const { x } = chunk.get(Position);
      for (let i = 0; i < chunk.length; i++) {
        x[i] = 1;
      }
    }

    expect(drain(query)).toEqual([]);

    world.step();
    for (const chunk of world.query(Position).chunks()) {
      chunk.markChanged(Position);
    }

    expect(drain(query)).toHaveLength(3);
  });

  test('world.markChanged on a world trait works through the trait-first overload', () => {
    const Time = new Trait({ delta: 0 });
    const world = makeWorld();
    world.add(Time);
    const query = world.query(Time, Changed(Time));
    drain(query);

    world.step();
    world.markChanged(Time);

    expect(drain(query)).toEqual([world.entity]);
  });
});

describe('dangling references (§8.5)', () => {
  test('an eid field is patched to 0 when its target despawns', () => {
    const world = makeWorld();
    const leader = world.spawn();
    const follower = world.spawn(Following({ target: leader }));

    expect(world.get(follower, Following.target)).toBe(leader);

    world.despawn(leader);

    expect(world.get(follower, Following.target)).toBe(0);
  });

  test('every holder of the reference is patched', () => {
    const world = makeWorld();
    const leader = world.spawn();
    const followers = world.spawnMany(50, Following({ target: leader }));

    world.despawn(leader);

    for (const follower of followers) {
      expect(world.get(follower as Entity, Following.target)).toBe(0);
    }
  });

  test('unrelated references are left alone', () => {
    const world = makeWorld();
    const a = world.spawn();
    const b = world.spawn();
    const followA = world.spawn(Following({ target: a }));
    const followB = world.spawn(Following({ target: b }));

    world.despawn(a);

    expect(world.get(followA, Following.target)).toBe(0);
    expect(world.get(followB, Following.target)).toBe(b);
  });

  test('a bare number field is not patched — it just fails its liveness check', () => {
    const world = makeWorld();
    const leader = world.spawn();
    const follower = world.spawn(Loose({ target: leader }));

    world.despawn(leader);

    expect(world.get(follower, Loose.target)).toBe(leader);
    expect(world.isAlive(world.get(follower, Loose.target) as Entity)).toBe(false);
  });
});
