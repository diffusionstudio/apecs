import { describe, expect, test } from 'vitest';

import { Changed, Not, Optional, Trait, With, World, f32 } from '../src/index';
import * as apecs from '../src/internal';
import { defineEachCases } from './support/each-cases';

const Position = new Trait({ x: f32(0), y: f32(0) });
const Velocity = new Trait({ x: f32(0), y: f32(0) });
const IsActive = new Trait();

describe('each with generated cursors (§6.1, §6.5)', () => {
  test('this environment can compile accessors, so these cases run the codegen path', () => {
    expect(apecs.CAN_CODEGEN).toBe(true);
  });

  defineEachCases(async () => apecs);
});

describe('argument positions (§6.1)', () => {
  test('a term contributes at most one argument, whatever it wraps', () => {
    const world = new World();
    world.spawn(Position({ x: 1 }), IsActive);

    let arity = -1;
    world.query(Position, With(IsActive), Not(Velocity), Optional(Velocity)).each((...args) => {
      arity = args.length;
    });

    // Position, the Optional slot, then the entity.
    expect(arity).toBe(3);

    world.destroy();
  });

  test('each returns nothing and runs on a hoisted query every frame', () => {
    const world = new World();
    world.spawn(Position);
    const query = world.createQuery(Position);

    let calls = 0;
    for (let frame = 0; frame < 3; frame++) {
      expect(query.each(() => calls++)).toBeUndefined();
    }

    expect(calls).toBe(3);

    world.destroy();
  });
});

describe('stopping a walk early (§6.5)', () => {
  test('returning false stops it, like a break', () => {
    const world = new World({ pageSize: 4 });
    for (let i = 0; i < 9; i++) {
      world.spawn(Position({ x: i }));
    }

    let seen = 0;
    world.query(Position).each(() => {
      seen++;
      if (seen === 3) {
        return false;
      }
    });

    expect(seen).toBe(3);

    world.destroy();
  });

  test('it stops the whole walk, not just the page or the archetype', () => {
    const world = new World({ pageSize: 4 });
    for (let i = 0; i < 6; i++) {
      world.spawn(Position);
      world.spawn(Position, IsActive);
    }

    let seen = 0;
    world.query(Position).each(() => {
      seen++;
      return false;
    });

    expect(seen).toBe(1);

    world.destroy();
  });

  test('only false stops it — an expression body that yields a value does not', () => {
    const world = new World();
    world.spawnMany(5, Position, Velocity);

    let seen = 0;
    world.query(Position, Velocity).each((p, v) => (seen++, (p.x += v.x)));

    expect(seen).toBe(5);

    // Nor do the other falsy values, so `return null` cannot stop a walk by accident.
    let nulls = 0;
    world.query(Position).each(() => {
      nulls++;
      return null;
    });

    expect(nulls).toBe(5);

    world.destroy();
  });

  test('a stopped walk still closes: deferred work drains and cursors are poisoned', () => {
    const world = new World();
    world.spawnMany(4, Position);

    let drained = false;
    let escaped!: { x: number };
    world.query(Position).each((p) => {
      escaped = p;
      world.defer(() => (drained = true));
      return false;
    });

    expect(drained).toBe(true);
    if (__DEV__) {
      expect(() => escaped.x).toThrow();
    }

    world.destroy();
  });

  test('it works under a tick filter too', () => {
    const Tracked = new Trait({ value: f32(0) }, { track: true });
    const world = new World();
    world.spawnMany(4, Tracked);
    const query = world.createQuery(Changed(Tracked));

    let seen = 0;
    query.each(() => {
      seen++;
      return false;
    });

    expect(seen).toBe(1);

    world.destroy();
  });

  test('a sorted walk stops on the same signal', () => {
    const world = new World();
    for (const x of [3, 1, 2]) {
      world.spawn(Position({ x }));
    }

    const seen: number[] = [];
    world
      .query(Position)
      .sortBy(Position.x)
      .each((p) => {
        seen.push(p.x);
        if (seen.length === 2) {
          return false;
        }
      });

    expect(seen).toEqual([1, 2]);

    world.destroy();
  });
});
