/**
 * apecs/solid (SPEC-CLIENTS §C.6): each factory is a signal over a cell, so
 * these tests assert what Solid's graph sees — a run of an effect per real
 * change, none for a write that changes nothing — and the owner-bound
 * lifetime of every subscription.
 */
import { createEffect, createRoot } from 'solid-js';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { Not, Relation, Trait, World, f32, str, type Entity } from '../../src/index';
import { fieldCell } from '../../src/reactive/cell';
import { schedulerOf, type Flush } from '../../src/reactive/scheduler';
import {
  WorldProvider,
  createAccessor,
  createChildren,
  createEntity,
  createField,
  createHas,
  createParent,
  createQuery,
  createQueryFirst,
  createSortedQuery,
  createSortedQueryFirst,
  createTag,
  createTarget,
  createTrait,
  on,
  useWorld,
} from '../../src/solid/index';

const Position = new Trait({ x: f32(0), y: f32(0) });
const Velocity = new Trait({ x: f32(0), y: f32(0) });
const Name = new Trait({ value: str('') });
const IsActive = new Trait();
const Score = new Trait({ value: 0 });
const SortIndex = new Trait({ value: 0 });
const ChildOf = new Relation(undefined, { exclusive: true });

const devOnly = test.runIf(__DEV__);

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Mounted<T> {
  result: T;
  dispose: () => void;
}

/** Runs `body` under a provider, as a component body runs under one in JSX. `null` omits the prop. */
function mount<T>(world: World, body: () => T, flush: Flush | null = 'sync'): Mounted<T> {
  return createRoot((dispose) => {
    let result!: T;
    WorldProvider({
      world,
      flush: flush ?? undefined,
      get children() {
        result = body();
        return undefined;
      },
    });
    return { result, dispose };
  });
}

/** Records what an effect over `read` sees on each run. */
function observe<V>(read: () => V): V[] {
  const seen: V[] = [];
  createEffect(() => {
    seen.push(read());
  });
  return seen;
}

/** Captures `requestAnimationFrame` requests so a test can pump them by hand. */
function fakeFrames(): (() => void)[] {
  const frames: (() => void)[] = [];
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => frames.push(fn));
  return frames;
}

/** Three entities keyed 1, 2, 3, spawned out of order. */
function keyed(world: World): [Entity, Entity, Entity] {
  const c = world.spawn(SortIndex({ value: 3 }), Position);
  const a = world.spawn(SortIndex({ value: 1 }), Position);
  const b = world.spawn(SortIndex({ value: 2 }), Position);
  return [a, b, c];
}

function sorted(entities: readonly Entity[]): Entity[] {
  return [...entities].sort((a, b) => a - b);
}

describe('WorldProvider and useWorld (§C.4.1, §C.5.1)', () => {
  test('useWorld throws outside a provider', () => {
    expect(() => createRoot(() => useWorld())).toThrow(/WorldProvider/);
  });

  test('useWorld returns the provided world', () => {
    const world = new World();
    const { result, dispose } = mount(world, () => useWorld());

    expect(result).toBe(world);

    dispose();
    world.destroy();
  });

  test('the flush prop configures the world, and defaults to frame', () => {
    const a = new World();
    const b = new World();
    const mountedA = mount(a, () => undefined);
    const mountedB = mount(b, () => undefined, null);

    expect(schedulerOf(a).mode).toBe('sync');
    expect(schedulerOf(b).mode).toBe('frame');

    mountedA.dispose();
    mountedB.dispose();
    a.destroy();
    b.destroy();
  });

  devOnly('an unknown flush mode is rejected', () => {
    const world = new World();

    expect(() => mount(world, () => undefined, 'never' as Flush)).toThrow(/flush/);

    world.destroy();
  });
});

