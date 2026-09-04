/**
 * SPEC §4.5 — accessors: a field resolved once, then addressed by handle.
 * Public API only.
 */
import { afterEach, describe, expect, test } from 'vitest';

import { Relation, Trait, World, f32, str } from '../../src/index';
import type { Accessor, Entity } from '../../src/index';

const Position = new Trait({ x: f32(0), y: f32(0) });
const Velocity = new Trait({ x: f32(0), y: f32(0) });
const Flags = new Trait({ on: false });
const Label = new Trait({ text: str('') });
const Mesh = new Trait(() => ({ n: 0 }));
const IsActive = new Trait();
const Owns = new Relation({ amount: 0 });
const ChildOf = new Relation(undefined, { exclusive: true });

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

describe('shape (§4.5)', () => {
  test('an accessor is get and set over one field', () => {
    const world = makeWorld();
    const entity = world.spawn(Position({ x: 1 }));
    const px: Accessor<number> = world.accessor(Position.x);

    expect(px.get(entity)).toBe(1);

    px.set(entity, 5);

    expect(px.get(entity)).toBe(5);
    expect(world.get(entity, Position.x)).toBe(5);
  });

  test('an AoS trait is its own field and takes an accessor bare', () => {
    const world = makeWorld();
    const entity = world.spawn(Mesh);
    const mesh = world.accessor(Mesh);
    const replacement = { n: 3 };

    expect(mesh.get(entity)).toEqual({ n: 0 });

    mesh.set(entity, replacement);

    expect(mesh.get(entity)).toBe(replacement);
    expect(world.get(entity, Mesh)).toBe(replacement);
  });

  test('accessors are memoised per world and field', () => {
    const world = makeWorld();

    expect(world.accessor(Position.x)).toBe(world.accessor(Position.x));
    expect(world.accessor(Position.x)).not.toBe(world.accessor(Position.y));
  });

  test('two worlds get their own accessor for the same field', () => {
    const a = makeWorld();
    const b = makeWorld();
    const ea = a.spawn(Position({ x: 1 }));
    const eb = b.spawn(Position({ x: 2 }));

    expect(a.accessor(Position.x)).not.toBe(b.accessor(Position.x));
    expect(a.accessor(Position.x).get(ea)).toBe(1);
    expect(b.accessor(Position.x).get(eb)).toBe(2);
  });

  test('a bool field reads back as a boolean and a str field as a string', () => {
    const world = makeWorld();
    const entity = world.spawn(Flags, Label);
    const on = world.accessor(Flags.on);
    const text = world.accessor(Label.text);

    expect(on.get(entity)).toBe(false);

    on.set(entity, true);
    text.set(entity, 'hello');

    expect(on.get(entity)).toBe(true);
    expect(text.get(entity)).toBe('hello');
  });
});

describe('the accessor follows the entity (§4.5)', () => {
  test('through an archetype move', () => {
    const world = makeWorld();
    const entity = world.spawn(Position({ x: 1 }));
    const px = world.accessor(Position.x);

    world.add(entity, Velocity, IsActive);

    expect(px.get(entity)).toBe(1);

    px.set(entity, 7);
    world.remove(entity, Velocity);

    expect(px.get(entity)).toBe(7);
  });

  test('through a swap-remove that moves the row', () => {
    const world = makeWorld();
    const px = world.accessor(Position.x);
    const a = world.spawn(Position({ x: 1 }));
    const b = world.spawn(Position({ x: 2 }));
    const c = world.spawn(Position({ x: 3 }));

    world.despawn(a);

    expect(px.get(b)).toBe(2);
    expect(px.get(c)).toBe(3);
  });

  test('into pages a later spawn appends', () => {
    const world = makeWorld({ pageSize: 4 });
    const px = world.accessor(Position.x);
    const swarm = world.spawnMany(4, Position);
    const late = world.spawn(Position({ x: 42 }));

    expect(px.get(late)).toBe(42);

    px.set(late, 43);

    expect(px.get(late)).toBe(43);
    expect(px.get(swarm[0] as Entity)).toBe(0);
  });

  test('across compact()', () => {
    const world = makeWorld({ pageSize: 4 });
    const px = world.accessor(Position.x);
    const swarm = world.spawnMany(12, Position);
    for (let i = 8; i < 12; i++) {
      world.despawn(swarm[i] as Entity);
    }

    world.compact();

    expect(px.get(swarm[0] as Entity)).toBe(0);

    px.set(swarm[0] as Entity, 5);

    expect(px.get(swarm[0] as Entity)).toBe(5);
  });

  test('across clear() and a fresh population', () => {
    const world = makeWorld();
    const px = world.accessor(Position.x);
    px.set(world.spawn(Position), 1);

    world.clear();

    const fresh = world.spawn(Position({ x: 9 }));

    expect(px.get(fresh)).toBe(9);
  });

  test('across id recycling', () => {
    const world = makeWorld();
    const px = world.accessor(Position.x);
    const doomed = world.spawnMany(32, Position);
    world.despawnMany(doomed);
    const reborn = world.spawnMany(32, Position({ x: 4 }));

    for (const entity of reborn) {
      expect(px.get(entity as Entity)).toBe(4);
    }
  });
});

describe('accessors and change detection (§4.5, §8.3)', () => {
  test('set fires onChange exactly like world.set', () => {
    const world = makeWorld();
    const seen: Entity[] = [];
    world.onChange(Position, (e) => seen.push(e));
    const entity = world.spawn(Position);

    world.accessor(Position.x).set(entity, 1);

    expect(seen).toEqual([entity]);
  });

  test('get does not fire onChange', () => {
    const world = makeWorld();
    let calls = 0;
    world.onChange(Position, () => calls++);
    const entity = world.spawn(Position);

    world.accessor(Position.x).get(entity);

    expect(calls).toBe(0);
  });
});

describe('rejected subjects (§4.5)', () => {
  test.runIf(__DEV__)('a struct trait has no single value', () => {
    const world = makeWorld();

    expect(() => world.accessor(Position as never)).toThrow();
  });

  test.runIf(__DEV__)('a tag has none at all', () => {
    const world = makeWorld();

    expect(() => world.accessor(IsActive as never)).toThrow();
  });

  test.runIf(__DEV__)('a non-exclusive relation is addressed through a target', () => {
    const world = makeWorld();

    expect(() => world.accessor(Owns.amount)).toThrow();
  });

  test('an exclusive relation field is a valid subject', () => {
    const Ranked = new Relation({ rank: 0 }, { exclusive: true });
    const world = makeWorld();
    const parent = world.spawn();
    const child = world.spawn(Ranked(parent, { rank: 2 }));
    const rank = world.accessor(Ranked.rank);

    expect(rank.get(child)).toBe(2);

    rank.set(child, 3);

    expect(rank.get(child)).toBe(3);
    expect(world.target(child, ChildOf)).toBe(0);
  });

  test.runIf(__DEV__)('a dead handle is rejected', () => {
    const world = makeWorld();
    const entity = world.spawn(Position);
    const px = world.accessor(Position.x);
    world.despawn(entity);

    expect(() => px.get(entity)).toThrow();
    expect(() => px.set(entity, 1)).toThrow();
  });

  test.runIf(__DEV__)('an entity without the trait is rejected', () => {
    const world = makeWorld();
    const entity = world.spawn(Velocity);

    expect(() => world.accessor(Position.x).get(entity)).toThrow();
  });
});
