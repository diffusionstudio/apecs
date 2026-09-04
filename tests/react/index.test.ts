/**
 * apecs/react (SPEC-CLIENTS §C.5): every read hook is a `useSyncExternalStore`
 * over a cell, so these tests assert what React sees — one render per real
 * change, none for a write that changes nothing — and the mount-bound lifetime
 * of every subscription.
 */
import { act, renderHook } from '@testing-library/react';
import { StrictMode, createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { Not, Relation, Trait, World, f32, str, type Entity } from '../../src/index';
import { fieldCell } from '../../src/reactive/cell';
import { schedulerOf, type Flush } from '../../src/reactive/scheduler';
import {
  WorldProvider,
  useAccessor,
  useChildren,
  useEntity,
  useField,
  useHas,
  useOn,
  useParent,
  useQuery,
  useQueryFirst,
  useSortedQuery,
  useSortedQueryFirst,
  useTag,
  useTarget,
  useTrait,
  useWorld,
} from '../../src/react/index';

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
  /** The latest render's return value. */
  readonly current: T;
  /** Renders so far, the mount included. */
  renders(): number;
  rerender(): void;
  unmount(): void;
}

interface MountOptions {
  /** `null` omits the prop. */
  flush?: Flush | null;
  strict?: boolean;
}

/** Renders `hook` under a provider, as a component renders under one in JSX. */
function mount<T>(world: World, hook: () => T, options: MountOptions = {}): Mounted<T> {
  const { flush = 'sync', strict = false } = options;
  let renders = 0;
  const wrapper = ({ children }: { children: ReactNode }) => {
    const provider = createElement(WorldProvider, { world, flush: flush ?? undefined, children });
    return strict ? createElement(StrictMode, null, provider) : provider;
  };
  const rendered = renderHook(
    () => {
      renders++;
      return hook();
    },
    { wrapper },
  );
  return {
    get current() {
      return rendered.result.current;
    },
    renders: () => renders,
    rerender: () => rendered.rerender(),
    unmount: () => rendered.unmount(),
  };
}

/** A world write, inside React's act so the render it causes is flushed before the next line. */
function write(fn: () => void): void {
  act(fn);
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
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => renderHook(() => useWorld())).toThrow(/WorldProvider/);
  });

  test('useWorld returns the provided world', () => {
    const world = new World();
    const mounted = mount(world, () => useWorld());

    expect(mounted.current).toBe(world);

    mounted.unmount();
    world.destroy();
  });

  test('the flush prop configures the world, and defaults to frame', () => {
    const a = new World();
    const b = new World();
    const mountedA = mount(a, () => undefined);
    const mountedB = mount(b, () => undefined, { flush: null });

    expect(schedulerOf(a).mode).toBe('sync');
    expect(schedulerOf(b).mode).toBe('frame');

    mountedA.unmount();
    mountedB.unmount();
    a.destroy();
    b.destroy();
  });

  devOnly('an unknown flush mode is rejected', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const world = new World();

    expect(() => mount(world, () => undefined, { flush: 'never' as Flush })).toThrow(/flush/);

    world.destroy();
  });
});

