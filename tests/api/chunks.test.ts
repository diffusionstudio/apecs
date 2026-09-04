/**
 * SPEC §6.6 — tier 3: `chunks`, the page views it hands out, and the
 * bookkeeping it makes the caller responsible for. Public API only.
 */
import { afterEach, describe, expect, test } from 'vitest';

import { Changed, Trait, World, f32, i16, str } from '../../src/index';
import type { Chunk, Entity } from '../../src/index';

const Position = new Trait({ x: f32(0), y: f32(0) });
const Velocity = new Trait({ x: f32(0), y: f32(0) });
const Body = new Trait({ pos: { x: 0, y: 0 }, mass: 1 });
const Mixed = new Trait({ n: i16(0), b: false, s: str('') });
const Mesh = new Trait(() => ({ n: 0 }));
const IsActive = new Trait();

const worlds: World[] = [];

function makeWorld(options?: ConstructorParameters<typeof World>[0]): World {
  const world = new World(options);
  worlds.push(world);
  return world;
}

afterEach(() => {
  for (const world of worlds.splice(0)) {
    world.destroy();
  }
});

describe('shape (§6.6)', () => {
  test('a chunk carries a length, its entities, and typed views', () => {
    const world = makeWorld();
    world.spawnMany(3, Position);
    let chunks = 0;

    for (const chunk of world.query(Position).chunks()) {
      chunks++;
      expect(chunk.length).toBe(3);
      expect(chunk.entities).toBeInstanceOf(Float64Array);

      const p = chunk.get(Position);

      expect(p.x).toBeInstanceOf(Float32Array);
      expect(p.y).toBeInstanceOf(Float32Array);
    }

    expect(chunks).toBe(1);
  });

  test('column() names one field directly', () => {
    const world = makeWorld();
    world.spawn(Position({ x: 5 }));

    for (const chunk of world.query(Position).chunks()) {
      const x = chunk.column(Position.x);

      expect(x).toBeInstanceOf(Float32Array);
      expect(x[0]).toBe(5);
    }
  });

  test('the store mirrors the declared shape, nesting included', () => {
    const world = makeWorld();
    world.spawn(Body);

    for (const chunk of world.query(Body).chunks()) {
      const b = chunk.get(Body);

      expect(b.pos.x).toBeInstanceOf(Float64Array);
      expect(b.mass).toBeInstanceOf(Float64Array);
    }
  });

  test('each marker gets its own array type', () => {
    const world = makeWorld();
    world.spawn(Mixed);

    for (const chunk of world.query(Mixed).chunks()) {
      const m = chunk.get(Mixed);

      expect(m.n).toBeInstanceOf(Int16Array);
      expect(m.b).toBeInstanceOf(Uint8Array);
      expect(Array.isArray(m.s)).toBe(true);
    }
  });

  test('an AoS trait hands out the array of references', () => {
    const world = makeWorld();
    const entity = world.spawn(Mesh);
    const reference = world.get(entity, Mesh);

    for (const chunk of world.query(Mesh).chunks()) {
      const meshes = chunk.get(Mesh);

      expect(meshes[0]).toBe(reference);
    }
  });

  test('a bool column is raw 0/1 at this tier — the boxing is what you skip', () => {
    const world = makeWorld();
    const entity = world.spawn(Mixed);
    world.set(entity, Mixed.b, true);

    for (const chunk of world.query(Mixed).chunks()) {
      expect(chunk.get(Mixed).b[0]).toBe(1);
    }
  });
});

describe('alignment (§6.6)', () => {
  test('row i is the same entity in every column and in entities', () => {
    const world = makeWorld({ pageSize: 8 });
    const swarm = world.spawnMany(20, Position, Velocity);
    for (let i = 0; i < swarm.length; i++) {
      world.set(swarm[i] as Entity, Position.x, i);
      world.set(swarm[i] as Entity, Velocity.x, i * 10);
    }

    for (const chunk of world.query(Position, Velocity).chunks()) {
      const p = chunk.get(Position);
      const v = chunk.get(Velocity);
      for (let i = 0; i < chunk.length; i++) {
        expect(v.x[i]).toBe(p.x[i] * 10);
        expect(chunk.entity(i)).toBe(chunk.entities[i]);
        expect(world.get(chunk.entity(i), Position.x)).toBe(p.x[i]);
      }
    }
  });

  test('a chunk never spans a page — length is capped at pageSize', () => {
    const world = makeWorld({ pageSize: 8 });
    world.spawnMany(20, Position);
    const lengths: number[] = [];

    for (const chunk of world.query(Position).chunks()) {
      lengths.push(chunk.length);
    }

    expect(lengths.reduce((a, b) => a + b, 0)).toBe(20);
    for (const length of lengths) {
      expect(length).toBeLessThanOrEqual(8);
    }
  });

  test('the tail page may be shorter than pageSize', () => {
    // Page visit order is not contract (§9 iterates back to front); the set of
    // page lengths is.
    const world = makeWorld({ pageSize: 8 });
    world.spawnMany(12, Position);
    const lengths: number[] = [];

    for (const chunk of world.query(Position).chunks()) {
      lengths.push(chunk.length);
    }

    expect(lengths.slice().sort((a, b) => a - b)).toEqual([4, 8]);
  });

  test('chunks cover every match across archetypes exactly once', () => {
    const world = makeWorld({ pageSize: 4 });
    world.spawnMany(10, Position);
    world.spawnMany(10, Position, Velocity);
    world.spawnMany(10, Position, IsActive);
    const seen = new Set<number>();

    for (const chunk of world.query(Position).chunks()) {
      for (let i = 0; i < chunk.length; i++) {
        seen.add(chunk.entities[i]);
      }
    }

    expect(seen.size).toBe(30);
  });

  test('an empty query yields no chunks', () => {
    const world = makeWorld();
    let chunks = 0;

    for (const _chunk of world.query(Position).chunks()) {
      chunks++;
    }

    expect(chunks).toBe(0);
  });
});

