/**
 * The reactive core behind both bindings (SPEC-CLIENTS §C.3): cells that
 * recompute on a flush and commit only on a value change, interned per
 * subject and coalesced per frame.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';

import { Not, Relation, Trait, World, f32, str } from '../src/index';
import { $options } from '../src/internal';
import {
  childrenCell,
  fieldCell,
  hasCell,
  queryCell,
  queryFirstCell,
  targetCell,
  traitCell,
  type Cell,
} from '../src/reactive/cell';
import { setFlush } from '../src/reactive/scheduler';
import { CAN_MEASURE_HEAP, bytesPerPass } from './support/heap';

const Position = new Trait({ x: f32(0), y: f32(0) });
const Velocity = new Trait({ x: f32(0), y: f32(0) });
const Name = new Trait({ value: str('') });
const Transform = new Trait({ pos: { x: 0, y: 0 }, scale: 1 });
const Mesh = new Trait(() => ({ n: 0 }));
const IsActive = new Trait();
const Score = new Trait({ value: 0 });
const ChildOf = new Relation(undefined, { exclusive: true });
const Likes = new Relation({ amount: 0 });

const devOnly = test.runIf(__DEV__);

afterEach(() => {
  vi.unstubAllGlobals();
});

function syncWorld(): World {
  const world = new World();
  setFlush(world, 'sync');
  return world;
}

/** Subscribes and records what `value()` reads at each notification. */
function watch<V>(cell: Cell<V>): { seen: V[]; off: () => void } {
  const seen: V[] = [];
  const off = cell.subscribe(() => seen.push(cell.value()));
  return { seen, off };
}

/** Captures `requestAnimationFrame` requests so a test can pump them by hand. */
function fakeFrames(): (() => void)[] {
  const frames: (() => void)[] = [];
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => frames.push(fn));
  return frames;
}

describe('cell lifecycle (§C.3.1)', () => {
  test('a field cell reads the committed value and notifies after commit', () => {
    const world = syncWorld();
    const e = world.spawn(Position({ x: 1 }));
    const cell = fieldCell(world, e, Position.x);
    expect(cell.value()).toBe(1);

    const { seen } = watch(cell);
    world.set(e, Position.x, 2);

    expect(seen).toEqual([2]);
    expect(cell.value()).toBe(2);

    world.destroy();
  });

  test('value() before the first subscribe is computed once and held', () => {
    const world = syncWorld();
    const e = world.spawn(Position({ x: 1 }));
    const cell = fieldCell(world, e, Position.x);

    expect(cell.value()).toBe(1);
    world.set(e, Position.x, 5);
    expect(cell.value()).toBe(1);

    const { seen } = watch(cell);
    expect(seen).toEqual([]);
    expect(cell.value()).toBe(5);

    world.destroy();
  });

  test('the last unsubscribe releases the cell', () => {
    const world = syncWorld();
    const e = world.spawn(Position({ x: 1 }));
    const cell = fieldCell(world, e, Position.x);
    const a = watch(cell);
    const b = watch(cell);

    world.set(e, Position.x, 2);
    expect(a.seen).toEqual([2]);
    expect(b.seen).toEqual([2]);

    a.off();
    a.off();
    world.set(e, Position.x, 3);
    expect(a.seen).toEqual([2]);
    expect(b.seen).toEqual([2, 3]);

    b.off();
    world.set(e, Position.x, 4);
    expect(b.seen).toEqual([2, 3]);
    expect(cell.value()).toBe(3);
    expect(fieldCell(world, e, Position.x)).not.toBe(cell);

    world.destroy();
  });

  test('a listener may unsubscribe while being notified', () => {
    const world = syncWorld();
    const e = world.spawn(Position({ x: 1 }));
    const cell = fieldCell(world, e, Position.x);
    const calls: string[] = [];
    const offA = cell.subscribe(() => {
      calls.push('a');
      offA();
    });
    cell.subscribe(() => calls.push('b'));

    world.set(e, Position.x, 2);
    world.set(e, Position.x, 3);

    expect(calls).toEqual(['a', 'b', 'b']);

    world.destroy();
  });
});

