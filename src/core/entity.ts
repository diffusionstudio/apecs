import { assert } from './debug';

/**
 * A packed handle: `[ world : 8 ][ generation : 12 ][ id : 32 ]`, 52 bits total
 * so it stays an exact double (SPEC §4.1).
 */
export type Entity = number & { readonly __entity: unique symbol };

export const MAX_ENTITY_ID = 0xffffffff;
export const MAX_GENERATION = 0xfff;
export const MAX_WORLD_ID = 0xff;

export const GENERATION_COUNT = MAX_GENERATION + 1;
export const MAX_WORLDS = MAX_WORLD_ID + 1;
export const MAX_ENTITIES_PER_WORLD = 2 ** 32 - 2;

export const NULL_ENTITY = 0 as Entity;
/** Id 1 is the world entity in every world; user entities start at 2 (SPEC §5.4). */
export const WORLD_ENTITY_ID = 1;
export const FIRST_ENTITY_ID = 2;

const HI_SCALE = 2 ** 32;

export function packEntity(id: number, generation: number, world: number): Entity {
  if (__DEV__) {
    assert(
      Number.isInteger(id) && id >= 0 && id <= MAX_ENTITY_ID,
      `entity id ${id} is outside 0..${MAX_ENTITY_ID}`,
    );
    assert(
      Number.isInteger(generation) && generation >= 0 && generation <= MAX_GENERATION,
      `generation ${generation} is outside 0..${MAX_GENERATION}`,
    );
    assert(
      Number.isInteger(world) && world >= 0 && world <= MAX_WORLD_ID,
      `world id ${world} is outside 0..${MAX_WORLD_ID}`,
    );
  }
  return ((world * GENERATION_COUNT + generation) * HI_SCALE + id) as Entity;
}

export function entityId(entity: number): number {
  return entity >>> 0;
}

export function entityGeneration(entity: number): number {
  return ((entity / HI_SCALE) | 0) & MAX_GENERATION;
}

export function entityWorld(entity: number): number {
  return ((entity / HI_SCALE) | 0) >>> 12;
}
