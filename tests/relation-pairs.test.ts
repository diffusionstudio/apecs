import { afterEach, describe, expect, test, vi } from 'vitest';

import { Not, Relation, Trait, World } from '../src/index';
import type { Entity } from '../src/index';
import {
  $archetypes,
  $fields,
  $id,
  $kind,
  $relation,
  $target,
  $traits,
  maskHas,
  pairOf,
  resetWarnOnce,
} from '../src/internal';
import { archetypeOf } from './support/columns';

const Position = new Trait({ x: 0 });
const Likes = new Relation({ amount: 0 });
const Owes = new Relation();

afterEach(() => {
  vi.restoreAllMocks();
  resetWarnOnce();
});

function sorted(entities: Iterable<number>): number[] {
  return [...entities].sort((a, b) => a - b);
}

describe('pair ids (§7.4)', () => {
  test('a (relation, target) pair interns to one trait-like object', () => {
    const world = new World();
    const a = world.spawn();
    const b = world.spawn();

    const pair = pairOf(Likes, a);
    expect(pairOf(Likes, a)).toBe(pair);
    expect(pairOf(Likes, b)).not.toBe(pair);
    expect(pairOf(Owes, a)).not.toBe(pair);
    expect(pair[$relation]).toBe(Likes);
    expect(pair[$target]).toBe(a);
    expect(pair[$id]).not.toBe(Likes[$id]);
    expect(pair[$kind]).toBe('struct');
    expect(pair[$fields]).toBe(Likes[$fields]);

    world.destroy();
  });

  test('each pair takes its own mask bit; the relation bit rides along', () => {
    const world = new World();
    const a = world.spawn();
    const b = world.spawn();
    const e = world.spawn(Likes(a), Likes(b));

    const traits = world[$traits];
    const mask = archetypeOf(world, e).mask;
    expect(maskHas(mask, traits.localId(pairOf(Likes, a)))).toBe(true);
    expect(maskHas(mask, traits.localId(pairOf(Likes, b)))).toBe(true);
    expect(maskHas(mask, traits.localId(Likes))).toBe(true);

    world.destroy();
  });

  test('the relation itself owns no columns; each pair does', () => {
    const world = new World();
    const a = world.spawn();
    const b = world.spawn();
    const e = world.spawn(Likes(a, { amount: 1 }), Likes(b, { amount: 2 }));

    const archetype = archetypeOf(world, e);
    expect(archetype.columnsOf.get(Likes[$id])).toBeUndefined();
    expect(archetype.columnsOf.get(pairOf(Likes, a)[$id])).toHaveLength(1);
    expect(archetype.columnsOf.get(pairOf(Likes, b)[$id])).toHaveLength(1);

    world.destroy();
  });

  test('distinct targets are distinct archetypes; the same target set is one', () => {
    const world = new World();
    const a = world.spawn();
    const b = world.spawn();
    const populated = () => world[$archetypes].list.filter((a) => a.rows !== 0).length;
    const before = populated();

    const x = world.spawn(Likes(a));
    const y = world.spawn(Likes(a));
    const z = world.spawn(Likes(b));
    const w = world.spawn(Likes(a), Likes(b));

    expect(archetypeOf(world, x)).toBe(archetypeOf(world, y));
    expect(archetypeOf(world, z)).not.toBe(archetypeOf(world, x));
    expect(archetypeOf(world, w)).not.toBe(archetypeOf(world, z));
    expect(populated()).toBe(before + 3);

    world.destroy();
  });
});

describe('querying pairs (§7.3)', () => {
  test('a pair term matches exactly the entities related to that target', () => {
    const world = new World();
    const a = world.spawn();
    const b = world.spawn();
    const x = world.spawn(Likes(a));
    const y = world.spawn(Likes(b));
    const z = world.spawn(Likes(a), Likes(b));
    world.spawn(Position);

    expect(sorted(world.query(Likes(a)))).toEqual(sorted([x, z]));
    expect(sorted(world.query(Likes(b)))).toEqual(sorted([y, z]));
    expect(world.query(Likes(a))).toBe(world.query(Likes(a)));
    expect(typeof world.query(Likes(a)).chunks).toBe('function');

    world.destroy();
  });

  test('two targets in one query is a single archetype match', () => {
    const world = new World();
    const a = world.spawn();
    const b = world.spawn();
    world.spawn(Likes(a));
    world.spawn(Likes(b));
    const both = world.spawn(Likes(a), Likes(b));

    const query = world.query(Likes(a), Likes(b));
    expect([...query]).toEqual([both]);
    expect(query[$archetypes]).toHaveLength(1);
    expect([...world.query(Likes(a), Not(Likes(b)))]).not.toContain(both);

    world.destroy();
  });

  test("the wildcard matches any target, and Not('*') the rest", () => {
    const world = new World();
    const a = world.spawn();
    const b = world.spawn();
    const x = world.spawn(Position, Likes(a));
    const y = world.spawn(Position, Likes(b));
    const lonely = world.spawn(Position);

    expect(sorted(world.query(Likes('*')))).toEqual(sorted([x, y]));
    expect(sorted(world.query(Position, Not(Likes('*'))))).toEqual([lonely]);

    world.remove(x, Likes(a));
    expect(sorted(world.query(Likes('*')))).toEqual([y]);

    world.destroy();
  });

  test('each and chunks read the columns of the pair that was asked for', () => {
    const world = new World();
    const a = world.spawn();
    const b = world.spawn();
    const e = world.spawn(Likes(a, { amount: 1 }), Likes(b, { amount: 10 }));

    const seen: Array<[number, Entity]> = [];
    world.query(Likes(b)).each((likes, entity: Entity) => {
      seen.push([likes.amount, entity]);
      likes.amount += 5;
    });
    expect(seen).toEqual([[10, e]]);
    expect(world.get(e, Likes(b))).toEqual({ amount: 15 });
    expect(world.get(e, Likes(a))).toEqual({ amount: 1 });

    for (const chunk of world.query(Likes(a)).chunks()) {
      const { amount } = chunk.get(Likes(a));
      expect(amount[0]).toBe(1);
      expect(chunk.get(Likes(b)).amount[0]).toBe(15);
    }

    world.destroy();
  });
});

describe('cardinality warning (§7.4)', () => {
  test.runIf(__DEV__)('dev warns once when a world interns more pairs than the threshold', () => {
    const Follows = new Relation(undefined, { maxPairs: 3 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const world = new World();

    for (let i = 0; i < 3; i++) {
      world.spawn(Follows(world.spawn()));
    }
    expect(warn).not.toHaveBeenCalled();

    world.spawn(Follows(world.spawn()));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/exclusive/);

    world.spawn(Follows(world.spawn()));
    expect(warn).toHaveBeenCalledTimes(1);

    world.destroy();
  });

  test('the threshold defaults to 64 and is not a cap', () => {
    const Follows = new Relation();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const world = new World();
    expect(Follows[$id]).toBeGreaterThan(0);

    for (let i = 0; i < 70; i++) {
      world.spawn(Follows(world.spawn()));
    }

    expect(world.query(Follows('*')).count).toBe(70);
    expect(warn).toHaveBeenCalledTimes(__DEV__ ? 1 : 0);

    world.destroy();
  });
});
