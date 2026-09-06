import { beforeAll, describe, expect, test, vi } from 'vitest';

import { defineEachCases, type ApecsModule } from './support/each-cases';

/**
 * Re-imports apecs with `new Function` refused, the way a strict CSP without
 * `unsafe-eval` refuses it, and runs the whole `each` suite against the generic
 * fallback cursor (SPEC §6.5).
 */
let fallback: ApecsModule;

beforeAll(async () => {
  const real = globalThis.Function;
  const blocked = function (...args: unknown[]) {
    if (args.length > 0) {
      throw new EvalError('Refused to evaluate a string as JavaScript');
    }
    return real();
  };
  blocked.prototype = real.prototype;

  vi.resetModules();
  vi.stubGlobal('Function', blocked);
  try {
    fallback = await import('../src/internal');
  } finally {
    vi.unstubAllGlobals();
  }
});

describe('the fallback cursor (§6.5)', () => {
  test('the re-imported module detected the missing capability at load', () => {
    expect(fallback.CAN_CODEGEN).toBe(false);
  });

  test('accessor classes stay per trait, so call sites stay monomorphic (§12.2)', () => {
    const { Trait, f32 } = fallback;
    const Position = new Trait({ x: f32(0), y: f32(0) });
    const Velocity = new Trait({ x: f32(0), y: f32(0) });
    const cursor = fallback.cursorClassFor(Position, false);

    expect(cursor).not.toBeNull();
    expect(fallback.cursorClassFor(Position, false)).toBe(cursor);
    expect(fallback.cursorClassFor(Velocity, false)).not.toBe(cursor);
  });

  test('a callback can stop the reflective walk too (§6.5)', () => {
    const { Trait, World, f32 } = fallback;
    const Position = new Trait({ x: f32(0), y: f32(0) });

    const world = new World({ pageSize: 4 });
    for (let i = 0; i < 9; i++) {
      world.spawn(Position({ x: i }));
    }

    let seen = 0;
    world.query(Position).each(() => {
      seen++;
      return false;
    });

    expect(seen).toBe(1);

    world.destroy();
  });

  defineEachCases(async () => fallback);
});
