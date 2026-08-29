import { assert } from './debug'
import type { Field } from './schema'

/** Default column page size — a power of two (SPEC §12.3). */
export const PAGE_SIZE = 4096

export type ColumnPage =
  | Int8Array
  | Int16Array
  | Int32Array
  | Uint8Array
  | Uint16Array
  | Uint32Array
  | Float32Array
  | Float64Array
  | unknown[]

/**
 * One column of one archetype, paged so that growth appends and never
 * reallocates an existing page — views handed to user code stay valid across a
 * mid-frame spawn (SPEC §10.2).
 */
export class Column {
  readonly field: Field
  readonly pageSize: number
  readonly pages: ColumnPage[] = []

  private readonly shift: number
  private readonly mask: number
  private readonly boxed: boolean

  public constructor(field: Field, pageSize: number) {
    if (__DEV__) {
      assert(
        pageSize > 0 && (pageSize & (pageSize - 1)) === 0,
        `page size ${pageSize} must be a power of two`,
      )
    }
    this.field = field
    this.pageSize = pageSize
    this.shift = 31 - Math.clz32(pageSize)
    this.mask = pageSize - 1
    this.boxed = field.array === null
  }

  /** Allocates whole pages until `rows` fit. Idempotent below the current capacity. */
  public ensure(rows: number): void {
    const { pages, pageSize } = this
    const ctor = this.field.array
    const needed = Math.ceil(rows / pageSize)
    while (pages.length < needed)
      pages.push(ctor === null ? new Array(pageSize) : new ctor(pageSize))
  }

  /** Writes the schema default into a freshly appended row; AoS calls the factory. */
  public init(row: number): void {
    const { factory } = this.field
    this.set(row, factory === null ? this.field.default : factory())
  }

  public get(row: number): unknown {
    return (this.pages[row >>> this.shift] as unknown[])[row & this.mask]
  }

  public set(row: number, value: unknown): void {
    ;(this.pages[row >>> this.shift] as unknown[])[row & this.mask] = value
  }

  public page(row: number): ColumnPage {
    return this.pages[row >>> this.shift]
  }

  /** Moves `last` into `row` and releases the vacated tail slot. */
  public swapRemove(row: number, last: number): void {
    if (row !== last) this.set(row, this.get(last))
    if (this.boxed) (this.pages[last >>> this.shift] as unknown[])[last & this.mask] = undefined
  }

  /** Releases the tail pages that `rows` live rows no longer reach. */
  public compact(rows: number): number {
    const needed = Math.ceil(rows / this.pageSize)
    const released = this.pages.length - needed
    if (released <= 0) return 0
    this.pages.length = needed
    return released
  }
}