describe('createField (§C.3.2, §C.4.6)', () => {
  test('tracks the field and runs nothing for a write that changes nothing', () => {
    const world = new World();
    const e = world.spawn(Position({ x: 1 }), Name({ value: 'a' }));
    const { result, dispose } = mount(world, () => ({
      x: observe(createField(e, Position.x)),
      name: observe(createField(e, Name.value)),
    }));
    expect(result.x).toEqual([1]);
    expect(result.name).toEqual(['a']);

    world.set(e, Position.x, 1);
    world.set(e, Position, { x: 1 });
    world.accessor(Position.x).set(e, 1);
    world.set(e, Name.value, 'a');
    expect(result.x).toEqual([1]);
    expect(result.name).toEqual(['a']);

    world.set(e, Position.x, 2);
    world.set(e, Name.value, 'b');
    expect(result.x).toEqual([1, 2]);
    expect(result.name).toEqual(['a', 'b']);

    dispose();
    world.destroy();
  });

  test('the entity-less overload reads the world trait', () => {
    const world = new World();
    world.add(Score({ value: 1 }));
    const { result, dispose } = mount(world, () => observe(createField(Score.value)));
    expect(result).toEqual([1]);

    world.set(Score.value, 1);
    world.set(Score.value, 2);
    expect(result).toEqual([1, 2]);

    dispose();
    world.destroy();
  });

  test('reads undefined without the trait, before it is gained and after it is lost', () => {
    const world = new World();
    const e = world.spawn();
    const { result, dispose } = mount(world, () => observe(createField(e, Position.x)));
    expect(result).toEqual([undefined]);

    world.add(e, Position({ x: 4 }));
    expect(result).toEqual([undefined, 4]);

    world.despawn(e);
    expect(result).toEqual([undefined, 4, undefined]);

    dispose();
    world.destroy();
  });

  test('a dead entity reads undefined and never wakes', () => {
    const world = new World();
    const e = world.spawn(Position);
    world.despawn(e);
    const { result, dispose } = mount(world, () => observe(createField(e, Position.x)));

    world.spawn(Position({ x: 3 }));
    expect(result).toEqual([undefined]);

    dispose();
    world.destroy();
  });

  test('readers under one provider share one cell, and dispose releases it', () => {
    const world = new World();
    const e = world.spawn(Position);
    const { result, dispose } = mount(world, () => ({
      a: observe(createField(e, Position.x)),
      b: observe(createField(e, Position.x)),
      cell: fieldCell(world, e, Position.x),
    }));

    expect(fieldCell(world, e, Position.x)).toBe(result.cell);
    world.set(e, Position.x, 1);
    expect(result.a).toEqual([0, 1]);
    expect(result.b).toEqual([0, 1]);

    dispose();
    world.set(e, Position.x, 2);
    expect(result.a).toEqual([0, 1]);
    expect(fieldCell(world, e, Position.x)).not.toBe(result.cell);

    world.destroy();
  });
});

describe('createTrait (§C.3.2)', () => {
  test('identity is stable until a field differs', () => {
    const world = new World();
    const e = world.spawn(Position({ x: 1 }));
    const { result, dispose } = mount(world, () => observe(createTrait(e, Position)));
    expect(result).toEqual([{ x: 1, y: 0 }]);

    world.set(e, Position, { x: 1 });
    world.set(e, Position.y, 0);
    expect(result).toHaveLength(1);

    world.set(e, Position.x, 3);
    expect(result).toHaveLength(2);
    expect(result[1]).not.toBe(result[0]);
    expect(result[1]).toEqual({ x: 3, y: 0 });
    expect(result[0]).toEqual({ x: 1, y: 0 });

    dispose();
    world.destroy();
  });

  test('the entity-less overload reads the world trait', () => {
    const world = new World();
    const { result, dispose } = mount(world, () => observe(createTrait(Score)));
    expect(result).toEqual([undefined]);

    world.add(Score({ value: 5 }));
    expect(result).toEqual([undefined, { value: 5 }]);

    dispose();
    world.destroy();
  });

  devOnly('the committed copy is frozen', () => {
    const world = new World();
    const e = world.spawn(Position);
    const { result, dispose } = mount(world, () => createTrait(e, Position)());

    expect(Object.isFrozen(result)).toBe(true);

    dispose();
    world.destroy();
  });
});

describe('createHas and createTag (§C.5.2)', () => {
  test('only a real gain or loss runs the effect', () => {
    const world = new World();
    const e = world.spawn(Position);
    const { result, dispose } = mount(world, () => ({
      has: observe(createHas(e, Position)),
      tag: observe(createTag(e, IsActive)),
    }));
    expect(result.has).toEqual([true]);
    expect(result.tag).toEqual([false]);

    world.add(e, IsActive);
    world.add(e, IsActive);
    world.add(e, Position);
    expect(result.tag).toEqual([false, true]);
    expect(result.has).toEqual([true]);

    world.remove(e, IsActive);
    world.remove(e, Position);
    expect(result.tag).toEqual([false, true, false]);
    expect(result.has).toEqual([true, false]);

    dispose();
    world.destroy();
  });

  test('a pair is checked against its target', () => {
    const world = new World();
    const a = world.spawn();
    const b = world.spawn();
    const e = world.spawn();
    const { result, dispose } = mount(world, () => observe(createHas(e, ChildOf(a))));

    world.add(e, ChildOf(b));
    expect(result).toEqual([false]);

    world.add(e, ChildOf(a));
    expect(result).toEqual([false, true]);

    dispose();
    world.destroy();
  });

  test('the entity-less overloads read the world trait', () => {
    const world = new World();
    const { result, dispose } = mount(world, () => ({
      has: observe(createHas(Score)),
      tag: observe(createTag(IsActive)),
    }));

    world.add(Score({ value: 1 }), IsActive);
    expect(result.has).toEqual([false, true]);
    expect(result.tag).toEqual([false, true]);

    dispose();
    world.destroy();
  });

  devOnly('createTag rejects a trait that carries data', () => {
    const world = new World();
    const e = world.spawn(Position);

    expect(() => mount(world, () => createTag(e, Position))).toThrow(/createHas/);
    expect(() => mount(world, () => createTag(Score))).toThrow(/createHas/);

    world.destroy();
  });
});

