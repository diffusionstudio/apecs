/**
 * Three spheres in screen space. They bounce off the window and off each
 * other; the layout treats them as holes. Integrated through `chunks()`: with
 * three rows the tier does not matter, but the pair loop wants the columns.
 */
import type { World } from 'apecs';

import { Ball, Shade, Time, Viewport } from './traits';

interface Palette {
  light: string;
  base: string;
  dark: string;
}

const PALETTES: Palette[] = [
  { light: '#ffd9c9', base: '#ff7b57', dark: '#7d2410' },
  { light: '#cff5ef', base: '#26b1a0', dark: '#0b4741' },
  { light: '#e9dcff', base: '#8b5cf6', dark: '#341a6e' },
];

const RADII = [58, 75, 90];
const HELD_MASS = 1e9;
/** Speed kept on a wall bounce. */
const RESTITUTION = 0.8;

export function spawnSpheres(world: World, ctx: CanvasRenderingContext2D): void {
  const w = world.get(Viewport.w);
  const h = world.get(Viewport.h);
  // Sized to the window, so a phone gets spheres and not a wall.
  const scale = Math.min(1, Math.max(0.55, Math.min(w, h) / 900));
  for (let k = 0; k < PALETTES.length; k++) {
    const r = Math.round(RADII[k] * scale);
    const angle = Math.random() * Math.PI * 2;
    const speed = 110 + k * 25;
    world.spawn(
      Ball({
        x: w * (0.25 + 0.25 * k),
        y: h * (0.3 + 0.2 * k),
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        r,
      }),
      Shade(shade(ctx, r, PALETTES[k])),
    );
  }
}

/** Built around the origin once; `draw` translates to the sphere. */
function shade(ctx: CanvasRenderingContext2D, r: number, p: Palette): CanvasGradient {
  const g = ctx.createRadialGradient(-r * 0.38, -r * 0.42, r * 0.06, 0, 0, r);
  g.addColorStop(0, p.light);
  g.addColorStop(0.5, p.base);
  g.addColorStop(1, p.dark);
  return g;
}

export function moveSpheres(world: World): void {
  const dt = world.get(Time.delta);
  const w = world.get(Viewport.w);
  const h = world.get(Viewport.h);

  for (const chunk of world.query(Ball).chunks()) {
    const { x, y, vx, vy, r, held } = chunk.get(Ball);
    const n = chunk.length;

    for (let i = 0; i < n; i++) {
      const ri = r[i];
      if (held[i]) {
        // The pointer owns it; only keep it on screen.
        x[i] = Math.min(w - ri, Math.max(ri, x[i]));
        y[i] = Math.min(h - ri, Math.max(ri, y[i]));
        continue;
      }
      x[i] += vx[i] * dt;
      y[i] += vy[i] * dt;
      if (x[i] < ri) {
        x[i] = ri;
        vx[i] = Math.abs(vx[i]) * RESTITUTION;
      } else if (x[i] > w - ri) {
        x[i] = w - ri;
        vx[i] = -Math.abs(vx[i]) * RESTITUTION;
      }
      if (y[i] < ri) {
        y[i] = ri;
        vy[i] = Math.abs(vy[i]) * RESTITUTION;
      } else if (y[i] > h - ri) {
        y[i] = h - ri;
        vy[i] = -Math.abs(vy[i]) * RESTITUTION;
      }
    }

    // Elastic pairs, mass by area. Overlap is resolved by mass share so a
    // small sphere gets pushed, not a large one; a held sphere weighs so
    // much that the other one takes the whole correction and the whole bounce.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = x[j] - x[i];
        const dy = y[j] - y[i];
        const d = Math.hypot(dx, dy);
        const reach = r[i] + r[j];
        if (d >= reach || d === 0) {
          continue;
        }
        const nx = dx / d;
        const ny = dy / d;
        const mi = held[i] ? HELD_MASS : r[i] * r[i];
        const mj = held[j] ? HELD_MASS : r[j] * r[j];
        const total = mi + mj;
        const overlap = reach - d;
        x[i] -= (nx * overlap * mj) / total;
        y[i] -= (ny * overlap * mj) / total;
        x[j] += (nx * overlap * mi) / total;
        y[j] += (ny * overlap * mi) / total;
        const closing = (vx[j] - vx[i]) * nx + (vy[j] - vy[i]) * ny;
        if (closing > 0) {
          continue;
        }
        const impulse = (2 * closing) / total;
        vx[i] += impulse * mj * nx;
        vy[i] += impulse * mj * ny;
        vx[j] -= impulse * mi * nx;
        vy[j] -= impulse * mi * ny;
      }
    }
  }
}
