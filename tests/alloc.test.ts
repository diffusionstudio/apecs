/**
 * T7.2 — the iteration tiers and the entity cycle allocate nothing after
 * warmup (SPEC §12.1, §12.2 rule 1). Measured as a heap delta over many
 * passes, so a stray per-row object shows up as kilobytes per pass and a
 * settled walk as a handful of bytes of GC noise.
 */
import { describe, expect, test } from 'vitest';

import { Optional, Trait, World, f32 } from '../src/index';
import type { Entity } from '../src/index';
import { CAN_MEASURE_HEAP, bytesPerPass } from './support/heap';

const Position = new Trait({ x: f32(0), y: f32(0) });
const Velocity = new Trait({ x: f32(0), y: f32(0) });
const Nested = new Trait({ pos: { x: f32(0), y: f32(0) }, hp: 0 });
const Mesh = new Trait(() => ({ x: 0 }));
const IsActive = new Trait();

const ENTITIES = 1_000;
const PASSES = 200;

/** One object per row would be ~24 bytes; this leaves room for GC noise only. */
const NOISE = 2;

const it = test.skipIf(!CAN_MEASURE_HEAP);

function populate(world: World): void {
  for (let i = 0; i < ENTITIES; i++) {
    world.spawn(Position({ x: i, y: i }), Velocity({ x: 1, y: 1 }), Nested, Mesh, IsActive);
  }
}

describe('each (§12.2)', () => {
  it('a cursor walk allocates nothing per pass', () => {
    const world = new World();
    populate(world);
    const query = world.query(Position, Velocity, IsActive);
    let sum = 0;

    const bytes = bytesPerPass(PASSES, () => {
      query.each((p, v) => {
        p.x += v.x;
        sum += p.x;
      });
    });

    expect(sum).toBeGreaterThan(0);
    expect(bytes / ENTITIES).toBeLessThan(NOISE);

    world.destroy();
  });

  it('nested cursors, AoS references and Optional allocate nothing per pass', () => {
    const world = new World();
    populate(world);
    const query = world.query(Nested, Mesh, Optional(Velocity), Optional(IsActive));
    let sum = 0;

    const bytes = bytesPerPass(PASSES, () => {
      query.each((n, mesh, v) => {
        n.pos.x += 1;
        mesh.x = n.pos.x;
        sum += v === null ? 0 : v.x;
      });
    });

    expect(sum).toBeGreaterThan(0);
    expect(bytes / ENTITIES).toBeLessThan(NOISE);

    world.destroy();
  });
});

describe('chunks (§12.2)', () => {
  it('a chunk walk allocates nothing per pass', () => {
    const world = new World({ pageSize: 64 });
    populate(world);
    const query = world.query(Position, Velocity);
    let sum = 0;

    const bytes = bytesPerPass(PASSES, () => {
      for (const chunk of query.chunks()) {
        const { x } = chunk.get(Position);
        const { x: vx } = chunk.get(Velocity);
        for (let i = 0, n = chunk.length; i < n; i++) {
          x[i] += vx[i];
          sum += x[i];
        }
        chunk.markChanged(Position);
      }
    });

    expect(sum).toBeGreaterThan(0);
    expect(bytes / ENTITIES).toBeLessThan(NOISE);

    world.destroy();
  });
});

describe('entity-cycle (§12.1)', () => {
  it('spawn and despawn reach a steady state with no allocation', () => {
    const world = new World();
    const live: Entity[] = new Array(ENTITIES);

    const bytes = bytesPerPass(20, () => {
      for (let i = 0; i < ENTITIES; i++) {
        live[i] = world.spawn(Position, Velocity);
      }
      for (let i = 0; i < ENTITIES; i++) {
        world.despawn(live[i]);
      }
    });

    expect(world.query(Position).count).toBe(0);
    expect(bytes / ENTITIES).toBeLessThan(NOISE);

    world.destroy();
  });
});

describe('orderBy (§6.8, §12.2)', () => {
  const SortIndex = new Trait({ value: 0 });

  function ordered(world: World) {
    const entities: Entity[] = new Array(ENTITIES);
    for (let i = 0; i < ENTITIES; i++) {
      entities[i] = world.spawn(Position({ x: i }), SortIndex({ value: (i * 7919) % ENTITIES }));
    }
    const view = world.query(Position, SortIndex).orderBy(SortIndex.value);
    world.step();
    view.first;
    return { entities, view };
  }

  it('a clean frame allocates nothing', () => {
    const world = new World({ pageSize: 64 });
    const { view } = ordered(world);
    let sum = 0;

    const bytes = bytesPerPass(PASSES, () => {
      world.step();
      for (const chunk of view.chunks()) {
        const { x } = chunk.get(Position);
        for (let i = chunk.length - 1; i >= 0; i--) {
          sum += x[i];
        }
      }
    });

    expect(sum).toBeGreaterThan(0);
    expect(bytes / ENTITIES).toBeLessThan(NOISE);

    world.destroy();
  });

  it('a resorting frame allocates nothing', () => {
    const world = new World({ pageSize: 64 });
    const { entities, view } = ordered(world);
    let sum = 0;
    let cursor = 0;

    const bytes = bytesPerPass(PASSES, () => {
      world.step();
      for (let i = 0; i < ENTITIES / 100; i++) {
        cursor = (cursor + 7919) % ENTITIES;
        world.set(entities[cursor], SortIndex.value, (cursor * 31) % ENTITIES);
      }
      for (const chunk of view.chunks()) {
        const { x } = chunk.get(Position);
        for (let i = chunk.length - 1; i >= 0; i--) {
          sum += x[i];
        }
      }
    });

    expect(sum).toBeGreaterThan(0);
    expect(bytes / ENTITIES).toBeLessThan(NOISE);

    world.destroy();
  });
});
