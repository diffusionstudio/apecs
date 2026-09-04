/**
 * The `each` suite, shared by the generated cursors (T2.5) and the CSP fallback
 * (T2.7). Both must satisfy it identically — that is what "same semantics,
 * roughly 2–3× slower" means (SPEC §6.5).
 *
 * The module is a parameter because the fallback is chosen once, at module
 * load: the fallback file re-imports apecs with `new Function` blocked.
 */
import { expect, test } from 'vitest';

import type * as Apecs from '../../src/internal';
import type { Entity } from '../../src/internal';

export type ApecsModule = typeof Apecs;
export type Load = () => Promise<ApecsModule>;

/** A page size small enough that a handful of entities spans several pages. */
const PAGE_SIZE = 4;

async function setup(load: Load) {
  const apecs = await load();
  const { Trait, World, f32, str } = apecs;

  const Position = new Trait({ x: f32(0), y: f32(0) });
  const Velocity = new Trait({ x: f32(0), y: f32(0) });
  const Stats = new Trait({ hp: 0, alive: false, name: str('') });
  const Mesh = new Trait(() => ({ id: 0 }));
  const IsActive = new Trait();

  return {
    apecs,
    world: new World({ pageSize: PAGE_SIZE }),
    Position,
    Velocity,
    Stats,
    Mesh,
    IsActive,
  };
}