describe('the value gate (§C.3.2)', () => {
  test('field: writing the same value notifies nobody', () => {
    const world = syncWorld();
    const e = world.spawn(Position({ x: 1 }), Name({ value: 'a' }));
    const x = watch(fieldCell(world, e, Position.x));
    const name = watch(fieldCell(world, e, Name.value));

    world.set(e, Position.x, 1);
    world.set(e, Position, { x: 1 });
    world.accessor(Position.x).set(e, 1);
    world.set(e, Name.value, 'a');
    expect(x.seen).toEqual([]);
    expect(name.seen).toEqual([]);

    world.set(e, Position.x, 2);
    world.set(e, Name.value, 'b');
    expect(x.seen).toEqual([2]);
    expect(name.seen).toEqual(['b']);

    world.destroy();
  });

  test('trait: identity is stable until a field differs, and the old copy is left alone', () => {
    const world = syncWorld();
    const e = world.spawn(Position({ x: 1 }));
    const cell = traitCell(world, e, Position);
    const { seen } = watch(cell);
    const before = cell.value();
    expect(before).toEqual({ x: 1, y: 0 });

    world.set(e, Position, { x: 1 });
    world.set(e, Position.y, 0);
    expect(seen).toEqual([]);
    expect(cell.value()).toBe(before);

    world.set(e, Position.x, 3);
    expect(seen).toHaveLength(1);
    expect(cell.value()).not.toBe(before);
    expect(cell.value()).toEqual({ x: 3, y: 0 });
    expect(before).toEqual({ x: 1, y: 0 });

    world.destroy();
  });

  test('trait: nested fields are compared field-wise', () => {
    const world = syncWorld();
    const e = world.spawn(Transform({ pos: { x: 1, y: 2 } }));
    const cell = traitCell(world, e, Transform);
    const { seen } = watch(cell);
    const before = cell.value();

    world.set(e, Transform, { pos: { x: 1 } });
    world.set(e, Transform.scale, 1);
    expect(seen).toEqual([]);
    expect(cell.value()).toBe(before);

    world.set(e, Transform['pos.y'], 5);
    expect(seen).toEqual([{ pos: { x: 1, y: 5 }, scale: 1 }]);
    expect(before).toEqual({ pos: { x: 1, y: 2 }, scale: 1 });

    world.destroy();
  });

  test('trait: an AoS value is gated on reference identity', () => {
    const world = syncWorld();
    const mesh = { n: 1 };
    const e = world.spawn(Mesh(mesh));
    const cell = traitCell(world, e, Mesh);
    const { seen } = watch(cell);
    expect(cell.value()).toBe(mesh);

    world.set(e, Mesh, mesh);
    expect(seen).toEqual([]);

    const next = { n: 2 };
    world.set(e, Mesh, next);
    expect(seen).toEqual([next]);
    expect(cell.value()).toBe(next);

    world.destroy();
  });

  test('has: only a real gain or loss notifies', () => {
    const world = syncWorld();
    const e = world.spawn(Position);
    const { seen } = watch(hasCell(world, e, IsActive));

    world.add(e, IsActive);
    world.add(e, IsActive);
    expect(seen).toEqual([true]);

    world.remove(e, IsActive);
    world.remove(e, IsActive);
    expect(seen).toEqual([true, false]);

    world.destroy();
  });

  test('has: a pair and an exclusive target are checked against the target', () => {
    const world = syncWorld();
    const a = world.spawn();
    const b = world.spawn();
    const e = world.spawn();
    const likesA = watch(hasCell(world, e, Likes(a)));
    const childOfA = watch(hasCell(world, e, ChildOf(a)));
    const childOf = watch(hasCell(world, e, ChildOf));

    world.add(e, Likes(b));
    world.add(e, ChildOf(b));
    expect(likesA.seen).toEqual([]);
    expect(childOfA.seen).toEqual([]);
    expect(childOf.seen).toEqual([true]);

    world.add(e, Likes(a));
    world.add(e, ChildOf(a));
    expect(likesA.seen).toEqual([true]);
    expect(childOfA.seen).toEqual([true]);
    expect(childOf.seen).toEqual([true]);

    world.add(e, ChildOf(b));
    expect(childOfA.seen).toEqual([true, false]);
    expect(childOf.seen).toEqual([true]);

    world.destroy();
  });

  test('target: retargeting notifies, re-adding the same target does not', () => {
    const world = syncWorld();
    const a = world.spawn();
    const b = world.spawn();
    const e = world.spawn();
    const cell = targetCell(world, e, ChildOf);
    const { seen } = watch(cell);
    expect(cell.value()).toBeUndefined();

    world.add(e, ChildOf(a));
    world.add(e, ChildOf(a));
    expect(seen).toEqual([a]);

    world.add(e, ChildOf(b));
    expect(seen).toEqual([a, b]);

    world.remove(e, ChildOf);
    expect(seen).toEqual([a, b, undefined]);

    world.destroy();
  });

  test('query: a leave and re-enter within one frame is no change', () => {
    const world = new World();
    const frames = fakeFrames();
    const e = world.spawn(Position, IsActive);
    const cell = queryCell(world, [Position, IsActive]);
    const { seen } = watch(cell);
    const before = cell.value();
    expect(before).toEqual([e]);

    world.remove(e, IsActive);
    world.add(e, IsActive);
    expect(frames).toHaveLength(1);
    frames[0]();

    expect(seen).toEqual([]);
    expect(cell.value()).toBe(before);

    world.destroy();
  });

  test('query: membership changes commit a new array', () => {
    const world = syncWorld();
    const a = world.spawn(Position);
    const cell = queryCell(world, [Position, Not(IsActive)]);
    const { seen } = watch(cell);
    expect(cell.value()).toEqual([a]);

    const b = world.spawn(Position);
    expect(seen).toHaveLength(1);
    expect([...cell.value()].sort()).toEqual([a, b].sort());

    world.add(b, IsActive);
    expect(seen).toHaveLength(2);
    expect(cell.value()).toEqual([a]);

    world.despawn(a);
    expect(seen).toHaveLength(3);
    expect(cell.value()).toEqual([]);

    world.destroy();
  });

  test('query first: churn behind the first entity notifies nobody', () => {
    const world = syncWorld();
    const a = world.spawn(Position);
    const b = world.spawn(Position);
    const cell = queryFirstCell(world, [Position]);
    const { seen } = watch(cell);
    const first = cell.value();
    expect(first === a || first === b).toBe(true);

    const other = first === a ? b : a;
    world.despawn(other);
    world.add(first!, Velocity);
    expect(seen).toEqual([]);
    expect(cell.value()).toBe(first);

    world.despawn(first!);
    expect(seen).toEqual([undefined]);

    world.destroy();
  });

  test('children: reparenting moves the child between two cells', () => {
    const world = syncWorld();
    const a = world.spawn();
    const b = world.spawn();
    const childrenOfA = watch(childrenCell(world, a, ChildOf));
    const childrenOfB = watch(childrenCell(world, b, ChildOf));
    expect(childrenCell(world, a, ChildOf).value()).toEqual([]);

    const c = world.spawn(ChildOf(a));
    world.add(c, ChildOf(a));
    expect(childrenOfA.seen).toEqual([[c]]);
    expect(childrenOfB.seen).toEqual([]);

    world.add(c, ChildOf(b));
    expect(childrenOfA.seen).toEqual([[c], []]);
    expect(childrenOfB.seen).toEqual([[c]]);

    world.remove(c, ChildOf);
    expect(childrenOfB.seen).toEqual([[c], []]);

    world.destroy();
  });

  test('children: a target query through queryCell tracks retargets too', () => {
    const world = syncWorld();
    const a = world.spawn();
    const b = world.spawn();
    const c = world.spawn(ChildOf(a));
    const cell = queryCell(world, [ChildOf(a)]);
    const { seen } = watch(cell);
    expect(cell.value()).toEqual([c]);

    world.add(c, ChildOf(b));
    expect(seen).toEqual([[]]);

    world.destroy();
  });
});