describe('useField (§C.3.2, §C.4.6)', () => {
  test('re-renders per real change and not for a write that changes nothing', () => {
    const world = new World();
    const e = world.spawn(Position({ x: 1 }), Name({ value: 'a' }));
    const mounted = mount(world, () => ({
      x: useField(e, Position.x),
      name: useField(e, Name.value),
    }));
    expect(mounted.current).toEqual({ x: 1, name: 'a' });
    expect(mounted.renders()).toBe(1);

    write(() => world.set(e, Position.x, 1));
    write(() => world.set(e, Position, { x: 1 }));
    write(() => world.accessor(Position.x).set(e, 1));
    write(() => world.set(e, Name.value, 'a'));
    expect(mounted.renders()).toBe(1);

    write(() => world.set(e, Position.x, 2));
    expect(mounted.current).toEqual({ x: 2, name: 'a' });
    expect(mounted.renders()).toBe(2);

    write(() => world.set(e, Name.value, 'b'));
    expect(mounted.current).toEqual({ x: 2, name: 'b' });
    expect(mounted.renders()).toBe(3);

    mounted.unmount();
    world.destroy();
  });

  test('the entity-less overload reads the world trait', () => {
    const world = new World();
    world.add(Score({ value: 1 }));
    const mounted = mount(world, () => useField(Score.value));
    expect(mounted.current).toBe(1);

    write(() => world.set(Score.value, 1));
    expect(mounted.renders()).toBe(1);

    write(() => world.set(Score.value, 2));
    expect(mounted.current).toBe(2);
    expect(mounted.renders()).toBe(2);

    mounted.unmount();
    world.destroy();
  });

  test('reads undefined without the trait, before it is gained and after it is lost', () => {
    const world = new World();
    const e = world.spawn();
    const mounted = mount(world, () => useField(e, Position.x));
    expect(mounted.current).toBeUndefined();

    write(() => world.add(e, Position({ x: 4 })));
    expect(mounted.current).toBe(4);

    write(() => world.despawn(e));
    expect(mounted.current).toBeUndefined();
    expect(mounted.renders()).toBe(3);

    mounted.unmount();
    world.destroy();
  });

  test('a dead entity reads undefined and never wakes', () => {
    const world = new World();
    const e = world.spawn(Position);
    world.despawn(e);
    const mounted = mount(world, () => useField(e, Position.x));
    expect(mounted.current).toBeUndefined();

    write(() => {
      world.spawn(Position({ x: 3 }));
    });
    expect(mounted.renders()).toBe(1);

    mounted.unmount();
    world.destroy();
  });

  test('an unrelated re-render reads the committed value without re-subscribing', () => {
    const world = new World();
    const e = world.spawn(Position);
    const mounted = mount(world, () => useField(e, Position.x));
    const cell = fieldCell(world, e, Position.x);

    mounted.rerender();
    mounted.rerender();
    expect(fieldCell(world, e, Position.x)).toBe(cell);
    expect(mounted.renders()).toBe(3);

    write(() => world.set(e, Position.x, 5));
    expect(mounted.current).toBe(5);
    expect(mounted.renders()).toBe(4);

    mounted.unmount();
    world.destroy();
  });

  test('readers share one cell, and unmount releases it', () => {
    const world = new World();
    const e = world.spawn(Position);
    const mounted = mount(world, () => ({
      a: useField(e, Position.x),
      b: useField(e, Position.x),
    }));
    const cell = fieldCell(world, e, Position.x);

    write(() => world.set(e, Position.x, 1));
    expect(mounted.current).toEqual({ a: 1, b: 1 });
    expect(mounted.renders()).toBe(2);

    mounted.unmount();
    expect(fieldCell(world, e, Position.x)).not.toBe(cell);
    write(() => world.set(e, Position.x, 2));
    expect(mounted.renders()).toBe(2);

    world.destroy();
  });
});

describe('useTrait (§C.3.2)', () => {
  test('identity is stable until a field differs', () => {
    const world = new World();
    const e = world.spawn(Position({ x: 1 }));
    const mounted = mount(world, () => useTrait(e, Position));
    const first = mounted.current;
    expect(first).toEqual({ x: 1, y: 0 });

    write(() => world.set(e, Position, { x: 1 }));
    write(() => world.set(e, Position.y, 0));
    mounted.rerender();
    expect(mounted.current).toBe(first);
    expect(mounted.renders()).toBe(2);

    write(() => world.set(e, Position.x, 3));
    expect(mounted.current).not.toBe(first);
    expect(mounted.current).toEqual({ x: 3, y: 0 });
    expect(first).toEqual({ x: 1, y: 0 });
    expect(mounted.renders()).toBe(3);

    mounted.unmount();
    world.destroy();
  });

  test('the entity-less overload reads the world trait', () => {
    const world = new World();
    const mounted = mount(world, () => useTrait(Score));
    expect(mounted.current).toBeUndefined();

    write(() => world.add(Score({ value: 5 })));
    expect(mounted.current).toEqual({ value: 5 });

    mounted.unmount();
    world.destroy();
  });

  devOnly('the committed copy is frozen', () => {
    const world = new World();
    const e = world.spawn(Position);
    const mounted = mount(world, () => useTrait(e, Position));

    expect(Object.isFrozen(mounted.current)).toBe(true);

    mounted.unmount();
    world.destroy();
  });
});

