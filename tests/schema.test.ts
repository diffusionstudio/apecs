import { afterEach, describe, expect, test, vi } from 'vitest'

import { bool, eid, f32, f64, i8, i16, i32, str, u8, u16, u32 } from '../src/index'
import { isMarker, normalizeSchema } from '../src/internal'

afterEach(() => {
  vi.restoreAllMocks()
})

const keysOf = (schema: Record<string, unknown>) => normalizeSchema(schema).fields.map((f) => f.key)

describe('markers (§3.2)', () => {
  test('a marker is a branded carrier, not the bare value', () => {
    expect(isMarker(f32(1))).toBe(true)
    expect(isMarker(1)).toBe(false)
    expect(isMarker({ x: 1 })).toBe(false)
    expect(isMarker(null)).toBe(false)
  })

  test('every marker selects its column type and keeps its default', () => {
    const { fields } = normalizeSchema({
      a: i8(1),
      b: i16(2),
      c: i32(3),
      d: u8(4),
      e: u16(5),
      g: u32(6),
      h: f32(7),
      i: f64(8),
      j: bool(true),
      k: str('hi'),
      l: eid(0),
    })

    expect(fields.map((f) => f.kind)).toEqual([
      'i8',
      'i16',
      'i32',
      'u8',
      'u16',
      'u32',
      'f32',
      'f64',
      'bool',
      'str',
      'eid',
    ])
    expect(fields.map((f) => f.array)).toEqual([
      Int8Array,
      Int16Array,
      Int32Array,
      Uint8Array,
      Uint16Array,
      Uint32Array,
      Float32Array,
      Float64Array,
      Uint8Array,
      null,
      Float64Array,
    ])
    expect(fields.map((f) => f.default)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, true, 'hi', 0])
  })
})

describe('bare-value inference (§3.2)', () => {
  test('numbers default to Float64Array, booleans to Uint8Array, strings box', () => {
    const { fields } = normalizeSchema({ n: 3, b: false, s: '' })

    expect(fields.map((f) => f.kind)).toEqual(['f64', 'bool', 'str'])
    expect(fields.map((f) => f.array)).toEqual([Float64Array, Uint8Array, null])
    expect(fields.map((f) => f.default)).toEqual([3, false, ''])
  })

  test('a marker overrides the inferred type', () => {
    expect(normalizeSchema({ n: 0 }).fields[0].array).toBe(Float64Array)
    expect(normalizeSchema({ n: f32(0) }).fields[0].array).toBe(Float32Array)
  })
})

describe('nested objects (§3.2)', () => {
  test('plain objects flatten to dotted column keys', () => {
    const { fields } = normalizeSchema({ pos: { x: 0, y: f32(0) }, hp: 100 })

    expect(fields.map((f) => f.key)).toEqual(['pos.x', 'pos.y', 'hp'])
    expect(fields.map((f) => f.path)).toEqual([['pos', 'x'], ['pos', 'y'], ['hp']])
    expect(fields.map((f) => f.array)).toEqual([Float64Array, Float32Array, Float64Array])
  })

  test('nesting is arbitrarily deep', () => {
    expect(keysOf({ a: { b: { c: { d: 0 } } } })).toEqual(['a.b.c.d'])
  })

  test('a nested object expands in place, keeping declaration order', () => {
    expect(keysOf({ first: 0, mid: { a: 0, b: 0 }, last: 0 })).toEqual([
      'first',
      'mid.a',
      'mid.b',
      'last',
    ])
  })

  test('column order is the declaration order, not sorted', () => {
    expect(keysOf({ z: 0, a: 0, m: 0 })).toEqual(['z', 'a', 'm'])
  })

  test('an empty nested object contributes no column', () => {
    expect(keysOf({ a: 0, empty: {}, b: 0 })).toEqual(['a', 'b'])
  })
})

describe('boxed values (§3.2)', () => {
  test('anything else becomes a boxed column', () => {
    const value = new Map<string, number>()
    const { fields } = normalizeSchema({ m: value, arr: [1, 2], nil: null })

    expect(fields.map((f) => f.kind)).toEqual(['boxed', 'boxed', 'boxed'])
    expect(fields.map((f) => f.array)).toEqual([null, null, null])
    expect(fields[0].default).toBe(value)
  })

  test.runIf(__DEV__)('dev warns per boxed field and suggests an AoS trait', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    normalizeSchema({ m: new Map(), arr: [] })

    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls[0][0]).toMatch(/apecs/)
    expect(warn.mock.calls[0][0]).toMatch(/AoS/)
  })

  test.runIf(__DEV__)('strings box without a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    normalizeSchema({ s: '', t: str('x') })

    expect(warn).not.toHaveBeenCalled()
  })

  test.runIf(!__DEV__)('the warning is compiled out in prod', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    normalizeSchema({ m: new Map() })

    expect(warn).not.toHaveBeenCalled()
  })
})

describe('schema kinds (§3.1)', () => {
  test('no schema is a tag: no fields, no columns', () => {
    const schema = normalizeSchema(undefined)

    expect(schema.kind).toBe('tag')
    expect(schema.fields).toHaveLength(0)
  })

  test('an empty record is still a struct', () => {
    expect(normalizeSchema({}).kind).toBe('struct')
    expect(normalizeSchema({ x: 0 }).kind).toBe('struct')
  })

  test('a factory is an AoS schema with exactly one unnamed boxed column', () => {
    const factory = () => ({ mesh: true })
    const schema = normalizeSchema(factory)

    expect(schema.kind).toBe('aos')
    expect(schema.fields).toHaveLength(1)
    expect(schema.fields[0]).toMatchObject({
      key: '',
      path: [],
      kind: 'aos',
      array: null,
      factory,
    })
  })

  test('struct fields carry no factory', () => {
    expect(normalizeSchema({ x: 0 }).fields[0].factory).toBe(null)
  })
})