describe('dead entities (§C.4.2)', () => {
  test('every per-entity cell falls to its empty value on despawn', () => {
    const world = syncWorld();
    const parent = world.spawn();
    const e = world.spawn(Position({ x: 1 }), IsActive, ChildOf(parent));
    const field = watch(fieldCell(world, e, Position.x));
    const trait = watch(traitCell(world, e, Position));
    const has = watch(hasCell(world, e, IsActive));
    const target = watch(targetCell(world, e, ChildOf));
    const children = watch(childrenCell(world, parent, ChildOf));

    world.despawn(e);

    expect(field.seen).toEqual([undefined]);
    expect(trait.seen).toEqual([undefined]);
    expect(has.seen).toEqual([false]);
    expect(target.seen).toEqual([undefined]);
    expect(children.seen).toEqual([[]]);

    world.destroy();
  });

  test('a cell made for a dead entity is inert', () => {
    const world = syncWorld();
    const e = world.spawn(Position);
    world.despawn(e);

    expect(fieldCell(world, e, Position.x).value()).toBeUndefined();
    expect(traitCell(world, e, Position).value()).toBeUndefined();
    expect(hasCell(world, e, Position).value()).toBe(false);
    expect(targetCell(world, e, ChildOf).value()).toBeUndefined();
    expect(childrenCell(world, e, ChildOf).value()).toEqual([]);
    expect(fieldCell(world, e, Position.x).subscribe(() => {})).toBeTypeOf('function');

    world.destroy();
  });

  test('an entity without the trait reads undefined until it gains it', () => {
    const world = syncWorld();
    const e = world.spawn();
    const cell = fieldCell(world, e, Position.x);
    const { seen } = watch(cell);
    expect(cell.value()).toBeUndefined();

    world.add(e, Position({ x: 4 }));
    expect(seen).toEqual([4]);

    world.remove(e, Position);
    expect(seen).toEqual([4, undefined]);

    world.destroy();
  });

  test('a world destroyed under a live subscription flushes to empty without throwing', async () => {
    const world = new World();
    setFlush(world, 'microtask');
    const e = world.spawn(Position({ x: 1 }));
    const field = watch(fieldCell(world, e, Position.x));
    const query = watch(queryCell(world, [Position]));
    const first = watch(queryFirstCell(world, [Position]));

    world.destroy();
    await Promise.resolve();

    expect(field.seen).toEqual([undefined]);
    expect(query.seen).toEqual([[]]);
    expect(first.seen).toEqual([undefined]);
    expect(hasCell(world, world.entity, Score).value()).toBe(false);
  });

  test('world traits are cells on the world entity', () => {
    const world = syncWorld();
    const field = watch(fieldCell(world, world.entity, Score.value));
    const has = watch(hasCell(world, world.entity, Score));

    world.add(Score({ value: 1 }));
    world.set(Score.value, 2);
    world.set(Score.value, 2);

    expect(has.seen).toEqual([true]);
    expect(field.seen).toEqual([1, 2]);

    world.destroy();
  });
});

