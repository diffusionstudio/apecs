import { expectTypeOf, test } from 'vitest';

import { Relation, Trait, f32, str, type Accessor, type Entity } from '../../src/index';
import {
  createAccessor,
  createChildren,
  createEntity,
  createField,
  createHas,
  createParent,
  createQuery,
  createQueryFirst,
  createSortedQuery,
  createSortedQueryFirst,
  createTag,
  createTarget,
  createTrait,
} from '../../src/solid/index';

const Position = new Trait({ x: f32(0), y: f32(0) });
const Name = new Trait({ value: str('') });
const IsActive = new Trait();
const ChildOf = new Relation(undefined, { exclusive: true });

declare const e: Entity;

test('reads are getters over the core value types (§C.6)', () => {
  expectTypeOf(createField(e, Position.x)).toEqualTypeOf<() => number | undefined>();
  expectTypeOf(createField(Name.value)).toEqualTypeOf<() => string | undefined>();
  expectTypeOf(createTrait(e, Position)).toEqualTypeOf<
    () => { x: number; y: number } | undefined
  >();
  expectTypeOf(createTrait(Position)).toEqualTypeOf<() => { x: number; y: number } | undefined>();
  expectTypeOf(createHas(e, Position)).toEqualTypeOf<() => boolean>();
  expectTypeOf(createTag(IsActive)).toEqualTypeOf<() => boolean>();
  expectTypeOf(createQuery(Position, IsActive)).toEqualTypeOf<() => readonly Entity[]>();
  expectTypeOf(createQueryFirst(Position)).toEqualTypeOf<() => Entity | undefined>();
  expectTypeOf(createSortedQuery([Position], Position.x, 'desc')).toEqualTypeOf<
    () => readonly Entity[]
  >();
  expectTypeOf(createSortedQueryFirst([Position], Position.x)).toEqualTypeOf<
    () => Entity | undefined
  >();
  expectTypeOf(createTarget(e, ChildOf)).toEqualTypeOf<() => Entity | undefined>();
  expectTypeOf(createParent(e, ChildOf)).toEqualTypeOf<() => Entity | undefined>();
  expectTypeOf(createChildren(e, ChildOf)).toEqualTypeOf<() => readonly Entity[]>();
});

test('writes and lifecycle are plain values (§C.5.3)', () => {
  expectTypeOf(createAccessor(Position.x)).toEqualTypeOf<Accessor<number>>();
  expectTypeOf(createEntity(Position, IsActive)).toEqualTypeOf<Entity>();
});