describe('useHas and useTag (§C.5.2)', () => {
  test('only a real gain or loss re-renders', () => {
    const world = new World();
    const e = world.spawn(Position);
    const mounted = mount(world, () => ({
      has: useHas(e, Position),
      tag: useTag(e, IsActive),
    }));
    expect(mounted.current).toEqual({ has: true, tag: false });

    write(() => world.add(e, IsActive));
    expect(mounted.current).toEqual({ has: true, tag: true });
    expect(mounted.renders()).toBe(2);

    write(() => world.add(e, IsActive));
    write(() => world.add(e, Position));
    expect(mounted.renders()).toBe(2);

    write(() => world.remove(e, IsActive));
    write(() => world.remove(e, Position));
    expect(mounted.current).toEqual({ has: false, tag: false });
    expect(mounted.renders()).toBe(4);

    mounted.unmount();
    world.destroy();
  });

  test('a pair is checked against its target', () => {
    const world = new World();
    const a = world.spawn();
    const b = world.spawn();
    const e = world.spawn();
    const mounted = mount(world, () => useHas(e, ChildOf(a)));

    write(() => world.add(e, ChildOf(b)));
    expect(mounted.current).toBe(false);
    expect(mounted.renders()).toBe(1);

    write(() => world.add(e, ChildOf(a)));
    expect(mounted.current).toBe(true);

    mounted.unmount();
    world.destroy();
  });

  test('the entity-less overloads read the world trait', () => {
    const world = new World();
    const mounted = mount(world, () => ({
      has: useHas(Score),
      tag: useTag(IsActive),
    }));
    expect(mounted.current).toEqual({ has: false, tag: false });

    write(() => world.add(Score({ value: 1 }), IsActive));
    expect(mounted.current).toEqual({ has: true, tag: true });

    mounted.unmount();
    world.destroy();
  });

  devOnly('useTag rejects a trait that carries data', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const world = new World();
    const e = world.spawn(Position);

    expect(() => mount(world, () => useTag(e, Position))).toThrow(/useHas/);
    expect(() => mount(world, () => useTag(Score))).toThrow(/useHas/);

    world.destroy();
  });
});

describe('queries (§C.4.3, §C.4.4)', () => {
  test('useQuery follows membership and ignores a leave-and-return', () => {
    const world = new World();
    const a = world.spawn(Position);
    const mounted = mount(world, () => useQuery(Position, Not(IsActive)));
    expect(mounted.current).toEqual([a]);

    let b!: Entity;
    write(() => {
      b = world.spawn(Position);
    });
    expect(sorted(mounted.current)).toEqual(sorted([a, b]));
    expect(mounted.renders()).toBe(2);

    write(() => world.add(b, IsActive));
    expect(mounted.current).toEqual([a]);
    expect(mounted.renders()).toBe(3);

    write(() => world.set(a, Position.x, 1));
    write(() => world.add(a, Velocity));
    expect(mounted.renders()).toBe(3);

    write(() => world.despawn(a));
    expect(mounted.current).toEqual([]);

    mounted.unmount();
    world.destroy();
  });

  test('useQueryFirst is silent while the first entity stays', () => {
    const world = new World();
    const a = world.spawn(Position);
    const b = world.spawn(Position);
    const mounted = mount(world, () => useQueryFirst(Position));
    const first = mounted.current!;
    expect(first === a || first === b).toBe(true);

    write(() => world.despawn(first === a ? b : a));
    write(() => world.add(first, Velocity));
    expect(mounted.current).toBe(first);
    expect(mounted.renders()).toBe(1);

    write(() => world.despawn(first));
    expect(mounted.current).toBeUndefined();
    expect(mounted.renders()).toBe(2);

    mounted.unmount();
    world.destroy();
  });

  test('equal terms on every render resolve to one shared cell', () => {
    const world = new World();
    world.spawn(Position);
    const mounted = mount(world, () => ({
      a: useQuery(Position, Not(IsActive)),
      b: useQuery(Position, Not(IsActive)),
    }));
    expect(mounted.current.a).toBe(mounted.current.b);

    write(() => {
      world.spawn(Position);
    });
    expect(mounted.current.a).toBe(mounted.current.b);
    expect(mounted.current.a).toHaveLength(2);
    expect(mounted.renders()).toBe(2);

    mounted.unmount();
    world.destroy();
  });
});