describe('flush modes (§C.3.3)', () => {
  test('frame: many writes, one frame, one notification', () => {
    const world = new World();
    const frames = fakeFrames();
    const e = world.spawn(Position);
    const { seen } = watch(fieldCell(world, e, Position.x));

    for (let i = 1; i <= 10; i++) {
      world.set(e, Position.x, i);
    }
    expect(seen).toEqual([]);
    expect(frames).toHaveLength(1);

    frames[0]();
    expect(seen).toEqual([10]);
    expect(frames).toHaveLength(1);

    world.set(e, Position.x, 11);
    expect(frames).toHaveLength(2);

    world.destroy();
  });

  test('frame: nothing is scheduled without a write', () => {
    const world = new World();
    const frames = fakeFrames();
    const e = world.spawn(Position);
    watch(fieldCell(world, e, Position.x));
    watch(queryCell(world, [Position]));

    expect(frames).toHaveLength(0);

    world.destroy();
  });

  test('frame: an unchanged write schedules a flush that notifies nobody', () => {
    const world = new World();
    const frames = fakeFrames();
    const e = world.spawn(Position({ x: 1 }));
    const { seen } = watch(fieldCell(world, e, Position.x));

    world.set(e, Position.x, 1);
    expect(frames).toHaveLength(1);
    frames[0]();

    expect(seen).toEqual([]);

    world.destroy();
  });

  test('frame: cells dirtied during a flush ride the same flush', () => {
    const world = new World();
    const frames = fakeFrames();
    const e = world.spawn(Position, Velocity);
    const vx = watch(fieldCell(world, e, Velocity.x));
    const px = fieldCell(world, e, Position.x);
    px.subscribe(() => world.set(e, Velocity.x, px.value()!));

    world.set(e, Position.x, 7);
    frames[0]();

    expect(vx.seen).toEqual([7]);

    world.destroy();
  });

  test('frame degrades to microtask without requestAnimationFrame', async () => {
    vi.stubGlobal('requestAnimationFrame', undefined);
    const world = new World();
    const e = world.spawn(Position);
    const { seen } = watch(fieldCell(world, e, Position.x));

    world.set(e, Position.x, 1);
    world.set(e, Position.x, 2);
    expect(seen).toEqual([]);
    await Promise.resolve();

    expect(seen).toEqual([2]);

    world.destroy();
  });

  test('microtask: coalesced to the end of the turn', async () => {
    const world = new World();
    const frames = fakeFrames();
    setFlush(world, 'microtask');
    const e = world.spawn(Position);
    const { seen } = watch(fieldCell(world, e, Position.x));

    world.set(e, Position.x, 1);
    world.set(e, Position.x, 2);
    expect(seen).toEqual([]);
    await Promise.resolve();

    expect(seen).toEqual([2]);
    expect(frames).toHaveLength(0);

    world.destroy();
  });

  test('sync: notified inside the write', () => {
    const world = syncWorld();
    const e = world.spawn(Position);
    const { seen } = watch(fieldCell(world, e, Position.x));

    world.set(e, Position.x, 1);
    expect(seen).toEqual([1]);
    world.set(e, Position.x, 2);
    expect(seen).toEqual([1, 2]);

    world.destroy();
  });

  test('sync: removals and despawns are observed after the operation', () => {
    const world = syncWorld();
    const parent = world.spawn();
    const a = world.spawn(Position, ChildOf(parent));
    const b = world.spawn(Position);
    const has = watch(hasCell(world, a, Position));
    const query = watch(queryCell(world, [Position]));
    const children = watch(childrenCell(world, parent, ChildOf));

    world.remove(a, Position);
    expect(has.seen).toEqual([false]);
    expect(query.seen).toEqual([[b]]);

    world.despawn(a);
    expect(children.seen).toEqual([[]]);

    world.despawn(b);
    expect(query.seen).toEqual([[b], []]);

    world.destroy();
  });

  test('switching to sync flushes what is pending', () => {
    const world = new World();
    fakeFrames();
    const e = world.spawn(Position);
    const { seen } = watch(fieldCell(world, e, Position.x));

    world.set(e, Position.x, 1);
    expect(seen).toEqual([]);
    setFlush(world, 'sync');

    expect(seen).toEqual([1]);

    world.destroy();
  });

  test('the mode is per world', () => {
    const a = syncWorld();
    const b = new World();
    const frames = fakeFrames();
    const ea = a.spawn(Position);
    const eb = b.spawn(Position);
    const seenA = watch(fieldCell(a, ea, Position.x)).seen;
    const seenB = watch(fieldCell(b, eb, Position.x)).seen;

    a.set(ea, Position.x, 1);
    b.set(eb, Position.x, 1);

    expect(seenA).toEqual([1]);
    expect(seenB).toEqual([]);
    expect(frames).toHaveLength(1);

    a.destroy();
    b.destroy();
  });
});

