import { describe, expect, test } from 'vitest';

import { Relation, Trait, World } from '../src/index';
import type { Entity } from '../src/index';

const Position = new Trait({ x: 0 });
const ChildOf = new Relation(undefined, { exclusive: true });
const PartOf = new Relation(undefined, { exclusive: true, onTargetDespawn: 'despawn' });
const Orbits = new Relation(undefined, { exclusive: true, onTargetDespawn: 'orphan' });
const Likes = new Relation({ amount: 0 });
const Owns = new Relation(undefined, { onTargetDespawn: 'despawn' });
const Remembers = new Relation(undefined, { onTargetDespawn: 'orphan' });

describe("onTargetDespawn: 'remove' (§7.5)", () => {
  test('exclusive: the source loses the relation and stays alive', () => {
    const world = new World();
    const p = world.spawn();
    const a = world.spawn(Position, ChildOf(p));
    const b = world.spawn(ChildOf(p));
    const removed: Array<[Entity, Entity | undefined]> = [];
    world.onRemove(ChildOf, (entity, target) => removed.push([entity, target]));

    world.despawn(p);

    expect(world.isAlive(a)).toBe(true);
    expect(world.isAlive(b)).toBe(true);
    expect(world.has(a, ChildOf)).toBe(false);
    expect(world.has(b, ChildOf)).toBe(false);
    expect(world.has(a, Position)).toBe(true);
    expect(removed.sort()).toEqual(
      [
        [a, p],
        [b, p],
      ].sort(),
    );
    expect(world.query(ChildOf(p)).isEmpty).toBe(true);

    world.destroy();
  });

  test('non-exclusive: only the pair to the dead target goes', () => {
    const world = new World();
    const a = world.spawn();
    const b = world.spawn();
    const e = world.spawn(Likes(a, { amount: 1 }), Likes(b, { amount: 2 }));

    world.despawn(a);

    expect(world.isAlive(e)).toBe(true);
    expect(world.has(e, Likes(a))).toBe(false);
    expect(world.has(e, Likes(b))).toBe(true);
    expect(world.get(e, Likes(b))).toEqual({ amount: 2 });

    world.despawn(b);
    expect(world.has(e, Likes('*'))).toBe(false);

    world.destroy();
  });

  test('grandchildren keep their own relation', () => {
    const world = new World();
    const root = world.spawn();
    const mid = world.spawn(ChildOf(root));
    const leaf = world.spawn(ChildOf(mid));

    world.despawn(root);

    expect(world.has(mid, ChildOf)).toBe(false);
    expect(world.target(leaf, ChildOf)).toBe(mid);

    world.destroy();
  });
});

describe("onTargetDespawn: 'despawn' (§7.5)", () => {
  test('exclusive: the whole subtree goes down with the target', () => {
    const world = new World();
    const root = world.spawn();
    const a = world.spawn(PartOf(root));
    const b = world.spawn(PartOf(a));
    const c = world.spawn(PartOf(a));
    const unrelated = world.spawn(PartOf(world.spawn()));
    const removed: Entity[] = [];
    world.onRemove(PartOf, (entity) => removed.push(entity));

    world.despawn(root);

    for (const e of [root, a, b, c]) {
      expect(world.isAlive(e)).toBe(false);
    }
    expect(world.isAlive(unrelated)).toBe(true);
    expect(removed.sort()).toEqual([a, b, c].sort());

    world.destroy();
  });

  test('non-exclusive: every holder of a pair to the target is despawned', () => {
    const world = new World();
    const a = world.spawn();
    const b = world.spawn();
    const x = world.spawn(Owns(a));
    const y = world.spawn(Owns(a), Owns(b));
    const z = world.spawn(Owns(b));
    const w = world.spawn(Owns(y));

    world.despawn(a);

    expect(world.isAlive(x)).toBe(false);
    expect(world.isAlive(y)).toBe(false);
    expect(world.isAlive(w)).toBe(false);
    expect(world.isAlive(z)).toBe(true);

    world.destroy();
  });

  test('a deep chain cascades without growing the stack', () => {
    const world = new World();
    const depth = 100_000;
    let previous = world.spawn();
    const root = previous;
    for (let i = 0; i < depth; i++) {
      previous = world.spawn(PartOf(previous));
    }

    world.despawn(root);

    expect(world.isAlive(previous)).toBe(false);
    expect(world.query(PartOf('*')).isEmpty).toBe(true);

    world.destroy();
  });

  test('a wide tree cascades through every level', () => {
    const world = new World({ pageSize: 4 });
    const root = world.spawn();
    let level = [root];
    let total = 0;
    for (let d = 0; d < 4; d++) {
      const next: Entity[] = [];
      for (const parent of level) {
        for (let i = 0; i < 3; i++) {
          next.push(world.spawn(Position, PartOf(parent)));
        }
      }
      total += next.length;
      level = next;
    }
    expect(world.query(PartOf('*')).count).toBe(total);

    world.despawn(root);

    expect(world.query(PartOf('*')).isEmpty).toBe(true);
    expect(world.query(Position).isEmpty).toBe(true);

    world.destroy();
  });

  test('a cycle terminates cleanly', () => {
    const world = new World();
    const a = world.spawn();
    const b = world.spawn();
    const c = world.spawn();
    world.add(a, PartOf(c));
    world.add(b, PartOf(a));
    world.add(c, PartOf(b));
    const x = world.spawn();
    const y = world.spawn(Owns(x));
    world.add(x, Owns(y));

    world.despawn(a);
    world.despawn(x);

    for (const e of [a, b, c, x, y]) {
      expect(world.isAlive(e)).toBe(false);
    }

    world.destroy();
  });

  test('despawnMany over a query of sources cascades once each', () => {
    const world = new World();
    const root = world.spawn();
    for (let i = 0; i < 3; i++) {
      world.spawn(PartOf(world.spawn(PartOf(root))));
    }

    world.despawnMany(world.query(PartOf(root)));

    expect(world.query(PartOf('*')).isEmpty).toBe(true);
    expect(world.isAlive(root)).toBe(true);

    world.destroy();
  });
});

