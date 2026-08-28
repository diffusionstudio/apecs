import { afterEach, describe, expect, test, vi } from 'vitest'

import { CAN_CODEGEN, probeCodegen } from '../src/internal'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('capability probe (§6.5)', () => {
  test('the capability is a plain boolean, true where eval is allowed', () => {
    expect(typeof CAN_CODEGEN).toBe('boolean')
    expect(CAN_CODEGEN).toBe(true)
    expect(CAN_CODEGEN).toBe(probeCodegen())
  })

  test('the probe compiles and runs a function through the given constructor', () => {
    const factory = vi.fn(Function) as unknown as FunctionConstructor

    expect(probeCodegen(factory)).toBe(true)
    expect(factory).toHaveBeenCalledTimes(1)
  })

  test('a CSP that forbids unsafe-eval reports no codegen instead of throwing', () => {
    const blocked = (() => {
      throw new EvalError('Refused to evaluate a string as JavaScript')
    }) as unknown as FunctionConstructor

    expect(probeCodegen(blocked)).toBe(false)
  })

  test('a constructor that compiles but misbehaves reports no codegen', () => {
    const wrong = (() => () => 'nope') as unknown as FunctionConstructor

    expect(probeCodegen(wrong)).toBe(false)
  })

  test('detection happens once, at module load', async () => {
    const real = globalThis.Function
    const spy = vi.fn((...args: string[]) => real(...args))
    spy.prototype = real.prototype
    vi.stubGlobal('Function', spy)
    vi.resetModules()

    // Imported by path: the point of the test is the module's load-time side effect.
    const module = await import('../src/codegen')
    const probes = () => spy.mock.calls.filter((call) => call.length > 0)

    expect(module.CAN_CODEGEN).toBe(true)
    expect(probes()).toHaveLength(1)

    void module.CAN_CODEGEN
    void module.CAN_CODEGEN

    expect(probes()).toHaveLength(1)
  })
})
