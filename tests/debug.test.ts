import { afterEach, describe, expect, test, vi } from 'vitest'

import { ApecsError, assert, resetWarnOnce, warn, warnOnce } from '../src/internal'

afterEach(() => {
  vi.restoreAllMocks()
  resetWarnOnce()
})

describe('assertions (§12.2)', () => {
  test('a satisfied assertion is silent in every build', () => {
    expect(() => assert(true, 'unreachable')).not.toThrow()
    expect(() => assert(1, 'unreachable')).not.toThrow()
  })

  test.runIf(__DEV__)('dev throws a labelled ApecsError', () => {
    let error: unknown

    try {
      assert(false, 'row out of range')
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(ApecsError)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('apecs: row out of range')
  })

  test.runIf(__DEV__)('dev treats every falsy value as a failure', () => {
    expect(() => assert(0, 'zero')).toThrowError(/apecs/)
    expect(() => assert('', 'empty')).toThrowError(/apecs/)
    expect(() => assert(undefined, 'undefined')).toThrowError(/apecs/)
    expect(() => assert(null, 'null')).toThrowError(/apecs/)
  })

  test.runIf(!__DEV__)('prod compiles the assertion out', () => {
    expect(() => assert(false, 'row out of range')).not.toThrow()
  })
})

describe('warnings (§3.2, §6.6)', () => {
  test.runIf(__DEV__)('dev warns through console, labelled', () => {
    const console_ = vi.spyOn(console, 'warn').mockImplementation(() => {})

    warn('boxed field')

    expect(console_).toHaveBeenCalledTimes(1)
    expect(console_).toHaveBeenCalledWith('apecs: boxed field')
  })

  test.runIf(__DEV__)('warnOnce dedupes by key', () => {
    const console_ = vi.spyOn(console, 'warn').mockImplementation(() => {})

    warnOnce('site:1', 'missing markChanged')
    warnOnce('site:1', 'missing markChanged')
    warnOnce('site:2', 'missing markChanged')

    expect(console_).toHaveBeenCalledTimes(2)
  })

  test.runIf(__DEV__)('resetWarnOnce clears the dedupe set', () => {
    const console_ = vi.spyOn(console, 'warn').mockImplementation(() => {})

    warnOnce('site:1', 'missing markChanged')
    resetWarnOnce()
    warnOnce('site:1', 'missing markChanged')

    expect(console_).toHaveBeenCalledTimes(2)
  })

  test.runIf(!__DEV__)('prod compiles the warnings out', () => {
    const console_ = vi.spyOn(console, 'warn').mockImplementation(() => {})

    warn('boxed field')
    warnOnce('site:1', 'missing markChanged')

    expect(console_).not.toHaveBeenCalled()
  })
})