describe('dispatch and sharing (§C.3.4, §C.3.5)', () => {
  test('cells intern on the subject', () => {
    const world = syncWorld();
    const e = world.spawn(Position);
    const parent = world.spawn();
    const px = fieldCell(world, e, Position.x);
    px.subscribe(() => {});

    expect(fieldCell(world, e, Position.x)).toBe(px);
    expect(fieldCell(world, e, Position.y)).not.toBe(px);
    expect(traitCell(world, e, Position)).toBe(traitCell(world, e, Position));
    expect(traitCell(world, e, Position)).not.toBe(hasCell(world, e, Position));
    expect(hasCell(world, e, ChildOf(parent))).toBe(hasCell(world, e, ChildOf(parent)));
    expect(hasCell(world, e, ChildOf(parent))).not.toBe(hasCell(world, e, ChildOf));
    expect(hasCell(world, e, Likes(parent))).toBe(hasCell(world, e, Likes(parent)));
    expect(queryCell(world, [Position, Not(IsActive)])).toBe(
      queryCell(world, [Position, Not(IsActive)]),
    );
    expect(queryFirstCell(world, [Position])).not.toBe(queryCell(world, [Position]));
    expect(childrenCell(world, parent, ChildOf)).toBe(childrenCell(world, parent, ChildOf));

    world.destroy();
  });

  test('a shared cell recomputes once and notifies every listener', () => {
    const world = syncWorld();
    const e = world.spawn(Position);
    const cell = traitCell(world, e, Position);
    const listeners = Array.from({ length: 5 }, () => watch(cell));

    world.set(e, Position.x, 1);

    const first = listeners[0].seen[0];
    for (const { seen } of listeners) {
      expect(seen).toHaveLength(1);
      expect(seen[0]).toBe(first);
    }

    world.destroy();
  });

  test('only value cells promote the trait to tracked', () => {
    const Local = new Trait({ n: 0 });
    const world = syncWorld();
    const e = world.spawn(Local);

    const off = hasCell(world, e, Local).subscribe(() => {});
    expect(Local[$options].track).toBe(false);
    off();

    fieldCell(world, e, Local.n).subscribe(() => {});
    expect(Local[$options].track).toBe(true);

    world.destroy();
  });

  test('unrelated writes and entities cost no notification', () => {
    const world = syncWorld();
    const e = world.spawn(Position, Velocity);
    const other = world.spawn(Position);
    const { seen } = watch(fieldCell(world, e, Position.x));

    world.set(e, Velocity.x, 1);
    world.set(other, Position.x, 1);
    world.despawn(other);

    expect(seen).toEqual([]);

    world.destroy();
  });
});

