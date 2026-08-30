/**
 * apecs — public entry point.
 *
 * The API surface this module will export is specified in SPEC.md §14.
 */

export const VERSION = '0.1.0'

export { Trait } from './trait'
export type { TraitConstructor, TraitInstance, TraitOptions } from './trait'

export { Relation } from './relation'
export type { RelationConstructor, RelationOptions } from './relation'

export { bool, eid, f32, f64, i8, i16, i32, str, u8, u16, u32 } from './schema'
export type { Field, Schema } from './schema'

export { Added, Cascade, Changed, Not, Optional, Or, Removed, With } from './terms'
export type { Modifier, Term, TermKind } from './terms'

export type { Entity } from './entity'

export { World } from './world'
export type { EntityBatch, WorldOptions } from './world'

export type { QueryResult } from './query'
export type { Chunk } from './chunk'
