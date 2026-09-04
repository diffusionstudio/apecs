/**
 * T8.4 — `Accessor<V>` is typed from the field it resolves (SPEC §4.5, §11).
 */
import { describe, expectTypeOf, test } from 'vitest';

import { Relation, Trait, World, bool, eid, f32, str } from '../src/index';
import type { Accessor, Entity } from '../src/index';

class Mesh {
  public n = 0;
}

const Position = new Trait({ x: f32(0), y: f32(0) });
const Stats = new Trait({ hp: 0, name: str(''), alive: bool(false), owner: eid(0) });
const Nested = new Trait({ pos: { x: f32(0), y: f32(0) }, level: 0 });
const MeshOf = new Trait(() => new Mesh());
const IsActive = new Trait();
const Attached = new Relation({ offset: 0 }, { exclusive: true });

const world = new World();
const entity = world.spawn();

describe('accessor typing (§4.5, §11)', () => {
  test('the accessor is typed from its field', () => {
    expectTypeOf(world.accessor(Position.x)).toEqualTypeOf<Accessor<number>>();
    expectTypeOf(world.accessor(Stats.name)).toEqualTypeOf<Accessor<string>>();
    expectTypeOf(world.accessor(Stats.alive)).toEqualTypeOf<Accessor<boolean>>();
    expectTypeOf(world.accessor(Stats.owner)).toEqualTypeOf<Accessor<Entity>>();
    expectTypeOf(world.accessor(Nested['pos.x'])).toEqualTypeOf<Accessor<number>>();
    expectTypeOf(world.accessor(Attached.offset)).toEqualTypeOf<Accessor<number>>();
  });

  test('an AoS trait resolves to its reference type', () => {
    expectTypeOf(world.accessor(MeshOf)).toEqualTypeOf<Accessor<Mesh>>();
    expectTypeOf(world.accessor(MeshOf).get(entity)).toEqualTypeOf<Mesh>();
  });

  test('get and set agree on the value type', () => {
    const px = world.accessor(Position.x);
    expectTypeOf(px.get(entity)).toEqualTypeOf<number>();
    expectTypeOf(px.set(entity, 1)).toEqualTypeOf<void>();
    // @ts-expect-error — a number column takes numbers
    px.set(entity, 'far');
    // @ts-expect-error — an entity handle is not a plain number
    px.get(1);
  });

  test('struct traits and tags have no single value and are rejected', () => {
    // @ts-expect-error — a struct trait is not a field
    world.accessor(Position);
    // @ts-expect-error — a tag carries nothing
    world.accessor(IsActive);
    // @ts-expect-error — no such field
    world.accessor(Position.z);
  });
});