describe('read-only values (§C.4.6)', () => {
  devOnly('dev builds freeze the committed copy', () => {
    const world = syncWorld();
    const e = world.spawn(Transform, Position);
    const transform = traitCell(world, e, Transform).value()!;
    const entities = queryCell(world, [Position]).value();

    expect(Object.isFrozen(transform)).toBe(true);
    expect(Object.isFrozen(transform.pos)).toBe(true);
    expect(Object.isFrozen(entities)).toBe(true);

    world.destroy();
  });

  test('an AoS reference is handed out as-is', () => {
    const world = syncWorld();
    const mesh = { n: 1 };
    const e = world.spawn(Mesh(mesh));

    expect(Object.isFrozen(traitCell(world, e, Mesh).value())).toBe(false);

    world.destroy();
  });
});

describe('allocation (§C.3.2)', () => {
  const it = test.skipIf(!CAN_MEASURE_HEAP);

  it('an unchanged trait write recomputes without allocating', () => {
    const WRITES = 1000;
    const world = syncWorld();
    const e = world.spawn(Transform({ pos: { x: 1, y: 2 } }));
    const cell = traitCell(world, e, Transform);
    let notified = 0;
    cell.subscribe(() => notified++);

    const bytes = bytesPerPass(100, () => {
      for (let i = 0; i < WRITES; i++) {
        world.set(e, Transform.scale, 1);
      }
    });

    expect(notified).toBe(0);
    // A boxed handle or a fresh copy per write would be 16 bytes or more.
    expect(bytes / WRITES).toBeLessThan(2);

    world.destroy();
  });
});
