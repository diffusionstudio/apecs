/**
 * SPEC-SCHEDULE §S.3–§S.6 — the scheduler: registration, deterministic
 * ordering, and what a run does. Public API only.
 */
import { afterEach, describe, expect, test } from 'vitest';

import { Changed, Schedule, Trait, World, f32 } from '../src/index';

const Position = new Trait({ x: f32(0), y: f32(0) });
const Time = new Trait({ delta: 0 });

const devOnly = test.runIf(__DEV__);
const prodOnly = test.skipIf(__DEV__);

const worlds: World[] = [];

function makeWorld(): World {
  const world = new World();
  worlds.push(world);
  return world;
}

/** A system that appends its name to `log`. */
function record(log: string[], name: string): (world: World) => void {
  return () => {
    log.push(name);
  };
}

afterEach(() => {
  for (const world of worlds.splice(0)) {
    world.destroy();
  }
});

describe('registration (§S.4)', () => {
  test('add is chainable and runs systems in registration order', () => {
    const log: string[] = [];
    const schedule = new Schedule()
      .add('a', record(log, 'a'))
      .add('b', record(log, 'b'))
      .add('c', record(log, 'c'));

    schedule.run(makeWorld());

    expect(log).toEqual(['a', 'b', 'c']);
  });

  test('a system is called with the world', () => {
    const world = makeWorld();
    const seen: World[] = [];
    new Schedule().add('spy', (w) => seen.push(w)).run(world);

    expect(seen).toEqual([world]);
  });

  test('size, has, remove and clear report and edit membership', () => {
    const schedule = new Schedule().add('a', () => {}).add('b', () => {});

    expect(schedule.size).toBe(2);
    expect(schedule.has('a')).toBe(true);
    expect(schedule.has('nope')).toBe(false);

    expect(schedule.remove('a')).toBe(true);
    expect(schedule.remove('a')).toBe(false);
    expect(schedule.size).toBe(1);
    expect(schedule.order).toEqual(['b']);

    schedule.clear();
    expect(schedule.size).toBe(0);
    expect(schedule.order).toEqual([]);
  });

  test('a removed system no longer runs', () => {
    const log: string[] = [];
    const schedule = new Schedule().add('a', record(log, 'a')).add('b', record(log, 'b'));
    schedule.run(makeWorld());
    schedule.remove('a');
    schedule.run(makeWorld());

    expect(log).toEqual(['a', 'b', 'b']);
  });

  test('an empty schedule runs and still advances the clock', () => {
    const world = makeWorld();
    new Schedule().run(world);

    expect(world.tick).toBe(1);
  });

  devOnly('dev throws on a duplicate name', () => {
    const schedule = new Schedule().add('a', () => {});

    expect(() => schedule.add('a', () => {})).toThrow(/already/i);
  });

  prodOnly('prod keeps the first registration of a duplicate name', () => {
    const log: string[] = [];
    const schedule = new Schedule().add('a', record(log, 'first'));
    schedule.add('a', record(log, 'second'));
    schedule.run(makeWorld());

    expect(schedule.size).toBe(1);
    expect(log).toEqual(['first']);
  });
});