describe('queries (§C.4.3, §C.4.4)', () => {
  test('createQuery follows membership and ignores a leave-and-return', () => {
    const world = new World();
    const a = world.spawn(Position);
    const { result, dispose } = mount(world, () => observe(createQuery(Position, Not(IsActive))));
    expect(result).toEqual([[a]]);

    const b = world.spawn(Position);
    expect(result).toHaveLength(2);
    expect(sorted(result[1])).toEqual(sorted([a, b]));

    world.add(b, IsActive);
    expect(result).toHaveLength(3);
    expect(result[2]).toEqual([a]);

    world.set(a, Position.x, 1);
    world.add(a, Velocity);
    expect(result).toHaveLength(3);

    world.despawn(a);
    expect(result[3]).toEqual([]);

    dispose();
    world.destroy();
  });

  test('createQueryFirst is silent while the first entity stays', () => {
    const world = new World();
    const a = world.spawn(Position);
    const b = world.spawn(Position);
    const { result, dispose } = mount(world, () => observe(createQueryFirst(Position)));
    const first = result[0]!;
    expect(first === a || first === b).toBe(true);

    world.despawn(first === a ? b : a);
    world.add(first, Velocity);
    expect(result).toEqual([first]);

    world.despawn(first);
    expect(result).toEqual([first, undefined]);

    dispose();
    world.destroy();
  });

  test('equal terms on every call resolve to one shared cell', () => {
    const world = new World();
    world.spawn(Position);
    const { result, dispose } = mount(world, () => {
      const a = observe(createQuery(Position, Not(IsActive)));
      const b = observe(createQuery(Position, Not(IsActive)));
      return { a, b };
    });

    world.spawn(Position);
    expect(result.a).toHaveLength(2);
    expect(result.b).toHaveLength(2);
    expect(result.a[1]).toBe(result.b[1]);

    dispose();
    world.destroy();
  });
});

describe('sorted queries (§C.3.6)', () => {
  test('createSortedQuery runs only when the order changes', () => {
    const world = new World();
    const [a, b, c] = keyed(world);
    const { result, dispose } = mount(world, () =>
      observe(createSortedQuery([SortIndex], SortIndex.value)),
    );
    expect(result).toEqual([[a, b, c]]);

    world.set(b, SortIndex.value, 2.5);
    world.set(a, SortIndex.value, -1);
    expect(result).toHaveLength(1);

    world.set(c, SortIndex.value, 0);
    expect(result).toEqual([
      [a, b, c],
      [a, c, b],
    ]);

    const d = world.spawn(SortIndex({ value: 1.5 }));
    expect(result[2]).toEqual([a, c, d, b]);

    dispose();
    world.destroy();
  });

  test('direction defaults to ascending and descending reverses it', () => {
    const world = new World();
    const [a, b, c] = keyed(world);
    const { result, dispose } = mount(world, () => ({
      asc: createSortedQuery([SortIndex], SortIndex.value)(),
      explicit: createSortedQuery([SortIndex], SortIndex.value, 'asc')(),
      desc: createSortedQuery([SortIndex], SortIndex.value, 'desc')(),
    }));

    expect(result.asc).toEqual([a, b, c]);
    expect(result.explicit).toBe(result.asc);
    expect(result.desc).toEqual([c, b, a]);

    dispose();
    world.destroy();
  });

  test('createSortedQueryFirst runs only for a new leader', () => {
    const world = new World();
    const [a, b, c] = keyed(world);
    const { result, dispose } = mount(world, () =>
      observe(createSortedQueryFirst([SortIndex], SortIndex.value)),
    );
    expect(result).toEqual([a]);

    world.set(c, SortIndex.value, 1.5);
    world.spawn(SortIndex({ value: 7 }));
    world.despawn(b);
    expect(result).toEqual([a]);

    world.set(c, SortIndex.value, 0);
    expect(result).toEqual([a, c]);

    dispose();
    world.destroy();
  });
});