describe("onTargetDespawn: 'orphan' (§7.5)", () => {
  test('exclusive: the relation is kept with a dead target', () => {
    const world = new World();
    const sun = world.spawn();
    const planet = world.spawn(Orbits(sun));
    let removals = 0;
    world.onRemove(Orbits, () => removals++);

    world.despawn(sun);

    expect(world.isAlive(planet)).toBe(true);
    expect(world.has(planet, Orbits)).toBe(true);
    expect(world.target(planet, Orbits)).toBe(sun);
    expect(world.isAlive(world.target(planet, Orbits))).toBe(false);
    expect([...world.query(Orbits(sun))]).toEqual([planet]);
    expect(removals).toBe(0);

    world.destroy();
  });

  test('non-exclusive: the pair is kept', () => {
    const world = new World();
    const a = world.spawn();
    const e = world.spawn(Remembers(a));

    world.despawn(a);

    expect(world.has(e, Remembers(a))).toBe(true);
    expect([...world.targets(e, Remembers)]).toEqual([a]);
    expect([...world.query(Remembers(a))]).toEqual([e]);

    world.destroy();
  });

  test('a recycled id is a different target', () => {
    const world = new World();
    const sun = world.spawn();
    const planet = world.spawn(Orbits(sun));
    world.despawn(sun);

    const reborn = world.spawn();

    expect(world.target(planet, Orbits)).not.toBe(reborn);
    expect(world.query(Orbits(reborn)).isEmpty).toBe(true);

    world.destroy();
  });
});

describe('observers receive the target (§8.1)', () => {
  test('onAdd and onRemove on a relation pass the target', () => {
    const world = new World();
    const p = world.spawn();
    const q = world.spawn();
    const log: string[] = [];
    world.onAdd(ChildOf, (e, t) => log.push(`add ${e}->${t}`));
    world.onRemove(ChildOf, (e, t) => log.push(`remove ${e}->${t}`));

    const child = world.spawn(ChildOf(p));
    world.add(child, ChildOf(q));
    world.remove(child, ChildOf);

    expect(log).toEqual([
      `add ${child}->${p}`,
      `remove ${child}->${p}`,
      `add ${child}->${q}`,
      `remove ${child}->${q}`,
    ]);

    world.destroy();
  });

  test('non-exclusive observers fire once per pair', () => {
    const world = new World();
    const a = world.spawn();
    const b = world.spawn();
    const added: Array<Entity | undefined> = [];
    const removed: Array<Entity | undefined> = [];
    world.onAdd(Likes, (_e, t) => added.push(t));
    world.onRemove(Likes, (_e, t) => removed.push(t));

    const e = world.spawn(Likes(a), Likes(b));
    expect(added.sort()).toEqual([a, b].sort());

    world.despawn(e);
    expect(removed.sort()).toEqual([a, b].sort());

    world.destroy();
  });

  test('an observer on one pair sees only that target', () => {
    const world = new World();
    const p = world.spawn();
    const q = world.spawn();
    const a = world.spawn();
    const b = world.spawn();
    const seen: Entity[] = [];
    world.onAdd(ChildOf(p), (e) => seen.push(e));
    world.onAdd(Likes(a), (e) => seen.push(e));

    const child = world.spawn(ChildOf(q));
    world.spawn(Likes(b));
    world.add(child, ChildOf(p));
    const fan = world.spawn(Likes(a), Likes(b));

    expect(seen).toEqual([child, fan]);

    world.destroy();
  });

  test('onRemove fires before the relation is torn down, on the source and on the target', () => {
    const world = new World();
    const p = world.spawn();
    const child = world.spawn(ChildOf(p));
    const seen: Array<[boolean, Entity | undefined]> = [];
    world.onRemove(ChildOf, (e, t) => seen.push([world.has(e, ChildOf(p)), t]));

    world.despawn(child);
    const other = world.spawn(ChildOf(p));
    world.despawn(p);

    expect(seen).toEqual([
      [true, p],
      [true, p],
    ]);
    expect(world.has(other, ChildOf)).toBe(false);

    world.destroy();
  });

  test('a plain trait still passes undefined', () => {
    const world = new World();
    const targets: unknown[] = [];
    world.onAdd(Position, (_e, t) => targets.push(t));
    world.onRemove(Position, (_e, t) => targets.push(t));

    world.despawn(world.spawn(Position));

    expect(targets).toEqual([undefined, undefined]);

    world.destroy();
  });
});
