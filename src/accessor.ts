import type { Archetype } from './archetype'
import type { Column } from './column'
import { assert } from './debug'
import { entityId, type Entity } from './entity'
import type { EntityIndex } from './entity-index'
import { isRelation } from './relation'
import type { Field } from './schema'
import { $fields, $id, $index, $kind, $options, $trait } from './symbols'
import type { Ticks } from './ticks'
import type { Trait } from './trait'

/** A field resolved once; reads and writes by handle afterwards (SPEC §4.5). */
export interface Accessor<V> {
  get(entity: Entity): V
  set(entity: Entity, value: V): void
}

/** The slice of a world an accessor touches, handed over once at creation. */
export interface AccessorHost {
  readonly entities: EntityIndex
  readonly archetypes: readonly Archetype[]
  readonly ticks: Ticks
  /** `onChange` subscriptions; a write consults only the size before calling `wrote`. */
  readonly changed: { readonly size: number }
  wrote(entity: Entity, id: number, trait: Trait): void
  /** Dev only. */
  assertAlive(entity: Entity, id: number): void
}

/** The one column an AoS trait owns; anything else has to be named by field. */
export function accessorField(subject: Field | Trait): Field {
  if (typeof subject !== 'function') return subject
  if (__DEV__) {
    assert(subject[$kind] !== 'tag', 'a tag carries no value to get or set')
    assert(subject[$kind] === 'aos', 'a struct trait has no single value — pass one of its fields')
  }
  return subject[$fields][0]
}

export function createAccessor(host: AccessorHost, field: Field): Accessor<unknown> {
  const trait = field[$trait]
  if (__DEV__) {
    assert(
      !isRelation(trait) || trait[$options].exclusive,
      'a non-exclusive relation is read and written through a target: world.get(e, Likes(target))',
    )
  }
  return new TableAccessor(host, field)
}

/**
 * Archetype id → the column holding the field there, filled on first sight.
 * Re-reading the entity's archetype on every call is what keeps a moved row
 * correct; the table itself never goes stale because an archetype's column
 * set is fixed at creation and `Column.pages` is only ever appended to or
 * truncated in place (SPEC §10.1, §10.2).
 */
class TableAccessor implements Accessor<unknown> {
  private readonly table: (Column | undefined)[] = []
  private readonly entities: EntityIndex
  private readonly archetypes: readonly Archetype[]
  private readonly ticks: Ticks
  private readonly host: AccessorHost
  private readonly trait: Trait
  private readonly slot: number
  private readonly bool: boolean

  public constructor(host: AccessorHost, field: Field) {
    this.entities = host.entities
    this.archetypes = host.archetypes
    this.ticks = host.ticks
    this.host = host
    this.trait = field[$trait]
    this.slot = field[$index]
    this.bool = field.kind === 'bool'
  }

  public get(entity: Entity): unknown {
    const id = entityId(entity)
    if (__DEV__) this.host.assertAlive(entity, id)
    const entities = this.entities
    const at = entities.archetypes[id]
    let column = this.table[at]
    if (column === undefined) column = this.resolve(at)
    const row = entities.rows[id]
    const raw = (column.pages[row >>> column.shift] as unknown[])[row & column.mask]
    return this.bool ? raw !== 0 : raw
  }

  public set(entity: Entity, value: unknown): void {
    const id = entityId(entity)
    if (__DEV__) this.host.assertAlive(entity, id)
    const entities = this.entities
    const at = entities.archetypes[id]
    let column = this.table[at]
    if (column === undefined) column = this.resolve(at)
    const row = entities.rows[id]
    ;(column.pages[row >>> column.shift] as unknown[])[row & column.mask] = value
    column.stamp(row, this.ticks.tick)
    const host = this.host
    if (host.changed.size !== 0) host.wrote(entity, id, this.trait)
  }

  private resolve(at: number): Column {
    const columns = this.archetypes[at].columnsOf.get(this.trait[$id])
    if (__DEV__) assert(columns !== undefined, 'this entity does not have that trait')
    return (this.table[at] = columns![this.slot])
  }
}
