/**
 * `packed-5` (SPEC §12.1): five traits on 1 000 entities, five passes, every
 * entity matching every pass — the shape every JS ECS publishes.
 */
import { bench, describe } from 'vitest';

import { Damage, Health, Position, Sprite, Velocity, packed } from './support';

const N = 1_000;

const world = packed(N);
const positions = world.query(Position);
const velocities = world.query(Velocity);
const healths = world.query(Health);
const damages = world.query(Damage);
const sprites = world.query(Sprite);
const chunked = [positions, velocities, healths, damages, sprites];
const fields = [Position.x, Velocity.x, Health.current, Damage.amount, Sprite.frame];

const columns = [
  new Float32Array(N),
  new Float32Array(N),
  new Float32Array(N),
  new Float32Array(N),
  new Float32Array(N),
];

describe('packed-5', () => {
  bench('baseline', () => {
    for (let c = 0; c < columns.length; c++) {
      const column = columns[c];
      for (let i = 0; i < N; i++) {
        column[i] *= 1.000001;
      }
    }
  });

  bench('apecs each', () => {
    positions.each((p) => (p.x *= 1.000001));
    velocities.each((v) => (v.x *= 1.000001));
    healths.each((h) => (h.current *= 1.000001));
    damages.each((d) => (d.amount *= 1.000001));
    sprites.each((s) => (s.frame *= 1.000001));
  });

  bench('apecs chunks', () => {
    for (let q = 0; q < chunked.length; q++) {
      for (const chunk of chunked[q].chunks()) {
        const column = chunk.column(fields[q]);
        for (let i = 0, n = chunk.length; i < n; i++) {
          column[i] *= 1.000001;
        }
      }
    }
  });
});
