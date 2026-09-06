import { afterEach, describe, expect, test, vi } from 'vitest';

import { CAN_CODEGEN, probeCodegen } from '../src/internal';
import * as apecs from '../src/internal';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('capability probe (§6.5)', () => {
  test('the capability is a plain boolean, true where eval is allowed', () => {
    expect(typeof CAN_CODEGEN).toBe('boolean');
    expect(CAN_CODEGEN).toBe(true);
    expect(CAN_CODEGEN).toBe(probeCodegen());
  });

  test('the probe compiles and runs a function through the given constructor', () => {
    const factory = vi.fn(Function) as unknown as FunctionConstructor;

    expect(probeCodegen(factory)).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  test('a CSP that forbids unsafe-eval reports no codegen instead of throwing', () => {
    const blocked = (() => {
      throw new EvalError('Refused to evaluate a string as JavaScript');
    }) as unknown as FunctionConstructor;

    expect(probeCodegen(blocked)).toBe(false);
  });

  test('a constructor that compiles but misbehaves reports no codegen', () => {
    const wrong = (() => () => 'nope') as unknown as FunctionConstructor;

    expect(probeCodegen(wrong)).toBe(false);
  });

  test('detection happens once, at module load', async () => {
    const real = globalThis.Function;
    const spy = vi.fn((...args: string[]) => real(...args));
    spy.prototype = real.prototype;
    vi.stubGlobal('Function', spy);
    vi.resetModules();

    // Imported by path: the point of the test is the module's load-time side effect.
    const module = await import('../src/core/codegen');
    const probes = () => spy.mock.calls.filter((call) => call.length > 0);

    expect(module.CAN_CODEGEN).toBe(true);
    expect(probes()).toHaveLength(1);

    void module.CAN_CODEGEN;
    void module.CAN_CODEGEN;

    expect(probes()).toHaveLength(1);
  });
});

describe('generated sources are distinct (§12.2, rule 2)', () => {
  test('two calls never produce the same marker', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      seen.add(apecs.distinct());
    }

    expect(seen.size).toBe(100);
  });

  test('a marker is a comment, so it costs nothing at runtime', () => {
    expect(apecs.distinct()).toMatch(/^\/\/\d+\n$/);
  });

  test('nothing hands V8 one source twice — the cache would share the feedback', () => {
    const real = globalThis.Function;
    const sources: string[] = [];
    const spy = function (...args: unknown[]) {
      sources.push(String(args.at(-1)));
      return real(...(args as string[]));
    };
    spy.prototype = real.prototype;

    vi.stubGlobal('Function', spy);
    try {
      const A = new apecs.Trait({ value: apecs.f32(0) });
      const B = new apecs.Trait({ value: apecs.f32(0) });
      const world = new apecs.World();
      world.spawn(A, B);
      // Same shape, same layout, same arity: the pair that would collide.
      world.query(A).each(() => {});
      world.query(B).each(() => {});
      world.destroy();
    } finally {
      vi.unstubAllGlobals();
    }

    // Every generated source, not just the ones carrying a marker: a source
    // that repeats is exactly the collision this guards against.
    expect(sources.length).toBeGreaterThanOrEqual(2);
    expect(new Set(sources).size).toBe(sources.length);
  });
});