describe('sorted queries (§C.3.6)', () => {
  test('useSortedQuery re-renders only when the order changes', () => {
    const world = new World();
    const [a, b, c] = keyed(world);
    const mounted = mount(world, () => useSortedQuery([SortIndex], SortIndex.value));
    const first = mounted.current;
    expect(first).toEqual([a, b, c]);

    write(() => world.set(b, SortIndex.value, 2.5));
    write(() => world.set(a, SortIndex.value, -1));
    expect(mounted.current).toBe(first);
    expect(mounted.renders()).toBe(1);

    write(() => world.set(c, SortIndex.value, 0));
    expect(mounted.current).toEqual([a, c, b]);
    expect(mounted.renders()).toBe(2);

    let d!: Entity;
    write(() => {
      d = world.spawn(SortIndex({ value: 1.5 }));
    });
    expect(mounted.current).toEqual([a, c, d, b]);
    expect(mounted.renders()).toBe(3);

    mounted.unmount();
    world.destroy();
  });

  test('direction defaults to ascending and descending reverses it', () => {
    const world = new World();
    const [a, b, c] = keyed(world);
    const mounted = mount(world, () => ({
      asc: useSortedQuery([SortIndex], SortIndex.value),
      explicit: useSortedQuery([SortIndex], SortIndex.value, 'asc'),
      desc: useSortedQuery([SortIndex], SortIndex.value, 'desc'),
    }));

    expect(mounted.current.asc).toEqual([a, b, c]);
    expect(mounted.current.explicit).toBe(mounted.current.asc);
    expect(mounted.current.desc).toEqual([c, b, a]);

    mounted.unmount();
    world.destroy();
  });

  test('useSortedQueryFirst re-renders only for a new leader', () => {
    const world = new World();
    const [a, b, c] = keyed(world);
    const mounted = mount(world, () => useSortedQueryFirst([SortIndex], SortIndex.value));
    expect(mounted.current).toBe(a);

    write(() => world.set(c, SortIndex.value, 1.5));
    write(() => {
      world.spawn(SortIndex({ value: 7 }));
    });
    write(() => world.despawn(b));
    expect(mounted.current).toBe(a);
    expect(mounted.renders()).toBe(1);

    write(() => world.set(c, SortIndex.value, 0));
    expect(mounted.current).toBe(c);
    expect(mounted.renders()).toBe(2);

    mounted.unmount();
    world.destroy();
  });
});

describe('relations (§C.5.2)', () => {
  test('useTarget and useParent follow retargets', () => {
    const world = new World();
    const a = world.spawn();
    const b = world.spawn();
    const e = world.spawn();
    const mounted = mount(world, () => ({
      target: useTarget(e, ChildOf),
      parent: useParent(e, ChildOf),
    }));
    expect(mounted.current).toEqual({ target: undefined, parent: undefined });

    write(() => world.add(e, ChildOf(a)));
    write(() => world.add(e, ChildOf(a)));
    expect(mounted.current).toEqual({ target: a, parent: a });
    expect(mounted.renders()).toBe(2);

    write(() => world.add(e, ChildOf(b)));
    expect(mounted.current).toEqual({ target: b, parent: b });

    write(() => world.remove(e, ChildOf));
    expect(mounted.current).toEqual({ target: undefined, parent: undefined });
    expect(mounted.renders()).toBe(4);

    mounted.unmount();
    world.destroy();
  });

  test('useChildren lists the entities targeting the parent', () => {
    const world = new World();
    const a = world.spawn();
    const b = world.spawn();
    const mounted = mount(world, () => ({
      ofA: useChildren(a, ChildOf),
      ofB: useChildren(b, ChildOf),
    }));
    expect(mounted.current).toEqual({ ofA: [], ofB: [] });

    let c!: Entity;
    write(() => {
      c = world.spawn(ChildOf(a));
    });
    expect(mounted.current).toEqual({ ofA: [c], ofB: [] });

    write(() => world.add(c, ChildOf(b)));
    expect(mounted.current).toEqual({ ofA: [], ofB: [c] });

    mounted.unmount();
    world.destroy();
  });
});