describe('relations (§C.5.2)', () => {
  test('createTarget and createParent follow retargets', () => {
    const world = new World();
    const a = world.spawn();
    const b = world.spawn();
    const e = world.spawn();
    const { result, dispose } = mount(world, () => ({
      target: observe(createTarget(e, ChildOf)),
      parent: observe(createParent(e, ChildOf)),
    }));
    expect(result.target).toEqual([undefined]);

    world.add(e, ChildOf(a));
    world.add(e, ChildOf(a));
    world.add(e, ChildOf(b));
    world.remove(e, ChildOf);
    expect(result.target).toEqual([undefined, a, b, undefined]);
    expect(result.parent).toEqual(result.target);

    dispose();
    world.destroy();
  });

  test('createChildren lists the entities targeting the parent', () => {
    const world = new World();
    const a = world.spawn();
    const b = world.spawn();
    const { result, dispose } = mount(world, () => ({
      ofA: observe(createChildren(a, ChildOf)),
      ofB: observe(createChildren(b, ChildOf)),
    }));
    expect(result.ofA).toEqual([[]]);

    const c = world.spawn(ChildOf(a));
    expect(result.ofA).toEqual([[], [c]]);
    expect(result.ofB).toEqual([[]]);

    world.add(c, ChildOf(b));
    expect(result.ofA).toEqual([[], [c], []]);
    expect(result.ofB).toEqual([[], [c]]);

    dispose();
    world.destroy();
  });
});

describe('createAccessor and createEntity (§C.5.3)', () => {
  test('createAccessor is the memoised accessor, and creates no subscription', () => {
    const world = new World();
    const e = world.spawn(Position);
    const { result, dispose } = mount(world, () => ({
      accessor: createAccessor(Position.x),
      x: observe(createField(e, Position.x)),
    }));
    expect(result.accessor).toBe(world.accessor(Position.x));

    result.accessor.set(e, 4);
    expect(result.accessor.get(e)).toBe(4);
    expect(result.x).toEqual([0, 4]);

    dispose();
    world.destroy();
  });

  test('createEntity spawns with its items and despawns on dispose', () => {
    const world = new World();
    const { result, dispose } = mount(world, () => createEntity(Position({ x: 2 }), IsActive));

    expect(world.isAlive(result)).toBe(true);
    expect(world.get(result, Position.x)).toBe(2);
    expect(world.has(result, IsActive)).toBe(true);

    dispose();
    expect(world.isAlive(result)).toBe(false);

    world.destroy();
  });

  test('dispose tolerates an entity already despawned, and a world already destroyed', () => {
    const early = new World();
    const a = mount(early, () => createEntity(Position));
    early.despawn(a.result);
    expect(() => a.dispose()).not.toThrow();
    early.destroy();

    const gone = new World();
    const b = mount(gone, () => createEntity(Position));
    gone.destroy();
    expect(() => b.dispose()).not.toThrow();
  });
});

describe('imperative subscriptions (§C.7)', () => {
  test('fire inside the write, ungated and uncoalesced', () => {
    const world = new World();
    const frames = fakeFrames();
    const e = world.spawn(Velocity);
    const calls: string[] = [];
    const { dispose } = mount(
      world,
      () => {
        on('add', Position, (entity) => calls.push(`add:${entity}`));
        on('remove', Position, (entity) => calls.push(`remove:${entity}`));
        on('change', Position, (entity) => calls.push(`change:${entity}`));
        on('enter', [Position, Velocity], (entity) => calls.push(`enter:${entity}`));
        on('exit', [Position, Velocity], (entity) => calls.push(`exit:${entity}`));
      },
      null,
    );

    world.add(e, Position);
    world.set(e, Position.x, 1);
    world.set(e, Position.x, 1);
    world.remove(e, Position);

    expect(calls).toEqual([
      `add:${e}`,
      `enter:${e}`,
      `change:${e}`,
      `change:${e}`,
      `remove:${e}`,
      `exit:${e}`,
    ]);
    expect(frames).toHaveLength(0);

    dispose();
    world.add(e, Position);
    world.set(e, Position.x, 2);
    expect(calls).toHaveLength(6);

    world.destroy();
  });
});

describe('flush modes (§C.3.3)', () => {
  test('frame: many writes, one frame, one run', () => {
    const world = new World();
    const frames = fakeFrames();
    const e = world.spawn(Position);
    const { result, dispose } = mount(world, () => observe(createField(e, Position.x)), 'frame');

    for (let i = 1; i <= 10; i++) {
      world.set(e, Position.x, i);
    }
    expect(result).toEqual([0]);
    expect(frames).toHaveLength(1);

    frames[0]();
    expect(result).toEqual([0, 10]);

    world.set(e, Position.x, 10);
    frames[1]();
    expect(result).toEqual([0, 10]);

    dispose();
    world.destroy();
  });

  test('microtask: coalesced to the end of the turn', async () => {
    const world = new World();
    const e = world.spawn(Position);
    const { result, dispose } = mount(
      world,
      () => observe(createField(e, Position.x)),
      'microtask',
    );

    world.set(e, Position.x, 1);
    world.set(e, Position.x, 2);
    expect(result).toEqual([0]);
    await Promise.resolve();

    expect(result).toEqual([0, 2]);

    dispose();
    world.destroy();
  });
});
