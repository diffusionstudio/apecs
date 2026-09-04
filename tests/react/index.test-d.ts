import { expectTypeOf, test } from 'vitest';

import { Relation, Trait, f32, str, type Accessor, type Entity } from '../../src/index';
import {
  useAccessor,
  useChildren,
  useEntity,
  useField,
  useHas,
  useParent,
  useQuery,
  useQueryFirst,
  useSortedQuery,
  useSortedQueryFirst,
  useTag,
  useTarget,
  useTrait,
} from '../../src/react/index';

const Position = new Trait({ x: f32(0), y: f32(0) });
const Name = new Trait({ value: str('') });
const IsActive = new Trait();
const ChildOf = new Relation(undefined, { exclusive: true });

declare const e: Entity;

test('reads are the core value types, undefined where the entity may lack them (§C.5.2)', () => {
  expectTypeOf(useField(e, Position.x)).toEqualTypeOf<number | undefined>();
  expectTypeOf(useField(Name.value)).toEqualTypeOf<string | undefined>();
  expectTypeOf(useTrait(e, Position)).toEqualTypeOf<{ x: number; y: number } | undefined>();
  expectTypeOf(useTrait(Position)).toEqualTypeOf<{ x: number; y: number } | undefined>();
  expectTypeOf(useHas(e, Position)).toEqualTypeOf<boolean>();
  expectTypeOf(useTag(IsActive)).toEqualTypeOf<boolean>();
  expectTypeOf(useQuery(Position, IsActive)).toEqualTypeOf<readonly Entity[]>();
  expectTypeOf(useQueryFirst(Position)).toEqualTypeOf<Entity | undefined>();
  expectTypeOf(useSortedQuery([Position], Position.x, 'desc')).toEqualTypeOf<readonly Entity[]>();
  expectTypeOf(useSortedQueryFirst([Position], Position.x)).toEqualTypeOf<Entity | undefined>();
  expectTypeOf(useTarget(e, ChildOf)).toEqualTypeOf<Entity | undefined>();
  expectTypeOf(useParent(e, ChildOf)).toEqualTypeOf<Entity | undefined>();
  expectTypeOf(useChildren(e, ChildOf)).toEqualTypeOf<readonly Entity[]>();
});

test('writes and lifecycle are plain values (§C.5.3)', () => {
  expectTypeOf(useAccessor(Position.x)).toEqualTypeOf<Accessor<number>>();
  expectTypeOf(useEntity(Position, IsActive)).toEqualTypeOf<Entity | undefined>();
});
