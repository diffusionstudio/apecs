import { describe, expect, test } from 'vitest';

import { EntityIndex, MAX_GENERATION } from '../src/internal';

describe('layout (§10.3)', () => {
  test('the index is three parallel typed arrays, no objects', () => {
    const index = new EntityIndex(64);

    expect(index.archetypes).toBeInstanceOf(Uint32Array);
    expect(index.rows).toBeInstanceOf(Uint32Array);
    expect(index.generations).toBeInstanceOf(Uint16Array);
    expect(index.archetypes).toHaveLength(index.capacity);
    expect(index.rows).toHaveLength(index.capacity);
    expect(index.generations).toHaveLength(index.capacity);
  });

  test('capacity is rounded up to a power of two', () => {
    expect(new EntityIndex(64).capacity).toBe(64);
    expect(new EntityIndex(65).capacity).toBe(128);
    expect(new EntityIndex(1).capacity).toBe(1);
  });

  test('a fresh index is zeroed', () => {
    const index = new EntityIndex(8);

    expect([...index.generations]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect([...index.rows]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  test('the generation field holds the full 12-bit range', () => {
    const index = new EntityIndex(8);
    index.generations[3] = MAX_GENERATION;

    expect(index.generations[3]).toBe(MAX_GENERATION);
  });
});

describe('liveness (§10.3, §4.1)', () => {
  test('liveness is a generation compare', () => {
    const index = new EntityIndex(8);
    index.generations[3] = 2;

    expect(index.isAlive(3, 2)).toBe(true);
    expect(index.isAlive(3, 1)).toBe(false);
    expect(index.isAlive(3, 3)).toBe(false);
  });

  test('generation 0 is never live, so a null handle is never alive', () => {
    const index = new EntityIndex(8);

    expect(index.isAlive(0, 0)).toBe(false);
    expect(index.isAlive(5, 0)).toBe(false);
  });

  test('an id past the end of the index is not alive', () => {
    const index = new EntityIndex(8);

    expect(index.isAlive(9999, 1)).toBe(false);
  });
});

describe('growth (§5.1, §10.3)', () => {
  test('the index grows past its initial size, doubling', () => {
    const index = new EntityIndex(8);

    index.ensure(8);

    expect(index.capacity).toBe(16);
    expect(index.generations).toHaveLength(16);
  });

  test('growth reaches the requested id in one step', () => {
    const index = new EntityIndex(8);

    index.ensure(5000);

    expect(index.capacity).toBe(8192);
  });

  test('growth preserves existing rows and zeroes the new ones', () => {
    const index = new EntityIndex(4);
    index.archetypes[2] = 7;
    index.rows[2] = 11;
    index.generations[2] = 3;

    index.ensure(100);

    expect(index.archetypes[2]).toBe(7);
    expect(index.rows[2]).toBe(11);
    expect(index.generations[2]).toBe(3);
    expect(index.generations[99]).toBe(0);
    expect(index.isAlive(2, 3)).toBe(true);
  });

  test('ensure does not reallocate when the id already fits', () => {
    const index = new EntityIndex(8);
    const { archetypes, rows, generations } = index;

    index.ensure(7);

    expect(index.archetypes).toBe(archetypes);
    expect(index.rows).toBe(rows);
    expect(index.generations).toBe(generations);
  });
});
