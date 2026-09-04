/**
 * `simple-iter` (SPEC §12.1): 100 000 entities, two traits, arithmetic.
 * Budget — `each` within 1.5× of the hand-written loop, `chunks` within 1.1×.
 */
import { bench, describe } from 'vitest';

import { Baseline, Position, Velocity, movers } from './support';

const N = 100_000;
const DT = 1 / 60;

const baseline = new Baseline(N);
const world = movers(N);
const query = world.query(Position, Velocity);

describe('simple-iter', () => {
  bench('baseline', () => {
    baseline.integrate(DT);
  });

  bench('apecs each', () => {
    query.each((p, v) => {
      p.x += v.x * DT;
      p.y += v.y * DT;
    });
  });

  bench('apecs chunks', () => {
    for (const chunk of query.chunks()) {
      const { x, y } = chunk.get(Position);
      const { x: vx, y: vy } = chunk.get(Velocity);
      for (let i = 0, n = chunk.length; i < n; i++) {
        x[i] += vx[i] * DT;
        y[i] += vy[i] * DT;
      }
    }
  });
});
