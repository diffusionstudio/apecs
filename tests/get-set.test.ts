import { describe, expect, test } from 'vitest';

import { Trait, World, eid, f32, str } from '../src/index';

const Position = new Trait({ x: f32(0), y: f32(0) });
const Transform = new Trait({ pos: { x: 0, y: 0 }, scale: 1 });
const Flags = new Trait({ on: false, label: str('none') });
const Link = new Trait({ to: eid(0) });
const Mesh = new Trait(() => ({ n: 0 }));
const IsActive = new Trait();

describe('get copy semantics (§4.4)', () => {
  test('get on a struct trait returns a fresh, detached copy', () => {
    const world = new World();
    const e = world.spawn(Position({ x: 1, y: 2 }));

    const copy = world.get(e, Position);

    expect(copy).toEqual({ x: 1, y: 2 });
    expect(world.get(e, Position)).not.toBe(copy);

    copy.x = 99;

    expect(world.get(e, Position.x)).toBe(1);

    world.destroy();
  });

  test('get rebuilds the declared nested shape', () => {
    const world = new World();
    const e = world.spawn(Transform({ pos: { x: 3 }, scale: 2 }));

    expect(world.get(e, Transform)).toEqual({ pos: { x: 3, y: 0 }, scale: 2 });

    world.destroy();
  });

  test('get on an AoS trait hands back the reference itself', () => {
    const world = new World();
    const mesh = { n: 7 };
    const e = world.spawn(Mesh(mesh));

    expect(world.get(e, Mesh)).toBe(mesh);

    world.destroy();
  });
});

describe('get with a field (§3.3)', () => {
  test('a field reads exactly one column', () => {
    const world = new World();
    const e = world.spawn(Transform({ pos: { x: 3, y: 4 }, scale: 2 }));

    expect(world.get(e, Transform['pos.x'])).toBe(3);
    expect(world.get(e, Transform['pos.y'])).toBe(4);
    expect(world.get(e, Transform.scale)).toBe(2);

    world.destroy();
  });

  test('a boolean column reads back as a boolean, not as 0 or 1', () => {
    const world = new World();
    const e = world.spawn(Flags({ on: true }));
    const f = world.spawn(Flags);

    expect(world.get(e, Flags.on)).toBe(true);
    expect(world.get(f, Flags.on)).toBe(false);
    expect(world.get(e, Flags)).toEqual({ on: true, label: 'none' });

    world.destroy();
  });

  test('an eid column reads back as the handle that was written', () => {
    const world = new World();
    const target = world.spawn();
    const e = world.spawn(Link({ to: target }));
    const unset = world.spawn(Link);

    expect(world.get(e, Link.to)).toBe(target);
    expect(world.get(e, Link)).toEqual({ to: target });
    expect(world.get(unset, Link.to)).toBe(0);

    world.destroy();
  });
});

describe('get with an out parameter (§4.4)', () => {
  test('get writes into the caller object and returns it', () => {
    const world = new World();
    const e = world.spawn(Position({ x: 1, y: 2 }));
    const out = { x: 0, y: 0 };

    expect(world.get(e, Position, out)).toBe(out);
    expect(out).toEqual({ x: 1, y: 2 });

    world.destroy();
  });

  test('out is reusable across entities and reuses nested objects', () => {
    const world = new World();
    const a = world.spawn(Transform({ pos: { x: 1 }, scale: 2 }));
    const b = world.spawn(Transform({ pos: { x: 3 }, scale: 4 }));
    const out = { pos: { x: 0, y: 0 }, scale: 0 };
    const nested = out.pos;

    world.get(a, Transform, out);
    expect(out).toEqual({ pos: { x: 1, y: 0 }, scale: 2 });

    world.get(b, Transform, out);

    expect(out.pos).toBe(nested);
    expect(out).toEqual({ pos: { x: 3, y: 0 }, scale: 4 });

    world.destroy();
  });
});

describe('set (§4.4)', () => {
  test('set writes only the fields the value carries', () => {
    const world = new World();
    const e = world.spawn(Position({ x: 1, y: 2 }));

    world.set(e, Position, { x: 5 });

    expect(world.get(e, Position)).toEqual({ x: 5, y: 2 });

    world.destroy();
  });

  test('a nested partial leaves its siblings alone', () => {
    const world = new World();
    const e = world.spawn(Transform({ pos: { x: 1, y: 2 }, scale: 3 }));

    world.set(e, Transform, { pos: { y: 9 } });

    expect(world.get(e, Transform)).toEqual({ pos: { x: 1, y: 9 }, scale: 3 });

    world.destroy();
  });

  test('set with a field writes one column', () => {
    const world = new World();
    const e = world.spawn(Transform);

    world.set(e, Transform['pos.y'], 4);

    expect(world.get(e, Transform)).toEqual({ pos: { x: 0, y: 4 }, scale: 1 });

    world.destroy();
  });

  test('set replaces an AoS reference outright', () => {
    const world = new World();
    const e = world.spawn(Mesh);
    const replacement = { n: 7 };

    world.set(e, Mesh, replacement);

    expect(world.get(e, Mesh)).toBe(replacement);

    world.destroy();
  });

  test('a boolean field stores true and false', () => {
    const world = new World();
    const e = world.spawn(Flags);

    world.set(e, Flags.on, true);
    expect(world.get(e, Flags.on)).toBe(true);

    world.set(e, Flags, { on: false, label: 'off' });
    expect(world.get(e, Flags)).toEqual({ on: false, label: 'off' });

    world.destroy();
  });

  test('a value round trips through the declared column precision', () => {
    const world = new World();
    const e = world.spawn(Position, Transform);

    world.set(e, Position.x, 0.1);
    world.set(e, Transform.scale, 0.1);

    expect(world.get(e, Position.x)).toBe(Math.fround(0.1));
    expect(world.get(e, Transform.scale)).toBe(0.1);

    world.destroy();
  });

  test('writes stay inside their own row', () => {
    const world = new World({ pageSize: 4 });
    const a = world.spawn(Position({ x: 1, y: 1 }));
    const b = world.spawn(Position({ x: 2, y: 2 }));

    world.set(a, Position, { x: 9, y: 9 });

    expect(world.get(b, Position)).toEqual({ x: 2, y: 2 });

    world.destroy();
  });
});

describe('dev guards (§12.2)', () => {
  test.runIf(__DEV__)('reading or writing an absent trait throws', () => {
    const world = new World();
    const e = world.spawn(Position);

    expect(() => world.get(e, Transform)).toThrowError(/apecs/);
    expect(() => world.get(e, Transform.scale)).toThrowError(/apecs/);
    expect(() => world.set(e, Transform.scale, 1)).toThrowError(/apecs/);

    world.destroy();
  });

  test.runIf(__DEV__)('a key the schema does not declare throws', () => {
    const world = new World();
    const e = world.spawn(Position);

    expect(() => world.set(e, Position, { z: 1 } as never)).toThrowError(/apecs/);

    world.destroy();
  });

  test.runIf(__DEV__)('a tag carries no value to get or set', () => {
    const world = new World();
    const e = world.spawn(IsActive);

    expect(() => world.get(e, IsActive)).toThrowError(/apecs/);
    expect(() => world.set(e, IsActive, {} as never)).toThrowError(/apecs/);

    world.destroy();
  });
});