describe('ordering (§S.5)', () => {
  test('after moves a system behind its target', () => {
    const log: string[] = [];
    new Schedule()
      .add('render', record(log, 'render'), { after: 'physics' })
      .add('physics', record(log, 'physics'))
      .run(makeWorld());

    expect(log).toEqual(['physics', 'render']);
  });

  test('before moves a system ahead of its target', () => {
    const log: string[] = [];
    new Schedule()
      .add('render', record(log, 'render'))
      .add('physics', record(log, 'physics'), { before: 'render' })
      .run(makeWorld());

    expect(log).toEqual(['physics', 'render']);
  });

  test('before and after take arrays', () => {
    const log: string[] = [];
    new Schedule()
      .add('c', record(log, 'c'))
      .add('a', record(log, 'a'), { before: ['b', 'c'] })
      .add('b', record(log, 'b'), { after: ['a'], before: ['c'] })
      .run(makeWorld());

    expect(log).toEqual(['a', 'b', 'c']);
  });

  test('registration order is the tiebreak between unconstrained systems', () => {
    const schedule = new Schedule()
      .add('z', () => {})
      .add('y', () => {})
      .add('x', () => {}, { after: 'z' });

    expect(schedule.order).toEqual(['z', 'y', 'x']);
  });

  test('the resolved order is independent of the order constraints were declared in', () => {
    const forward = new Schedule()
      .add('a', () => {})
      .add('b', () => {}, { after: 'a' })
      .add('c', () => {}, { after: 'b' });
    const backward = new Schedule()
      .add('c', () => {}, { after: 'b' })
      .add('b', () => {}, { after: 'a' })
      .add('a', () => {});

    expect(forward.order).toEqual(['a', 'b', 'c']);
    expect(backward.order).toEqual(['a', 'b', 'c']);
  });

  test('a redundant constraint stated from both sides is honoured once', () => {
    const schedule = new Schedule()
      .add('b', () => {}, { after: 'a' })
      .add('a', () => {}, { before: 'b' });

    expect(schedule.order).toEqual(['a', 'b']);
  });

  test('order re-resolves after a mutation', () => {
    const schedule = new Schedule().add('a', () => {}).add('b', () => {});
    expect(schedule.order).toEqual(['a', 'b']);

    schedule.add('c', () => {}, { before: 'a' });
    expect(schedule.order).toEqual(['c', 'a', 'b']);
    expect(schedule.order).toEqual(['c', 'a', 'b']);
  });

  devOnly('dev throws on a constraint naming an unregistered system', () => {
    const schedule = new Schedule().add('a', () => {}, { after: 'ghost' });

    expect(() => schedule.order).toThrow(/ghost/);
  });

  devOnly('dev throws on a system ordered against itself', () => {
    const schedule = new Schedule().add('a', () => {}, { after: 'a' });

    expect(() => schedule.order).toThrow(/itself/i);
  });

  devOnly('dev throws on a cycle, naming the chain that closes it', () => {
    const schedule = new Schedule()
      .add('a', () => {})
      .add('b', () => {}, { after: 'c' })
      .add('c', () => {}, { after: 'b' });

    expect(() => schedule.order).toThrow(/cycle/i);
    // A failed resolve leaves the schedule dirty, so the fault is reported again.
    expect(() => schedule.order).toThrow(/'b' -> 'c' -> 'b'/);
  });

  prodOnly('prod drops an edge that names an unregistered system', () => {
    const schedule = new Schedule().add('a', () => {}, { after: 'ghost' }).add('b', () => {});

    expect(schedule.order).toEqual(['a', 'b']);
  });

  prodOnly('prod drops the edge that closes a cycle and runs every system once', () => {
    const log: string[] = [];
    const schedule = new Schedule()
      .add('a', record(log, 'a'))
      .add('b', record(log, 'b'), { after: 'c' })
      .add('c', record(log, 'c'), { after: 'b' });
    schedule.run(makeWorld());

    expect(schedule.order).toEqual(['a', 'c', 'b']);
    expect(log).toEqual(['a', 'c', 'b']);
  });
});