export function defineEachCases(load: Load): void {
  test('data terms arrive in term order, with the entity last', async () => {
    const { world, Position, Velocity } = await setup(load);
    const e = world.spawn(Position({ x: 1, y: 2 }), Velocity({ x: 3, y: 4 }));

    const seen: unknown[] = [];
    world.query(Position, Velocity).each((p, v, entity) => {
      seen.push([p.x, p.y, v.x, v.y, entity]);
    });

    expect(seen).toEqual([[1, 2, 3, 4, e]]);

    world.destroy();
  });

  test('a callback that ignores the entity still receives its values', async () => {
    const { world, Position, Velocity } = await setup(load);
    world.spawn(Position({ x: 1, y: 1 }), Velocity({ x: 2, y: 3 }));

    world.query(Position, Velocity).each((p, v) => {
      p.x += v.x;
      p.y += v.y;
    });

    expect(world.get(world.queryFirst(Position)!, Position)).toEqual({ x: 3, y: 4 });

    world.destroy();
  });

  test('a query with no data-bearing term passes the entity alone', async () => {
    const { world, IsActive } = await setup(load);
    const e = world.spawn(IsActive);

    const seen: Entity[] = [];
    world.query(IsActive).each((entity) => seen.push(entity));

    expect(seen).toEqual([e]);

    world.destroy();
  });

  test('tags, Not and With contribute no arguments', async () => {
    const { apecs, world, Position, Velocity, Stats, IsActive } = await setup(load);
    const { Not, With } = apecs;
    const e = world.spawn(Position({ x: 8 }), Stats, IsActive);
    world.spawn(Position, Stats, IsActive, Velocity);

    const seen: unknown[] = [];
    world.query(Position, IsActive, With(Stats), Not(Velocity)).each((p, entity) => {
      seen.push([p.x, entity]);
    });

    expect(seen).toEqual([[8, e]]);

    world.destroy();
  });

  test('Optional yields a cursor when the trait is there and null when it is not', async () => {
    const { apecs, world, Position, Velocity } = await setup(load);
    const withVelocity = world.spawn(Position, Velocity({ x: 5 }));
    const without = world.spawn(Position);

    const seen = new Map<Entity, number | null>();
    world.query(Position, apecs.Optional(Velocity)).each((_p, v, entity) => {
      seen.set(entity, v === null ? null : v.x);
    });

    expect(seen.get(withVelocity)).toBe(5);
    expect(seen.get(without)).toBeNull();
    expect(seen.size).toBe(2);

    world.destroy();
  });

  test('an AoS trait yields the reference itself, not a cursor', async () => {
    const { world, Position, Mesh } = await setup(load);
    const mesh = { id: 7 };
    world.spawn(Position, Mesh(mesh));

    const seen: unknown[] = [];
    world.query(Position, Mesh).each((_p, m) => seen.push(m));

    expect(seen).toEqual([mesh]);
    expect(seen[0]).toBe(mesh);

    world.destroy();
  });

  test('one cursor per term is reused across rows, pages and archetypes', async () => {
    const { world, Position, Velocity } = await setup(load);
    world.spawnMany(PAGE_SIZE * 2 + 1, Position);
    world.spawnMany(3, Position, Velocity);

    const cursors = new Set<unknown>();
    let calls = 0;
    world.query(Position).each((p) => {
      cursors.add(p);
      calls++;
    });

    expect(calls).toBe(PAGE_SIZE * 2 + 4);
    expect(cursors.size).toBe(1);

    world.destroy();
  });

  test('writes through a cursor land in the column', async () => {
    const { world, Position, Velocity } = await setup(load);
    const entities: Entity[] = [];
    for (let i = 0; i < 6; i++) {
      entities.push(world.spawn(Position({ x: i }), Velocity({ x: 10 })));
    }

    world.query(Position, Velocity).each((p, v) => {
      p.x += v.x;
      p.y = -1;
    });

    for (let i = 0; i < entities.length; i++) {
      expect(world.get(entities[i], Position)).toEqual({ x: i + 10, y: -1 });
    }

    world.destroy();
  });

  test('every matching entity is visited exactly once, across pages and archetypes', async () => {
    const { world, Position, Velocity, IsActive } = await setup(load);
    const expected = new Set<Entity>();
    for (let i = 0; i < 9; i++) {
      expected.add(world.spawn(Position({ x: i })));
    }
    for (let i = 0; i < 5; i++) {
      expected.add(world.spawn(Position, Velocity));
    }
    for (let i = 0; i < 2; i++) {
      expected.add(world.spawn(Position, IsActive));
    }
    world.spawn(Velocity);

    const seen: Entity[] = [];
    world.query(Position).each((_p, entity) => seen.push(entity));

    expect(seen).toHaveLength(expected.size);
    expect(new Set(seen)).toEqual(expected);

    world.destroy();
  });

  test('an empty result never calls back', async () => {
    const { world, Position, Velocity } = await setup(load);
    world.spawn(Position);
    let calls = 0;

    world.query(Position, Velocity).each(() => calls++);
    world.query(Velocity).each(() => calls++);

    expect(calls).toBe(0);

    world.destroy();
  });

  test('a cursor decodes booleans and passes boxed fields through', async () => {
    const { world, Stats } = await setup(load);
    const e = world.spawn(Stats({ hp: 3, alive: true, name: 'hero' }));

    world.query(Stats).each((s) => {
      expect(s.hp).toBe(3);
      expect(s.alive).toBe(true);
      expect(s.name).toBe('hero');
      s.hp += 1;
      s.alive = false;
      s.name = 'ghost';
    });

    expect(world.get(e, Stats)).toEqual({ hp: 4, alive: false, name: 'ghost' });

    world.destroy();
  });

  test('the cursor tracks the row it is on across a page boundary', async () => {
    const { world, Position } = await setup(load);
    const entities: Entity[] = [];
    for (let i = 0; i < PAGE_SIZE * 2 + 1; i++) {
      entities.push(world.spawn(Position({ x: i, y: i * 2 })));
    }

    const seen = new Map<Entity, number>();
    world.query(Position).each((p, entity) => {
      expect(p.y).toBe(p.x * 2);
      seen.set(entity, p.x);
    });

    for (let i = 0; i < entities.length; i++) {
      expect(seen.get(entities[i])).toBe(i);
    }

    world.destroy();
  });

  test.runIf(__DEV__)('a cursor retained past the callback is poisoned', async () => {
    const { world, Position } = await setup(load);
    world.spawn(Position({ x: 1 }));

    let retained!: { x: number };
    world.query(Position).each((p) => {
      retained = p;
    });

    expect(() => retained.x).toThrowError(/apecs/);
    expect(() => {
      retained.x = 2;
    }).toThrowError(/apecs/);

    world.destroy();
  });

  test.skipIf(__DEV__)('a retained cursor reads its last bound row in production', async () => {
    const { world, Position } = await setup(load);
    world.spawn(Position({ x: 1 }));
    world.spawn(Position({ x: 2 }));

    let retained!: { x: number };
    const order: Entity[] = [];
    world.query(Position).each((p, entity) => {
      retained = p;
      order.push(entity);
    });

    expect(retained.x).toBe(world.get(order[order.length - 1], Position.x));

    world.destroy();
  });
}
