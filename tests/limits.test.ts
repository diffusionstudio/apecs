/**
 * T7.4 — the ceilings of SPEC §12.3 and what happens at each of them: the id
 * field, the generation field, the world field, and the two limits that are
 * deliberately unbounded.
 */
import { describe, expect, test } from 'vitest';

import { Trait, World, f32 } from '../src/index';
import type { Entity } from '../src/index';
import {
  EntityIndex,
  GENERATION_COUNT,
  MAX_ENTITIES_PER_WORLD,
  MAX_ENTITY_ID,
  MAX_GENERATION,
  MAX_WORLDS,
  PAGE_SIZE,
  $archetypes,
  $entities,
  entityGeneration,
  entityId,
} from '../src/internal';

describe('entities per world (§12.3)', () => {
  test('the index grows past maxEntities, which pre-sizes rather than caps', () => {
    const world = new World({ maxEntities: 4 });
    const spawned: Entity[] = [];

    for (let i = 0; i < 64; i++) {
      spawned.push(world.spawn());
    }

    expect(world[$entities].capacity).toBeGreaterThanOrEqual(64);
    expect(spawned.every((e) => world.isAlive(e))).toBe(true);

    world.destroy();
  });

  test('growing past the 32-bit id field fails loudly rather than silently', () => {
    const index = new EntityIndex(8);

    expect(() => index.ensure(MAX_ENTITY_ID + 1)).toThrowError(/apecs/);
    expect(index.capacity).toBe(8);
    expect(MAX_ENTITIES_PER_WORLD).toBe(MAX_ENTITY_ID - 1);
  });
});

describe('generations before retirement (§12.3, §4.2)', () => {
  test('an id is retired after 4096 generations and never handed out again', () => {
    const world = new World();
    let entity = world.spawn();
    const retired = entityId(entity);
    const stale: Entity[] = [];

    for (let i = 0; i < GENERATION_COUNT; i++) {
      stale.push(entity);
      if (entityGeneration(entity) === MAX_GENERATION) {
        break;
      }
      world.despawn(entity);
      entity = world.spawn();
    }

    expect(entityGeneration(entity)).toBe(MAX_GENERATION);
    world.despawn(entity);

    const fresh: Entity[] = [];
    for (let i = 0; i < 8; i++) {
      fresh.push(world.spawn());
    }

    expect(fresh.some((e) => entityId(e) === retired)).toBe(false);
    expect(stale.some((e) => world.isAlive(e))).toBe(false);

    world.destroy();
  });
});

describe('worlds alive at once (§12.3, §5.5)', () => {
  test('the 257th live world throws, and destroying one makes room for exactly one', () => {
    const worlds: World[] = [];
    let refused: unknown;

    try {
      for (let i = 0; i <= MAX_WORLDS; i++) {
        worlds.push(new World());
      }
    } catch (error) {
      refused = error;
    }

    expect(worlds).toHaveLength(MAX_WORLDS);
    expect(String(refused)).toMatch(/apecs: no more than 256 worlds/);

    worlds[0].destroy();
    worlds[0] = new World();

    expect(() => new World()).toThrowError(/apecs/);

    for (const world of worlds) {
      world.destroy();
    }

    expect(() => new World().destroy()).not.toThrow();
  });
});

describe('unbounded by design (§12.3)', () => {
  test('traits per world — masks grow a 32-bit block at a time', () => {
    const traits = Array.from({ length: 70 }, () => new Trait({ value: 0 }));
    const world = new World();
    const entity = world.spawn(...traits);

    expect(
      world[$archetypes].list[world[$entities].archetypes[entityId(entity)]].mask,
    ).toHaveLength(Math.ceil(traits.length / 32));
    expect(traits.every((trait) => world.has(entity, trait))).toBe(true);
    expect(world.query(traits[69]).count).toBe(1);

    world.remove(entity, traits[69]);

    expect(world.query(traits[69]).count).toBe(0);
    expect(world.query(traits[0]).count).toBe(1);

    world.destroy();
  });

  test('fields per trait — one column each', () => {
    const keys = Array.from({ length: 100 }, (_, i) => `f${i}`);
    const Wide = new Trait(Object.fromEntries(keys.map((key, i) => [key, f32(i)])));
    const world = new World();
    const entity = world.spawn(Wide);

    expect(Object.keys(world.get(entity, Wide))).toEqual(keys);
    expect(world.get(entity, Wide.f99)).toBe(99);

    world.set(entity, Wide.f99, 7);

    expect(world.get(entity, Wide.f99)).toBe(7);

    world.destroy();
  });
});

describe('page size (§12.3, §10.2)', () => {
  test('the default is 4096 and a custom size must be a power of two', () => {
    expect(PAGE_SIZE).toBe(4096);

    const world = new World({ pageSize: 8 });
    world.spawnMany(20, new Trait({ x: f32(0) }));

    expect(world[$archetypes].list.at(-1)!.pageSize).toBe(8);

    world.destroy();
  });

  test.runIf(__DEV__)('dev rejects a page size that is not a power of two', () => {
    expect(() => new World({ pageSize: 3 })).toThrowError(/power of two/);
    expect(() => new World({ pageSize: 0 })).toThrowError(/power of two/);
    expect(() => new World({ maxEntities: -1 })).toThrowError(/positive integer/);
  });
});
