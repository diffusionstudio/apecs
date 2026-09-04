/**
 * T7.3 — the structural rules the iteration path must not break (SPEC §12.2):
 * no `Proxy`, no generators, and one cursor class per trait rather than a
 * shared, megamorphic one.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { types } from 'node:util';

import { describe, expect, test } from 'vitest';

import { Optional, Trait, World, f32 } from '../src/index';
import { $bind, $poison, $row, cursorClassFor, driverFor } from '../src/internal';

const Position = new Trait({ x: f32(0), y: f32(0) });
const Velocity = new Trait({ x: f32(0), y: f32(0) });
const Nested = new Trait({ pos: { x: f32(0) }, hp: 0 });
const Mesh = new Trait(() => ({ id: 0 }));
const IsActive = new Trait();

const SOURCE = join(import.meta.dirname, '../src');

/** Every `.ts` under `src`, subpath entries (`src/react`, `src/solid`) included. */
function sources(): string[] {
  return readdirSync(SOURCE, { recursive: true }).filter(
    (file) => typeof file === 'string' && file.endsWith('.ts'),
  ) as string[];
}

function populated(): World {
  const world = new World({ pageSize: 8 });
  for (let i = 0; i < 20; i++) {
    world.spawn(Position({ x: i }), Velocity({ x: 1 }), Nested, Mesh, IsActive);
  }
  return world;
}

describe('no Proxy (§12.2, rule 3)', () => {
  test('nothing the iteration tiers hand out is a proxy', () => {
    const world = populated();
    const handed: unknown[] = [];

    world.query(Position, Nested, Mesh, Optional(Velocity)).each((p, n, mesh, v, e) => {
      handed.push(p, n, n.pos, mesh, v, e);
    });
    for (const chunk of world.query(Position, Mesh).chunks()) {
      handed.push(chunk, chunk.get(Position), chunk.get(Mesh), chunk.entities);
    }
    handed.push(world, world.query(Position), world.get(world.query(Position).first!, Position));

    expect(handed.length).toBeGreaterThan(0);
    for (const value of handed) {
      expect(types.isProxy(value)).toBe(false);
    }

    world.destroy();
  });

  test('the source never constructs one', () => {
    for (const file of sources()) {
      const source = readFileSync(join(SOURCE, file), 'utf8');
      expect(source, file).not.toMatch(/new Proxy\b/);
    }
  });
});

describe('no generators (§12.2, rule 4)', () => {
  test('chunks() is a reusable iterator object, not a generator', () => {
    const world = populated();
    const chunks = world.query(Position).chunks();
    const iterator = chunks[Symbol.iterator]();

    expect(iterator).toBe(chunks);
    expect(types.isGeneratorObject(iterator)).toBe(false);
    expect(chunks[Symbol.iterator]).not.toSatisfy(types.isGeneratorFunction);
    expect(typeof chunks.next).toBe('function');
    expect(chunks.next).toBe(Object.getPrototypeOf(chunks).next);

    // A second walk reuses the same object rather than minting one.
    expect(world.query(Position).chunks()).toBe(chunks);

    world.destroy();
  });

  test('the tier-1 walks return plain iterator objects', () => {
    const world = populated();
    const query = world.query(Position);
    const sorted = query.sortBy(Position.x);

    for (const iterable of [query, sorted]) {
      const iterator = iterable[Symbol.iterator]();
      expect(types.isGeneratorObject(iterator)).toBe(false);
      expect(typeof iterator.next).toBe('function');
      expect(iterator.next).toBe(Object.getPrototypeOf(iterator).next);
    }

    world.destroy();
  });

  test('the source declares no generator functions', () => {
    for (const file of sources()) {
      const source = readFileSync(join(SOURCE, file), 'utf8');
      expect(source, file).not.toMatch(/function\s*\*|^\s*\*\s*\[Symbol\.iterator\]/m);
      expect(source, file).not.toMatch(/\byield\b/);
    }
  });
});

describe('per-trait cursor classes (§12.2, rule 2)', () => {
  test('each trait gets its own class, memoised per tracking mode', () => {
    const untracked = cursorClassFor(Position, false);
    const tracked = cursorClassFor(Position, true);

    expect(untracked).not.toBeNull();
    expect(untracked).toBe(cursorClassFor(Position, false));
    expect(tracked).toBe(cursorClassFor(Position, true));
    expect(untracked).not.toBe(tracked);
    expect(untracked).not.toBe(cursorClassFor(Velocity, false));
  });

  test('a tag and an AoS trait have no cursor class at all', () => {
    expect(cursorClassFor(IsActive, false)).toBeNull();
    expect(cursorClassFor(Mesh, false)).toBeNull();
  });

  test('a cursor class carries the accessors, not the trait or the world', () => {
    const cursor = new (cursorClassFor(Position, false)!)();

    expect($row in cursor).toBe(true);
    expect(typeof cursor[$bind]).toBe('function');
    expect(typeof cursor[$poison]).toBe('function');
    // The declared fields are accessors on the prototype, so every instance is
    // one shape and every read compiles to a typed-array index.
    for (const key of ['x', 'y']) {
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(cursor), key);
      expect(descriptor?.get, key).toBeTypeOf('function');
      expect(descriptor?.set, key).toBeTypeOf('function');
    }
  });

  test('the row dispatch is generated per query, not shared by layout', () => {
    // Two cursors, no boxed slots: the layout two Position-like queries share.
    const first = driverFor(0b0101, 2, false);
    const second = driverFor(0b0101, 2, false);

    expect(typeof first).toBe('function');
    // Sharing one driver would make the callback call inside it megamorphic
    // across every query of that shape.
    expect(first).not.toBe(second);
    // Wider argument lists than the layout word holds fall back to one loop.
    expect(driverFor(0, 16, false)).toBe(driverFor(0, 17, false));
  });

  test('the cursors two traits hand to each() are different classes', () => {
    const world = populated();
    const classes: unknown[] = [];

    world.query(Position, Velocity, Nested).each((p, v, n) => {
      classes.push(p.constructor, v.constructor, n.constructor);
    });

    const [position, velocity, nested] = classes as [unknown, unknown, unknown];

    expect(position).not.toBe(velocity);
    expect(position).not.toBe(nested);
    expect(velocity).not.toBe(nested);
    // Same trait, same class: the walk stays monomorphic across queries.
    world.query(Position, IsActive).each((p) => {
      expect(p.constructor).toBe(position);
    });

    world.destroy();
  });
});
