/**
 * `schedule-dispatch` (SPEC-SCHEDULE §S.1, goal 3): what a `run` costs over the
 * hand-written frame it replaces. Ordering is resolved on mutation, so a run is
 * a branch, a `step`, and one indirect call per system — the question this
 * measures is what those indirect calls cost against direct ones V8 can inline.
 *
 * `schedule-frame` puts the same overhead next to systems that do a frame's
 * worth of work, which is the only ratio that decides anything.
 */
import { bench, describe } from 'vitest';

import { Position, Velocity, movers } from './support';
import { Schedule, World } from '../src/index';

const counters = new Int32Array(16);

// Sixteen distinct functions, so the schedule's call site is as megamorphic as a
// real frame makes it. A factory would share one code object and flatter it.
function s0(): void {
  counters[0]++;
}
function s1(): void {
  counters[1]++;
}
function s2(): void {
  counters[2]++;
}
function s3(): void {
  counters[3]++;
}
function s4(): void {
  counters[4]++;
}
function s5(): void {
  counters[5]++;
}
function s6(): void {
  counters[6]++;
}
function s7(): void {
  counters[7]++;
}
function s8(): void {
  counters[8]++;
}
function s9(): void {
  counters[9]++;
}
function s10(): void {
  counters[10]++;
}
function s11(): void {
  counters[11]++;
}
function s12(): void {
  counters[12]++;
}
function s13(): void {
  counters[13]++;
}
function s14(): void {
  counters[14]++;
}
function s15(): void {
  counters[15]++;
}

const TRIVIAL = [s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12, s13, s14, s15];

const dispatchWorld = new World();
const dispatchSchedule = new Schedule();
for (let i = 0; i < TRIVIAL.length; i++) {
  dispatchSchedule.add(`s${i}`, TRIVIAL[i]);
}

/** The frame a user writes by hand: sixteen direct calls V8 can inline outright. */
function handFrame(world: World): void {
  world.step();
  s0();
  s1();
  s2();
  s3();
  s4();
  s5();
  s6();
  s7();
  s8();
  s9();
  s10();
  s11();
  s12();
  s13();
  s14();
  s15();
}

describe('schedule-dispatch', () => {
  bench('hand-written frame (16 systems)', () => {
    handFrame(dispatchWorld);
  });

  bench('schedule.run (16 systems)', () => {
    dispatchSchedule.run(dispatchWorld);
  });
});

const N = 10_000;

/** Eight systems that each integrate the same 10k rows: a frame's worth of work. */
function integrate(world: World): void {
  for (const chunk of world.query(Position, Velocity).chunks()) {
    const { x, y } = chunk.get(Position);
    const { x: vx, y: vy } = chunk.get(Velocity);
    for (let i = 0, n = chunk.length; i < n; i++) {
      x[i] += vx[i] * 0.016;
      y[i] += vy[i] * 0.016;
    }
  }
}

function w0(w: World): void {
  integrate(w);
}
function w1(w: World): void {
  integrate(w);
}
function w2(w: World): void {
  integrate(w);
}
function w3(w: World): void {
  integrate(w);
}
function w4(w: World): void {
  integrate(w);
}
function w5(w: World): void {
  integrate(w);
}
function w6(w: World): void {
  integrate(w);
}
function w7(w: World): void {
  integrate(w);
}

const WORKING = [w0, w1, w2, w3, w4, w5, w6, w7];

const frameWorld = movers(N);
const handWorld = movers(N);
const frameSchedule = new Schedule();
for (let i = 0; i < WORKING.length; i++) {
  frameSchedule.add(`w${i}`, WORKING[i]);
}

describe('schedule-frame', () => {
  bench('hand-written frame (8 working systems)', () => {
    handWorld.step();
    w0(handWorld);
    w1(handWorld);
    w2(handWorld);
    w3(handWorld);
    w4(handWorld);
    w5(handWorld);
    w6(handWorld);
    w7(handWorld);
  });

  bench('schedule.run (8 working systems)', () => {
    frameSchedule.run(frameWorld);
  });
});
