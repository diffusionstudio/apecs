import { describe, expect, test } from 'vitest'

import {
  FIRST_ENTITY_ID,
  GENERATION_COUNT,
  MAX_ENTITIES_PER_WORLD,
  MAX_ENTITY_ID,
  MAX_GENERATION,
  MAX_WORLDS,
  MAX_WORLD_ID,
  NULL_ENTITY,
  WORLD_ENTITY_ID,
  entityGeneration,
  entityId,
  entityWorld,
  packEntity,
} from '../src/internal'

/** The widest handle the layout can produce: world 255, generation 4095, id 2^32-1. */
const MAX_HANDLE = 2 ** 52 - 1

describe('limits (§4.1, §12.3)', () => {
  test('field widths match the documented ceilings', () => {
    expect(MAX_ENTITY_ID).toBe(0xffffffff)
    expect(MAX_GENERATION).toBe(0xfff)
    expect(MAX_WORLD_ID).toBe(0xff)
    expect(GENERATION_COUNT).toBe(MAX_GENERATION + 1)
    expect(MAX_WORLDS).toBe(MAX_WORLD_ID + 1)
    expect(MAX_ENTITIES_PER_WORLD).toBe(2 ** 32 - 2)
  })

  test('the widest handle stays inside the safe integer range', () => {
    const widest = packEntity(MAX_ENTITY_ID, MAX_GENERATION, MAX_WORLD_ID)
    expect(widest).toBe(MAX_HANDLE)
    expect(Number.isSafeInteger(widest)).toBe(true)
  })
})

describe('reserved ids (§4.1)', () => {
  test('NULL_ENTITY is zero in every field', () => {
    expect(NULL_ENTITY).toBe(0)
    expect(entityId(NULL_ENTITY)).toBe(0)
    expect(entityGeneration(NULL_ENTITY)).toBe(0)
    expect(entityWorld(NULL_ENTITY)).toBe(0)
  })

  test('id 1 is the world entity and user ids start at 2', () => {
    expect(WORLD_ENTITY_ID).toBe(1)
    expect(FIRST_ENTITY_ID).toBe(2)
  })
})

describe('pack / unpack (§4.1)', () => {
  const cases: Array<[id: number, generation: number, world: number]> = [
    [1, 1, 0],
    [2, 1, 0],
    [7, 3, 1],
    [0xffff, 1, 255],
    [0x7fffffff, 4095, 0],
    [0x80000000, 1, 1],
    [MAX_ENTITY_ID, MAX_GENERATION, MAX_WORLD_ID],
  ]

  test.each(cases)('round trips id=%d generation=%d world=%d', (id, generation, world) => {
    const e = packEntity(id, generation, world)
    expect(entityId(e)).toBe(id)
    expect(entityGeneration(e)).toBe(generation)
    expect(entityWorld(e)).toBe(world)
  })

  test('the id field is decoded unsigned', () => {
    const e = packEntity(MAX_ENTITY_ID, 1, 1)
    expect(entityId(e)).toBe(4294967295)
    expect(entityId(e)).toBeGreaterThan(0)
  })

  test('the layout places id low, then generation, then world', () => {
    expect(packEntity(1, 0, 0)).toBe(1)
    expect(packEntity(0, 1, 0)).toBe(2 ** 32)
    expect(packEntity(0, 0, 1)).toBe(2 ** 44)
  })

  test('handles from different worlds never collide', () => {
    const a = packEntity(42, 1, 0)
    const b = packEntity(42, 1, 1)
    expect(a).not.toBe(b)
    expect(entityId(a)).toBe(entityId(b))
    expect(entityWorld(b) - entityWorld(a)).toBe(1)
  })

  test('a generation bump changes the handle but not the id', () => {
    const before = packEntity(9, 1, 3)
    const after = packEntity(9, 2, 3)
    expect(after).not.toBe(before)
    expect(entityId(after)).toBe(entityId(before))
    expect(entityGeneration(after)).toBe(2)
  })
})

describe('dev range checks (§12.2)', () => {
  test.runIf(__DEV__)('out-of-range fields throw in dev', () => {
    expect(() => packEntity(MAX_ENTITY_ID + 1, 1, 0)).toThrowError(/apecs/)
    expect(() => packEntity(1, GENERATION_COUNT, 0)).toThrowError(/apecs/)
    expect(() => packEntity(1, 1, MAX_WORLDS)).toThrowError(/apecs/)
    expect(() => packEntity(-1, 1, 0)).toThrowError(/apecs/)
    expect(() => packEntity(1.5, 1, 0)).toThrowError(/apecs/)
  })

  test.runIf(!__DEV__)('the checks are compiled out in prod', () => {
    expect(() => packEntity(1, GENERATION_COUNT, 0)).not.toThrow()
  })
})