describe('useAccessor and useEntity (§C.5.3)', () => {
  test('useAccessor is the memoised accessor, and creates no subscription', () => {
    const world = new World();
    const e = world.spawn(Position);
    const mounted = mount(world, () => useAccessor(Position.x));
    const accessor = mounted.current;
    expect(accessor).toBe(world.accessor(Position.x));

    write(() => accessor.set(e, 4));
    expect(accessor.get(e)).toBe(4);
    expect(mounted.renders()).toBe(1);

    mounted.rerender();
    expect(mounted.current).toBe(accessor);

    mounted.unmount();
    world.destroy();
  });

  test('useEntity spawns with its items on mount and despawns on unmount', () => {
    const world = new World();
    const mounted = mount(world, () => useEntity(Position({ x: 2 }), IsActive));
    const e = mounted.current!;

    expect(world.isAlive(e)).toBe(true);
    expect(world.get(e, Position.x)).toBe(2);
    expect(world.has(e, IsActive)).toBe(true);

    mounted.rerender();
    expect(mounted.current).toBe(e);

    mounted.unmount();
    expect(world.isAlive(e)).toBe(false);

    world.destroy();
  });

  test('under StrictMode the double-invoked effect leaves exactly one live entity', () => {
    const world = new World();
    const mounted = mount(world, () => useEntity(Position), { strict: true });
    const e = mounted.current!;

    expect(world.isAlive(e)).toBe(true);
    expect(world.query(Position).count).toBe(1);

    mounted.unmount();
    expect(world.query(Position).count).toBe(0);

    world.destroy();
  });

  test('unmount tolerates an entity already despawned, and a world already destroyed', () => {
    const early = new World();
    const a = mount(early, () => useEntity(Position));
    early.despawn(a.current!);
    expect(() => a.unmount()).not.toThrow();
    early.destroy();

    const gone = new World();
    const b = mount(gone, () => useEntity(Position));
    gone.destroy();
    expect(() => b.unmount()).not.toThrow();
  });
});

describe('imperative hooks (§C.7)', () => {
  test('fire inside the write, ungated and uncoalesced', () => {
    const world = new World();
    const frames = fakeFrames();
    const e = world.spawn(Velocity);
    const calls: string[] = [];
    const mounted = mount(
      world,
      () => {
        useOn('add', Position, (entity) => calls.push(`add:${entity}`));
        useOn('remove', Position, (entity) => calls.push(`remove:${entity}`));
        useOn('change', Position, (entity) => calls.push(`change:${entity}`));
        useOn('enter', [Position, Velocity], (entity) => calls.push(`enter:${entity}`));
        useOn('exit', [Position, Velocity], (entity) => calls.push(`exit:${entity}`));
      },
      { flush: null },
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
    expect(mounted.renders()).toBe(1);

    mounted.unmount();
    world.add(e, Position);
    world.set(e, Position.x, 2);
    expect(calls).toHaveLength(6);

    world.destroy();
  });

  test('a re-render swaps in the latest callback without re-subscribing', () => {
    const world = new World();
    const subscribe = vi.spyOn(world, 'on');
    const changeSubs = (): number =>
      subscribe.mock.calls.filter((call) => String(call[0]) === 'change').length;
    const e = world.spawn(Position);
    const seen: number[] = [];
    let generation = 1;
    const mounted = mount(world, () => {
      const mine = generation;
      useOn('change', Position, () => seen.push(mine));
      useOn('enter', [Position], () => {});
    });
    expect(changeSubs()).toBe(1);

    world.set(e, Position.x, 1);
    generation = 2;
    mounted.rerender();
    world.set(e, Position.x, 2);

    expect(seen).toEqual([1, 2]);
    expect(changeSubs()).toBe(1);

    mounted.unmount();
    world.destroy();
  });
});

describe('flush modes (§C.3.3)', () => {
  test('frame: many writes, one frame, one render', () => {
    const world = new World();
    const frames = fakeFrames();
    const e = world.spawn(Position);
    const mounted = mount(world, () => useField(e, Position.x), { flush: 'frame' });

    for (let i = 1; i <= 10; i++) {
      world.set(e, Position.x, i);
    }
    expect(mounted.current).toBe(0);
    expect(frames).toHaveLength(1);
    expect(mounted.renders()).toBe(1);

    act(() => frames[0]());
    expect(mounted.current).toBe(10);
    expect(mounted.renders()).toBe(2);

    world.set(e, Position.x, 10);
    act(() => frames[1]());
    expect(mounted.renders()).toBe(2);

    mounted.unmount();
    world.destroy();
  });

  test('microtask: coalesced to the end of the turn', async () => {
    const world = new World();
    const e = world.spawn(Position);
    const mounted = mount(world, () => useField(e, Position.x), { flush: 'microtask' });

    await act(async () => {
      world.set(e, Position.x, 1);
      world.set(e, Position.x, 2);
      expect(mounted.current).toBe(0);
      await Promise.resolve();
    });

    expect(mounted.current).toBe(2);
    expect(mounted.renders()).toBe(2);

    mounted.unmount();
    world.destroy();
  });
});