describe('running (§S.6)', () => {
  test('run advances the clock exactly once', () => {
    const world = makeWorld();
    const schedule = new Schedule().add('a', () => {}).add('b', () => {});

    schedule.run(world);
    expect(world.tick).toBe(1);
    schedule.run(world);
    expect(world.tick).toBe(2);
  });

  test('the clock advances before the systems observe it', () => {
    const world = makeWorld();
    const seen: number[] = [];
    new Schedule().add('a', (w) => seen.push(w.tick)).run(world);

    expect(seen).toEqual([1]);
  });

  test('{ step: false } leaves the clock alone', () => {
    const world = makeWorld();
    const render = new Schedule({ step: false }).add('draw', () => {});

    render.run(world);
    render.run(world);

    expect(world.tick).toBe(0);
  });

  test('two schedules over one world advance the clock once per frame', () => {
    const world = makeWorld();
    const sim = new Schedule().add('move', () => {});
    const render = new Schedule({ step: false }).add('draw', () => {});

    for (let frame = 0; frame < 3; frame++) {
      sim.run(world);
      render.run(world);
    }

    expect(world.tick).toBe(3);
  });

  test('adding a system from inside a system takes effect on the next run', () => {
    const log: string[] = [];
    const schedule = new Schedule();
    schedule.add('a', () => {
      log.push('a');
      if (!schedule.has('late')) {
        schedule.add('late', record(log, 'late'), { before: 'a' });
      }
    });

    schedule.run(makeWorld());
    expect(log).toEqual(['a']);

    schedule.run(makeWorld());
    expect(log).toEqual(['a', 'late', 'a']);
  });

  test('removing a system from inside a system does not disturb the running order', () => {
    const log: string[] = [];
    const schedule = new Schedule()
      .add('a', () => {
        log.push('a');
        schedule.remove('b');
      })
      .add('b', record(log, 'b'));

    schedule.run(makeWorld());
    expect(log).toEqual(['a', 'b']);

    schedule.run(makeWorld());
    expect(log).toEqual(['a', 'b', 'a']);
  });

  devOnly('dev throws on a reentrant run', () => {
    const world = makeWorld();
    const schedule = new Schedule();
    let thrown: unknown;
    schedule.add('a', (w) => {
      try {
        schedule.run(w);
      } catch (error) {
        thrown = error;
      }
    });

    schedule.run(world);

    expect(String(thrown)).toMatch(/already running/i);
  });

  devOnly('a system that throws leaves the schedule runnable', () => {
    const world = makeWorld();
    const log: string[] = [];
    const schedule = new Schedule().add('boom', () => {
      throw new Error('boom');
    });

    expect(() => schedule.run(world)).toThrow('boom');

    schedule.clear();
    schedule.add('ok', record(log, 'ok'));
    expect(() => schedule.run(world)).not.toThrow();
    expect(log).toEqual(['ok']);
  });
});

describe('dispatch (§S.6)', () => {
  test('a schedule past the flattening limit still runs in order', () => {
    // 513 systems: one past MAX_FLAT_SYSTEMS, so this is the loop fallback —
    // the same path a CSP without `unsafe-eval` takes.
    const log: number[] = [];
    const schedule = new Schedule();
    for (let i = 0; i < 513; i++) {
      schedule.add(`s${i}`, () => {
        log.push(i);
      });
    }
    // Ordering still applies across the fallback.
    schedule.add('first', () => log.push(-1), { before: 's0' });

    schedule.run(makeWorld());

    expect(log.length).toBe(514);
    expect(log[0]).toBe(-1);
    expect(log[1]).toBe(0);
    expect(log[513]).toBe(512);
  });

  test('a system name never reaches the compiled dispatcher', () => {
    // Names are user strings; they are passed positionally, never interpolated.
    const log: string[] = [];
    const schedule = new Schedule()
      .add('a(); throw new Error("injected"); //', record(log, 'hostile'))
      .add('b', record(log, 'b'));

    expect(() => schedule.run(makeWorld())).not.toThrow();
    expect(log).toEqual(['hostile', 'b']);
  });

  test('the dispatcher is rebuilt when the order changes', () => {
    const log: string[] = [];
    const schedule = new Schedule().add('a', record(log, 'a')).add('b', record(log, 'b'));
    schedule.run(makeWorld());

    schedule.add('c', record(log, 'c'), { before: 'a' });
    schedule.run(makeWorld());

    expect(log).toEqual(['a', 'b', 'c', 'a', 'b']);
  });
});

describe('the clock it owns (§S.6, §8.3)', () => {
  test('Changed() sees one frame of writes per run', () => {
    const world = makeWorld();
    const entity = world.spawn(Position, Time);
    const changed = world.query(Position, Changed(Position));
    const seen: number[] = [];

    const schedule = new Schedule()
      .add('move', (w) => {
        w.set(entity, Position, { x: w.get(entity, Position.x) + 1 });
      })
      .add('observe', () => {
        let n = 0;
        changed.each(() => n++);
        seen.push(n);
      });

    schedule.run(world);
    schedule.run(world);
    schedule.run(world);

    expect(seen).toEqual([1, 1, 1]);
  });

  test('a system that writes no trait leaves Changed() empty on the next run', () => {
    const world = makeWorld();
    const entity = world.spawn(Position);
    const changed = world.query(Position, Changed(Position));
    const seen: number[] = [];
    const schedule = new Schedule().add('observe', () => {
      let n = 0;
      changed.each(() => n++);
      seen.push(n);
    });

    world.set(entity, Position, { x: 1 });
    schedule.run(world);
    schedule.run(world);

    expect(seen).toEqual([1, 0]);
  });
});
