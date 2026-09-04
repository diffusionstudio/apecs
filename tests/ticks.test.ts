import { describe, expect, test } from 'vitest';

import { Changed, Trait, World } from '../src/index';
import type { Entity } from '../src/index';
import { columnOf, rowOf } from './support/columns';

const Level = new Trait({ value: 0 }, { track: true });
const Pair = new Trait({ x: 0, y: 0 }, { track: true });

describe('world.tick and world.step (§8.3)', () => {
  test('step increments the monotonic tick by one', () => {
    const world = new World();
    const start = world.tick;

    expect(Number.isInteger(start)).toBe(true);
    world.step();
    expect(world.tick).toBe(start + 1);
    world.step();
    expect(world.tick).toBe(start + 2);

    world.destroy();
  });

  test('ticks are per world', () => {
    const a = new World();
    const b = new World();
    const before = b.tick;

    a.step();
    a.step();

    expect(b.tick).toBe(before);

    a.destroy();
    b.destroy();
  });
});

describe('tracked-trait promotion (§8.3)', () => {
  test('track: true allocates tick storage from first use', () => {
    const world = new World();
    const e = world.spawn(Level);

    const column = columnOf(world, e, Level.value);
    expect(column.ticks).not.toBeNull();
    expect(column.ticks![0]).toBeInstanceOf(Uint32Array);
    expect(typeof column.lastWriteTick).toBe('number');

    world.destroy();
  });

  test('an untracked trait allocates no tick storage, even when written', () => {
    const Plain = new Trait({ value: 0 });
    const world = new World();
    const e = world.spawn(Plain);

    world.set(e, Plain.value, 5);

    expect(columnOf(world, e, Plain.value).ticks).toBeNull();

    world.destroy();
  });

  test('the first onChange subscription promotes the trait', () => {
    const Lazy = new Trait({ value: 0 });
    const world = new World();
    const e = world.spawn(Lazy);
    expect(columnOf(world, e, Lazy.value).ticks).toBeNull();

    world.onChange(Lazy, () => {});
    world.step();
    world.set(e, Lazy.value, 1);

    const column = columnOf(world, e, Lazy.value);
    expect(column.ticks).not.toBeNull();
    expect(column.ticks![0][rowOf(world, e)]).toBe(world.tick);

    world.destroy();
  });

  test('the first Changed() query promotes the trait', () => {
    const Lazy = new Trait({ value: 0 });
    const world = new World();
    const e = world.spawn(Lazy);
    expect(columnOf(world, e, Lazy.value).ticks).toBeNull();

    world.query(Lazy, Changed(Lazy));
    world.step();
    world.set(e, Lazy.value, 1);

    expect(columnOf(world, e, Lazy.value).ticks).not.toBeNull();

    world.destroy();
  });
});

describe('tick columns (§8.3)', () => {
  test('spawn initialisation stamps the current tick', () => {
    const world = new World();
    world.step();
    world.step();

    const e = world.spawn(Level({ value: 3 }));

    const column = columnOf(world, e, Level.value);
    expect(column.ticks![0][rowOf(world, e)]).toBe(world.tick);
    expect(column.lastWriteTick).toBe(world.tick);

    world.destroy();
  });

  test('a write stamps its own row and the column scalar', () => {
    const world = new World();
    const a = world.spawn(Level);
    const b = world.spawn(Level);
    world.step();

    world.set(a, Level.value, 9);

    const column = columnOf(world, a, Level.value);
    expect(column.ticks![0][rowOf(world, a)]).toBe(world.tick);
    expect(column.ticks![0][rowOf(world, b)]).toBe(world.tick - 1);
    expect(column.lastWriteTick).toBe(world.tick);

    world.destroy();
  });

  test('only the columns actually written bump their scalar', () => {
    const world = new World();
    const e = world.spawn(Pair);
    const x = columnOf(world, e, Pair.x);
    const y = columnOf(world, e, Pair.y);

    world.step();
    world.set(e, Pair.x, 1);
    expect(x.lastWriteTick).toBe(world.tick);
    expect(y.lastWriteTick).toBe(world.tick - 1);

    world.step();
    world.set(e, Pair, { y: 2 });
    expect(x.lastWriteTick).toBe(world.tick - 1);
    expect(y.lastWriteTick).toBe(world.tick);

    world.destroy();
  });

  test('a full-trait write bumps every column scalar', () => {
    const world = new World();
    const e = world.spawn(Pair);
    world.step();

    world.set(e, Pair, { x: 1, y: 2 });

    expect(columnOf(world, e, Pair.x).lastWriteTick).toBe(world.tick);
    expect(columnOf(world, e, Pair.y).lastWriteTick).toBe(world.tick);

    world.destroy();
  });

  test('tick pages parallel the data pages', () => {
    const world = new World({ pageSize: 4 });
    const batch = world.spawnMany(6, Level);

    const column = columnOf(world, batch[0] as Entity, Level.value);
    expect(column.pages).toHaveLength(2);
    expect(column.ticks).toHaveLength(2);
    expect(column.ticks![1]).toBeInstanceOf(Uint32Array);
    expect(column.ticks![1]).toHaveLength(4);

    world.destroy();
  });
});
