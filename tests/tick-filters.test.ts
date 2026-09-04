import { describe, expect, test } from 'vitest';

import { Added, Changed, Removed, Trait, With, World, f32 } from '../src/index';
import type { Entity, QueryResult } from '../src/index';

const Position = new Trait({ x: f32(0), y: f32(0) });
const Velocity = new Trait({ x: f32(0), y: f32(0) });
const IsActive = new Trait();

function collect(query: QueryResult): Entity[] {
  const out: Entity[] = [];
  query.each((...args: unknown[]) => out.push(args[args.length - 1] as Entity));
  return out;
}

describe('Changed (§6.1, §8.3)', () => {
  test('the first run sees every matching entity', () => {
    const world = new World();
    const a = world.spawn(Position({ x: 1 }));
    const b = world.spawn(Position({ x: 2 }));

    const seen = collect(world.query(Position, Changed(Position)));

    expect(seen.sort()).toEqual([a, b].sort());

    world.destroy();
  });

  test('later runs yield only entities written since this query last ran', () => {
    const world = new World();
    const a = world.spawn(Position, Velocity);
    world.spawn(Position);
    const query = world.query(Position, Changed(Position));
    collect(query); // consume the initial state

    world.step();
    world.set(a, Position.x, 5);
    expect(collect(query)).toEqual([a]);

    world.step();
    expect(collect(query)).toEqual([]);

    world.step();
    world.set(a, Velocity.x, 5); // a different trait is not a change to Position
    expect(collect(query)).toEqual([]);

    world.destroy();
  });

  test('two systems with their own signatures do not steal each other’s events', () => {
    const world = new World();
    const e = world.spawn(Position, IsActive);
    const sysA = world.query(Position, Changed(Position));
    const sysB = world.query(With(IsActive), Changed(Position));
    collect(sysA);
    collect(sysB);

    world.step();
    world.set(e, Position.x, 5);

    expect(collect(sysB)).toEqual([e]);
    expect(collect(sysA)).toEqual([e]); // B’s run did not consume A’s view

    world.step();
    expect(collect(sysA)).toEqual([]);
    expect(collect(sysB)).toEqual([]);

    world.destroy();
  });
});

describe('Added (§6.1, §8.3)', () => {
  test('Added yields entities that gained the trait since the last run', () => {
    const world = new World();
    const early = world.spawn(Velocity);
    const query = world.query(Added(Velocity));
    expect(collect(query)).toEqual([early]); // the first run sees the pre-existing entity

    world.step();
    const late = world.spawn(Velocity);
    const gained = world.spawn(Position);
    world.add(gained, Velocity);
    expect(collect(query).sort()).toEqual([late, gained].sort());

    world.step();
    expect(collect(query)).toEqual([]);

    world.step();
    world.set(late, Velocity.x, 9); // a value write is not an addition
    expect(collect(query)).toEqual([]);

    world.destroy();
  });
});

describe('Removed (§6.1, §8.3)', () => {
  test('Removed yields entities that lost the trait since the last run', () => {
    const world = new World();
    const e = world.spawn(Position, Velocity);
    const query = world.query(Position, Removed(Velocity));
    expect(collect(query)).toEqual([]); // nothing has been removed yet

    world.step();
    world.remove(e, Velocity);

    expect(collect(query)).toEqual([e]);
    expect(world.has(e, Velocity)).toBe(false); // yielded without the trait

    world.step();
    expect(collect(query)).toEqual([]);

    world.destroy();
  });

  test('a removal is visible for one tick, then expires', () => {
    const world = new World();
    const e = world.spawn(Position, Velocity);
    world.remove(e, Velocity);

    world.step();
    const inWindow = world.query(Position, Removed(Velocity));
    expect(collect(inWindow)).toEqual([e]);
    inWindow.dispose();

    world.step();
    const late = world.query(Position, Removed(Velocity));
    expect(collect(late)).toEqual([]);

    world.destroy();
  });
});
