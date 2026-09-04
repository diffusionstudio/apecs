/**
 * becsy defers structural changes to the frame boundary. The add_remove
 * benchmark adds and removes inside ONE frame — so does becsy do both, or does
 * it collapse them into nothing and post a time for work it never did?
 *
 * Compares in-frame add+remove against alternating frames (add on even,
 * remove on odd), where coalescing is impossible.
 */
import { measure } from 'mitata';

const N = 100_000;
const { System, Type, World } = await import('@lastolivegames/becsy/perf.js');
const mk = (s) => {
  const C = class {};
  C.schema = s;
  return C;
};

const opts = (n) => ({
  maxEntities: n + 16,
  maxShapeChangesPerFrame: n * 8 + 1024,
  maxWritesPerFrame: n * 8 + 1024,
  maxLimboComponents: n * 8 + 1024,
});

// A: both halves in one frame — exactly what the benchmark adapter does.
{
  const Position = mk({ x: Type.float32 });
  const Velocity = mk({ x: Type.float32 });
  class Toggle extends System {
    q = this.query((x) => x.current.with(Position).and.using(Velocity).write);
    execute() {
      for (const e of this.q.current) {
        e.add(Velocity);
      }
      for (const e of this.q.current) {
        e.remove(Velocity);
      }
    }
  }
  const w = await World.create({ defs: [Position, Velocity, Toggle], ...opts(N) });
  await w.build((s) => {
    for (let i = 0; i < N; i++) {
      s.createEntity(Position);
    }
  });
  const fn = () => w.execute();
  for (let i = 0; i < 3; i++) {
    await fn();
  }
  const s = await measure(fn, { min_cpu_time: 1000e6 });
  console.log('in-frame add+remove       ', (s.avg / 1000).toFixed(1) + 'µs per frame');
  await w.terminate();
}

// B: add on even frames, remove on odd. Two frames per full cycle, so the
// comparable figure is 2x the per-frame average.
{
  const Position = mk({ x: Type.float32 });
  const Velocity = mk({ x: Type.float32 });
  let n = 0;
  let addFrames = 0;
  let removeFrames = 0;
  class Toggle extends System {
    q = this.query((x) => x.current.with(Position).and.using(Velocity).write);
    execute() {
      if (n++ % 2 === 0) {
        for (const e of this.q.current) {
          e.add(Velocity);
        }
        addFrames++;
      } else {
        for (const e of this.q.current) {
          e.remove(Velocity);
        }
        removeFrames++;
      }
    }
  }
  const w = await World.create({ defs: [Position, Velocity, Toggle], ...opts(N) });
  await w.build((s) => {
    for (let i = 0; i < N; i++) {
      s.createEntity(Position);
    }
  });
  const fn = () => w.execute();
  for (let i = 0; i < 4; i++) {
    await fn();
  }
  const s = await measure(fn, { min_cpu_time: 1000e6 });
  console.log(
    'alternating frames        ',
    ((s.avg * 2) / 1000).toFixed(1) + 'µs per add+remove cycle',
    `(${addFrames} add frames, ${removeFrames} remove frames)`,
  );
}