describe('writing through a chunk (§6.6)', () => {
  test('direct column writes land in storage', () => {
    const world = makeWorld();
    const swarm = world.spawnMany(10, Position, Velocity);
    for (const entity of swarm) {
      world.set(entity as Entity, Velocity, { x: 1, y: 2 });
    }

    for (const chunk of world.query(Position, Velocity).chunks()) {
      const { x, y } = chunk.get(Position);
      const { x: vx, y: vy } = chunk.get(Velocity);
      for (let i = 0, n = chunk.length; i < n; i++) {
        x[i] += vx[i] * 2;
        y[i] += vy[i] * 2;
      }
      chunk.markChanged(Position);
    }

    for (const entity of swarm) {
      expect(world.get(entity as Entity, Position)).toEqual({ x: 2, y: 4 });
    }
  });

  test('markChanged is what makes a chunk write visible to Changed()', () => {
    const world = makeWorld();
    world.spawnMany(4, Position);
    const changed = world.query(Position, Changed(Position));
    const drain = () => {
      let n = 0;
      changed.each(() => n++);
      return n;
    };

    drain(); // consume the initial state
    world.step();

    for (const chunk of world.query(Position).chunks()) {
      const { x } = chunk.get(Position);
      for (let i = 0; i < chunk.length; i++) {
        x[i] = 1;
      }
      chunk.markChanged(Position);
    }

    expect(drain()).toBe(4);
  });

  test('markChanged with a row marks that row alone', () => {
    const world = makeWorld();
    world.spawnMany(4, Position);
    const changed = world.query(Position, Changed(Position));
    const drain = () => {
      const seen: Entity[] = [];
      changed.each((_p, e) => seen.push(e));
      return seen;
    };

    drain();
    world.step();

    let marked: Entity | undefined;
    for (const chunk of world.query(Position).chunks()) {
      chunk.get(Position).x[0] = 1;
      chunk.markChanged(Position, 0);
      marked = chunk.entity(0);
    }

    expect(drain()).toEqual([marked]);
  });

  test('world.changed does the same job from outside a chunk', () => {
    const world = makeWorld();
    const entity = world.spawn(Position);
    const changed = world.query(Position, Changed(Position));
    const drain = () => {
      const seen: Entity[] = [];
      changed.each((_p, e) => seen.push(e));
      return seen;
    };

    drain();
    world.step();
    world.changed(entity, Position);

    expect(drain()).toEqual([entity]);
  });
});

describe('iteration protocol (§6.6, §12.2)', () => {
  test('chunks() is iterable and re-iterable', () => {
    const world = makeWorld();
    world.spawnMany(5, Position);
    const query = world.query(Position);
    const counts: number[] = [];

    for (let pass = 0; pass < 2; pass++) {
      let n = 0;
      for (const chunk of query.chunks()) {
        n += chunk.length;
      }
      counts.push(n);
    }

    expect(counts).toEqual([5, 5]);
  });

  test('breaking out of the loop leaves the query usable', () => {
    const world = makeWorld({ pageSize: 4 });
    world.spawnMany(12, Position);
    const query = world.query(Position);

    for (const _chunk of query.chunks()) {
      break;
    }

    let n = 0;
    for (const chunk of query.chunks()) {
      n += chunk.length;
    }

    expect(n).toBe(12);
  });

  test('the chunk object is reused across pages', () => {
    const world = makeWorld({ pageSize: 4 });
    world.spawnMany(12, Position);
    const seen = new Set<Chunk>();

    for (const chunk of world.query(Position).chunks()) {
      seen.add(chunk);
    }

    expect(seen.size).toBe(1);
  });

  test('a sorted query has no chunks — it is tier 1 and each only', () => {
    const world = makeWorld();
    world.spawn(Position);
    const sorted = world.query(Position).sortBy(Position.x);

    // The type surface does not offer it; the runtime still refuses callers
    // that have no types to stop them, in dev and production alike.
    expect(() => (sorted as unknown as { chunks(): void }).chunks()).toThrow(/no chunks/);
  });
});
