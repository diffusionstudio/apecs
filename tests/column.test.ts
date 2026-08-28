import { describe, expect, test, vi } from 'vitest'

import { f32, str } from '../src/index'
import { Column, normalizeSchema } from '../src/internal'

const PAGE = 8

const fieldOf = (schema: Record<string, unknown>) => normalizeSchema(schema).fields[0]
const columnOf = (schema: Record<string, unknown>, pageSize = PAGE) =>
  new Column(fieldOf(schema), pageSize)

/** Appends `n` default-initialised rows, mirroring what an archetype does. */
const fill = (column: Column, n: number) => {
  column.ensure(n)
  for (let row = 0; row < n; row++) column.init(row)
}

describe('paging (§10.2)', () => {
  test('a column starts with no pages and allocates on demand', () => {
    const column = columnOf({ x: f32(0) })

    expect(column.pages).toHaveLength(0)
    column.ensure(1)
    expect(column.pages).toHaveLength(1)
    expect(column.pages[0]).toBeInstanceOf(Float32Array)
    expect(column.pages[0]).toHaveLength(PAGE)
  })

  test('capacity grows a whole page at a time', () => {
    const column = columnOf({ x: f32(0) })

    column.ensure(PAGE)
    expect(column.pages).toHaveLength(1)
    column.ensure(PAGE + 1)
    expect(column.pages).toHaveLength(2)
    column.ensure(PAGE * 3)
    expect(column.pages).toHaveLength(3)
  })

  test('ensure is idempotent below the current capacity', () => {
    const column = columnOf({ x: f32(0) })
    column.ensure(PAGE * 2)
    const pages = [...column.pages]

    column.ensure(1)

    expect(column.pages).toHaveLength(2)
    expect(column.pages[0]).toBe(pages[0])
  })

  test('growth never reallocates an existing page (§10.2)', () => {
    const column = columnOf({ x: f32(0) })
    column.ensure(PAGE * 2)
    const [first, second] = column.pages

    column.ensure(PAGE * 4)

    expect(column.pages[0]).toBe(first)
    expect(column.pages[1]).toBe(second)
    expect(column.pages).toHaveLength(4)
  })

  test('rows map to (page, offset) by shift and mask', () => {
    const column = columnOf({ x: f32(0) })
    fill(column, PAGE * 2)

    column.set(PAGE + 3, 42)

    expect(column.page(PAGE + 3)).toBe(column.pages[1])
    expect((column.pages[1] as Float32Array)[3]).toBe(42)
    expect(column.get(PAGE + 3)).toBe(42)
  })

  test.runIf(__DEV__)('dev rejects a page size that is not a power of two', () => {
    expect(() => columnOf({ x: f32(0) }, 100)).toThrowError(/apecs/)
    expect(() => columnOf({ x: f32(0) }, 0)).toThrowError(/apecs/)
    expect(() => columnOf({ x: f32(0) }, 64)).not.toThrow()
  })
})

describe('typed columns (§10.2)', () => {
  test('init writes the schema default', () => {
    const column = columnOf({ x: f32(1.5) })
    fill(column, 2)

    expect(column.get(0)).toBe(1.5)
    expect(column.get(1)).toBe(1.5)
  })

  test('values round trip through the column type', () => {
    const column = columnOf({ x: f32(0) })
    fill(column, 1)

    column.set(0, 0.5)

    expect(column.get(0)).toBe(0.5)
  })

  test('a boolean column stores 0 and 1', () => {
    const column = columnOf({ on: true })
    fill(column, 2)

    column.set(1, false)

    expect(column.pages[0]).toBeInstanceOf(Uint8Array)
    expect(column.get(0)).toBe(1)
    expect(column.get(1)).toBe(0)
  })
})

describe('boxed columns (§10.2)', () => {
  test('a string column pages into plain arrays and inits to the default', () => {
    const column = columnOf({ s: str('none') })
    fill(column, 1)

    expect(Array.isArray(column.pages[0])).toBe(true)
    expect(column.pages[0]).toHaveLength(PAGE)
    expect(column.get(0)).toBe('none')
  })

  test('an AoS column calls the factory once per row', () => {
    const factory = vi.fn(() => ({ id: 0 }))
    const column = new Column(normalizeSchema(factory).fields[0], PAGE)
    fill(column, 3)

    expect(factory).toHaveBeenCalledTimes(3)
    expect(column.get(0)).not.toBe(column.get(1))
  })

  test('an AoS column accepts an adopted reference', () => {
    const column = new Column(normalizeSchema(() => ({ id: 0 })).fields[0], PAGE)
    const mesh = { id: 7 }
    fill(column, 1)

    column.set(0, mesh)

    expect(column.get(0)).toBe(mesh)
  })
})

describe('swap-remove (§10.2)', () => {
  test('the last row moves into the removed row', () => {
    const column = columnOf({ x: f32(0) })
    fill(column, PAGE + 2)
    column.set(1, 10)
    column.set(PAGE + 1, 99)

    column.swapRemove(1, PAGE + 1)

    expect(column.get(1)).toBe(99)
  })

  test('removing the last row itself is a no-op move', () => {
    const column = columnOf({ x: f32(0) })
    fill(column, 2)
    column.set(1, 7)

    column.swapRemove(1, 1)

    expect(column.pages).toHaveLength(1)
  })

  test('a boxed column releases the vacated tail slot', () => {
    const column = columnOf({ s: str('') })
    fill(column, 3)
    column.set(0, 'a')
    column.set(2, 'c')

    column.swapRemove(0, 2)

    expect(column.get(0)).toBe('c')
    expect(column.get(2)).toBeUndefined()
  })

  test('an AoS column drops its reference to the moved-out row', () => {
    const column = new Column(normalizeSchema(() => ({ id: 0 })).fields[0], PAGE)
    fill(column, 2)
    const survivor = column.get(1)

    column.swapRemove(0, 1)

    expect(column.get(0)).toBe(survivor)
    expect(column.get(1)).toBeUndefined()
  })
})

describe('compaction (§10.2)', () => {
  test('empty tail pages are retained until compacted', () => {
    const column = columnOf({ x: f32(0) })
    column.ensure(PAGE * 3)

    expect(column.pages).toHaveLength(3)
    expect(column.compact(PAGE + 1)).toBe(1)
    expect(column.pages).toHaveLength(2)
  })

  test('compaction keeps the page holding the last live row', () => {
    const column = columnOf({ x: f32(0) })
    column.ensure(PAGE * 4)
    const [first, second] = column.pages

    column.compact(PAGE * 2)

    expect(column.pages).toHaveLength(2)
    expect(column.pages[0]).toBe(first)
    expect(column.pages[1]).toBe(second)
  })

  test('compacting to zero rows releases every page', () => {
    const column = columnOf({ x: f32(0) })
    column.ensure(PAGE * 2)

    expect(column.compact(0)).toBe(2)
    expect(column.pages).toHaveLength(0)
  })

  test('compaction never releases a page still in use', () => {
    const column = columnOf({ x: f32(0) })
    column.ensure(PAGE * 2)

    expect(column.compact(PAGE * 2)).toBe(0)
    expect(column.pages).toHaveLength(2)
  })
})
