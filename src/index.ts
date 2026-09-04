/**
 * apecs — public entry point.
 *
 * The API surface this module will export is specified in SPEC.md §14.
 */

export const VERSION = '0.1.0';

export { Trait } from './core/trait';
export type { TraitConstructor, TraitInstance, TraitOptions } from './core/trait';

export { Relation } from './core/relation';
export type { Pair, RelationConstructor, RelationOptions } from './core/relation';

export { bool, eid, f32, f64, i8, i16, i32, str, u8, u16, u32 } from './core/schema';
export type { Field, Schema } from './core/schema';

export type {
  ArrayFor,
  Cursor,
  EachFn,
  Init,
  Marked,
  Store,
  Unmark,
  Value,
  Values,
} from './core/types';
export type { TraitLike } from './core/value';

export { Added, Cascade, Changed, Not, Optional, Or, Removed, With } from './core/terms';
export type { Modifier, Term, TermKind } from './core/terms';

export type { Entity } from './core/entity';

export { World } from './core/world';
export type {
  EntityBatch,
  ObserverFn,
  QueryEvent,
  Subject,
  TraitEvent,
  WorldEvent,
  WorldOptions,
} from './core/world';
export type { Accessor } from './core/accessor';

export type { QueryResult } from './core/query';
export type { Comparator, DirtyLevel, SortedQueryResult } from './core/sorted';
export type { IndexedQueryResult } from './core/materialized';
export type { Chunk } from './core/chunk';
