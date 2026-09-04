import { Trait, World, bool, f32 } from 'apecs';
import type { Entity } from 'apecs';

export const Position = new Trait({ x: f32(0), y: f32(0) });
export const Velocity = new Trait({ x: f32(0), y: f32(0) });
/** What the rod shader draws: a heading whose length tracks the local speed. Depth inside the
 * slab is not simulation data — the shader hashes it from the instance index, which also keeps
 * the column count inside WebGPU's eight vertex buffers. */
export const Rod = new Trait({ dx: f32(1), dy: f32(0) });
export const Tint = new Trait({ hue: f32(0) });
/** Solver output the shader shades with: the outward density gradient and the density itself. */
export const Surface = new Trait({ gx: f32(0), gy: f32(0), rho: f32(1) });

/** World traits: singletons on the world entity, written by the UI and read by the solver. */
export const Fluid = new Trait({
  gravity: f32(2.2),
  viscosity: f32(3),
  pressure: f32(3.5),
  cohesion: f32(2.5),
  drift: f32(0.055),
  slosh: f32(0.62),
});
export const Pointer = new Trait({
  x: f32(0),
  y: f32(0),
  vx: f32(0),
  vy: f32(0),
  on: bool(false),
  hold: bool(false),
});
export const Stats = new Trait({
  count: 0,
  solve: f32(0),
  upload: f32(0),
  frame: f32(0),
  fps: f32(0),
  pairs: 0,
  chunks: 0,
  hue: f32(0),
});

export const PAGE_SIZE = 4096;
/** The shadow map the room samples; box coordinates, independent of the neighbour grid. */
export const COVER_W = 128;
export const COVER_H = 96;

/** Fraction of the box the fluid covers when packed at rest; with the count it fixes the spacing. */
const FILL = 0.38;
/** Interaction radius in rest spacings. Pair count grows with its square. */
const RADIUS = 1.65;
const MAX_SPEED = 1.3;
/** Largest relaxation displacement in one substep, as a fraction of the kernel radius. */
const MAX_STEP = 0.5;
const STIFFNESS = 900;
/** Near pressure is purely repulsive and keeps pairs off each other; it must not overpower cohesion. */
const NEAR_STIFFNESS = 400;
/** Cohesion gain, and the density deficit past which the pull stops growing. */
const COHESION = 900;
const COHESION_RANGE = 0.35;
/** Room left in the neighbour list for one more row, so the append needs no bounds test. */
const PAIR_MARGIN = 512;
const STIR_RADIUS = 0.34;
const STIR = 9;
const PULL = 3;
/**
 * Ceiling on the velocity the pointer may impart, as a fraction of the speed cap. A fast sweep
 * across the canvas is several units a second — far more than the fluid ever reaches on its own —
 * and handing that straight to the particles moves them more than a kernel radius in one substep,
 * which destroys the neighbourhood the solver just measured and the mass implodes.
 */
const STIR_SPEED = 0.9;
const JOLT_SECONDS = 0.4;
const JOLT = 3.2;

export class Sim {
  public readonly world = new World({ pageSize: PAGE_SIZE, maxEntities: 1 << 18 });
  public readonly drops = this.world.query(Position, Velocity, Rod, Tint, Surface);

  /**
   * Relaxation steps per frame. The scheme is only conditionally stable: a particle must not
   * travel far compared with the kernel radius in one step, so a stiffer fluid needs more of
   * these, and the neighbour passes cost the same each time.
   */
  public substeps = 2;
  /** Box half-extent on x; y spans [-1, 1]. */
  public aspect = 1.6;
  public time = 0;
  public spacing = 0.01;
  public hue = 0.32;
  public pairs = 0;
  public readonly cover = new Uint8Array(COVER_W * COVER_H);

  private h = 0.02;
  private rest = 1;
  private restNear = 1;
  private nx = 1;
  private ny = 1;
  private capacity = 0;
  private joltX = 0;
  private joltY = 0;
  private joltLeft = 0;

  // Slot order: a packed copy of the columns, gathered once per step and scattered back at the end.
  private px = new Float32Array(0);
  private py = new Float32Array(0);
  private pvx = new Float32Array(0);
  private pvy = new Float32Array(0);
  private pgx = new Float32Array(0);
  private pgy = new Float32Array(0);
  private prho = new Float32Array(0);
  private pfx = new Float32Array(0);
  private pfy = new Float32Array(0);
  // Cell order: the neighbour passes run here, so a cell's particles share cache lines.
  private sx = new Float32Array(0);
  private sy = new Float32Array(0);
  private sox = new Float32Array(0);
  private soy = new Float32Array(0);
  private svx = new Float32Array(0);
  private svy = new Float32Array(0);
  private rho = new Float32Array(0);
  private near = new Float32Array(0);
  private prs = new Float32Array(0);
  private prsn = new Float32Array(0);
  private sgx = new Float32Array(0);
  private sgy = new Float32Array(0);
  private sfx = new Float32Array(0);
  private sfy = new Float32Array(0);
  private order = new Int32Array(0);
  private cell = new Int32Array(0);
  /** Jacobi displacements: relax reads old positions everywhere, so it cannot write them in place. */
  private ddx = new Float32Array(0);
  private ddy = new Float32Array(0);
  /** In-range neighbours per row, recorded by the density pass for relax to reuse. */
  private list: Int32Array<ArrayBuffer> = new Int32Array(0);
  private nbr = new Int32Array(0);
  private start = new Int32Array(0);
  private cursor = new Int32Array(0);
  private counts = new Uint16Array(COVER_W * COVER_H);

  public constructor(count: number) {
    this.world.add(Fluid, Pointer, Stats);
    this.resize(count);
  }

  public get count(): number {
    return this.drops.count;
  }

  public setAspect(aspect: number): void {
    this.aspect = aspect;
    this.fit(this.count);
  }

  /** Grow or shrink the population with one structural operation. */
  public resize(count: number): void {
    const current = this.count;
    if (count > current) {
      this.fit(count);
      this.spawn(count - current);
    } else if (count < current) {
      this.world.despawnMany(this.drops.entities().subarray(0, current - count));
      this.fit(count);
    }
  }

  public jolt(): void {
    const angle = Math.random() * Math.PI * 2;
    this.joltX = Math.cos(angle) * JOLT;
    this.joltY = Math.abs(Math.sin(angle)) * JOLT * 0.8 + JOLT * 0.35;
    this.joltLeft = JOLT_SECONDS;
  }

  public step(dt: number): void {
    const { world } = this;
    const n = this.count;
    this.time += dt;
    if (n === 0) {
      return;
    }
    const t = this.time;
    const slosh = world.get(Fluid.slosh);
    // Two incommensurate swings, so the box never repeats and the mass never settles for long.
    const angle = slosh * (0.9 * Math.sin(0.17 * t) + 0.5 * Math.sin(0.41 * t + 2.1));
    const g = world.get(Fluid.gravity) * (0.8 + 0.2 * Math.cos(0.13 * t));
    let ax = g * Math.sin(angle);
    let ay = -g * Math.cos(angle);
    if (this.joltLeft > 0) {
      this.joltLeft -= dt;
      ax += this.joltX;
      ay += this.joltY;
    }

    let slot = 0;
    for (const chunk of this.drops.chunks()) {
      const len = chunk.length;
      this.px.set(chunk.column(Position.x).subarray(0, len), slot);
      this.py.set(chunk.column(Position.y).subarray(0, len), slot);
      this.pvx.set(chunk.column(Velocity.x).subarray(0, len), slot);
      this.pvy.set(chunk.column(Velocity.y).subarray(0, len), slot);
      slot += len;
    }

    const steps = this.substeps;
    const sdt = dt / steps;
    this.pairs = 0;
    for (let s = 0; s < steps; s++) {
      const last = s === steps - 1;
      this.forces(n, sdt, ax, ay);
      this.sort(n);
      this.density(n, last);
      this.relax(n, sdt);
      this.settle(n, sdt, last);
    }
    this.scatter(n, dt);
    world.step();
  }

  private fit(count: number): void {
    const s = Math.sqrt((FILL * 4 * this.aspect) / Math.max(count, 1));
    const h = s * RADIUS;
    const perArea = 2 / (Math.sqrt(3) * s * s);
    this.spacing = s;
    this.h = h;
    // Kernel is q = 1 - r²/h²: ∫q² = πh²/3 over the disc, ∫q³ = πh²/4, plus the particle itself.
    this.rest = (perArea * Math.PI * h * h) / 3 + 1;
    this.restNear = (perArea * Math.PI * h * h) / 4 + 1;
    this.nx = Math.floor((2 * this.aspect) / h) + 1;
    this.ny = Math.floor(2 / h) + 1;
    const cells = this.nx * this.ny + 2;
    if (this.start.length < cells) {
      this.start = new Int32Array(cells);
      this.cursor = new Int32Array(cells);
    }
    if (this.capacity < count) {
      let capacity = Math.max(1 << 14, this.capacity);
      while (capacity < count) {
        capacity *= 2;
      }
      this.capacity = capacity;
      this.px = new Float32Array(capacity);
      this.py = new Float32Array(capacity);
      this.pvx = new Float32Array(capacity);
      this.pvy = new Float32Array(capacity);
      this.pgx = new Float32Array(capacity);
      this.pgy = new Float32Array(capacity);
      this.prho = new Float32Array(capacity);
      this.pfx = new Float32Array(capacity);
      this.pfy = new Float32Array(capacity);
      this.sx = new Float32Array(capacity);
      this.sy = new Float32Array(capacity);
      this.sox = new Float32Array(capacity);
      this.soy = new Float32Array(capacity);
      this.svx = new Float32Array(capacity);
      this.svy = new Float32Array(capacity);
      this.rho = new Float32Array(capacity);
      this.near = new Float32Array(capacity);
      this.prs = new Float32Array(capacity);
      this.prsn = new Float32Array(capacity);
      this.sgx = new Float32Array(capacity);
      this.sgy = new Float32Array(capacity);
      this.sfx = new Float32Array(capacity);
      this.sfy = new Float32Array(capacity);
      this.ddx = new Float32Array(capacity);
      this.ddy = new Float32Array(capacity);
      this.nbr = new Int32Array(capacity + 1);
      this.list = new Int32Array(capacity * 20 + PAIR_MARGIN);
      this.order = new Int32Array(capacity);
      this.cell = new Int32Array(capacity);
    }
  }

  /** A hex lattice poured in from the top, with headings already combed by a smooth field. */
  private spawn(count: number): void {
    const { world } = this;
    const batch = world.spawnMany(count, Position, Velocity, Rod, Tint, Surface);
    const px = world.accessor(Position.x);
    const py = world.accessor(Position.y);
    const dx = world.accessor(Rod.dx);
    const dy = world.accessor(Rod.dy);
    const hue = world.accessor(Tint.hue);
    const s = this.spacing;
    const a = this.aspect - s;
    const cols = Math.max(1, Math.floor((2 * a) / s));
    const rowStep = s * 0.866;
    for (let i = 0; i < batch.length; i++) {
      const e = batch[i] as Entity;
      const row = (i / cols) | 0;
      const col = i - row * cols;
      const x = -a + (col + 0.5 * (row & 1) + 0.5) * s + (Math.random() - 0.5) * s * 0.25;
      const y = 1 - s - row * rowStep;
      const angle = 2.4 * Math.sin(x * 2.3) + 1.7 * Math.cos(y * 1.9 + 0.7);
      px.set(e, x);
      py.set(e, y);
      dx.set(e, Math.cos(angle) * 0.6);
      dy.set(e, Math.sin(angle) * 0.6);
      hue.set(e, this.hue + (Math.random() - 0.5) * 0.02);
    }
  }

  /** Gravity, the pointer, and the prediction step, in slot order. */
  private forces(n: number, dt: number, ax: number, ay: number): void {
    const { world, px, py, pvx, pvy, prho, sox, soy } = this;
    const invRest = 1 / this.rest;
    const on = world.get(Pointer.on);
    const qx = world.get(Pointer.x);
    const qy = world.get(Pointer.y);
    let ux = world.get(Pointer.vx);
    let uy = world.get(Pointer.vy);
    const cap = MAX_SPEED * STIR_SPEED;
    const us = Math.sqrt(ux * ux + uy * uy);
    if (us > cap) {
      ux = (ux / us) * cap;
      uy = (uy / us) * cap;
    }
    const pull = world.get(Pointer.hold) ? PULL : 0;
    const r2max = on ? STIR_RADIUS * STIR_RADIUS : 0;
    const invR2 = 1 / (STIR_RADIUS * STIR_RADIUS);
    const axdt = ax * dt;
    const aydt = ay * dt;
    for (let i = 0; i < n; i++) {
      const x = px[i];
      const y = py[i];
      let vx = pvx[i] + axdt;
      let vy = pvy[i] + aydt;
      const dx = qx - x;
      const dy = qy - y;
      const r2 = dx * dx + dy * dy;
      if (r2 < r2max) {
        const w = 1 - r2 * invR2;
        const k = w * w * dt;
        // The pull fades out where the fluid is already packed, so holding gathers the mass
        // instead of crushing it past the density the pressure term can answer for.
        const room = 1 - prho[i] * invRest;
        vx += ((ux - vx) * STIR + dx * pull * (room > 0 ? room : 0)) * k;
        vy += ((uy - vy) * STIR + dy * pull * (room > 0 ? room : 0)) * k;
      }
      pvx[i] = vx;
      pvy[i] = vy;
      // The pre-relaxation position, kept in cell order later; velocity is read back off it.
      sox[i] = x;
      soy[i] = y;
      px[i] = x + vx * dt;
      py[i] = y + vy * dt;
    }
  }

  /** Counting sort by grid cell; the sorted copies are what the neighbour passes read. */
  private sort(n: number): void {
    const { px, py, pvx, pvy, sx, sy, sox, soy, svx, svy, order, cell, start, cursor } = this;
    const { nx, ny, aspect } = this;
    const invH = 1 / this.h;
    const cells = nx * ny;
    start.fill(0, 0, cells + 1);
    for (let i = 0; i < n; i++) {
      let cx = ((px[i] + aspect) * invH) | 0;
      let cy = ((py[i] + 1) * invH) | 0;
      cx = cx < 0 ? 0 : cx >= nx ? nx - 1 : cx;
      cy = cy < 0 ? 0 : cy >= ny ? ny - 1 : cy;
      const c = cy * nx + cx;
      cell[i] = c;
      start[c + 1]++;
    }
    for (let c = 1; c <= cells; c++) {
      start[c] += start[c - 1];
    }
    cursor.set(start.subarray(0, cells));
    for (let i = 0; i < n; i++) {
      order[cursor[cell[i]]++] = i;
    }
    // The predicted position moves into cell order; the old position rides along as the anchor.
    for (let k = 0; k < n; k++) {
      const i = order[k];
      sx[k] = px[i];
      sy[k] = py[i];
      svx[k] = sox[i];
      svy[k] = soy[i];
    }
    for (let k = 0; k < n; k++) {
      sox[k] = svx[k];
      soy[k] = svy[k];
    }
    for (let k = 0; k < n; k++) {
      const i = order[k];
      svx[k] = pvx[i];
      svy[k] = pvy[i];
    }
  }

  /**
   * Pass one: density, near density, the outward gradient, and — on the last substep — a
   * kernel-smoothed velocity so the rod headings comb together instead of speckling.
   *
   * It gathers over the whole 3×3 stencil rather than scattering over half of it. That doubles
   * the distance tests and removes every scattered read-modify-write, which on this machine is a
   * little over twice as fast: the accumulators stay in registers, the loads are sequential, and
   * clamping the kernel with `Math.max` instead of a branch keeps a body that rejects two thirds
   * of its candidates free of mispredictions. The particle finds itself at distance zero, where
   * the kernel is 1 and its gradient vanishes, so it needs no special case — only a rest density
   * that counts it.
   *
   * The rows that survive are appended to a neighbour list. `relax` is the expensive pass, and
   * this is what lets it visit ten neighbours instead of thirty candidates.
   */
  private density(n: number, smooth: boolean): void {
    const { sx, sy, svx, svy, rho, near, sgx, sgy, sfx, sfy, start, nbr, nx, ny } = this;
    let list = this.list;
    const invH2 = 1 / (this.h * this.h);
    let p = 0;
    for (let cy = 0; cy < ny; cy++) {
      for (let cx = 0; cx < nx; cx++) {
        const c = cy * nx + cx;
        const cs = start[c];
        const ce = start[c + 1];
        if (cs === ce) {
          continue;
        }
        // Each row of the stencil is one contiguous run once the particles are in cell order.
        const back = cx > 0 ? 1 : 0;
        const fwd = cx + 1 < nx ? 2 : 1;
        const lo0 = cy > 0 ? start[c - nx - back] : 0;
        const hi0 = cy > 0 ? start[c - nx + fwd] : 0;
        const lo1 = start[c - back];
        const hi1 = start[c + fwd];
        const lo2 = cy + 1 < ny ? start[c + nx - back] : 0;
        const hi2 = cy + 1 < ny ? start[c + nx + fwd] : 0;
        for (let k = cs; k < ce; k++) {
          if (p + PAIR_MARGIN > list.length) {
            list = this.growList(p);
          }
          nbr[k] = p;
          const xi = sx[k];
          const yi = sy[k];
          let ri = 0;
          let ni = 0;
          let gxi = 0;
          let gyi = 0;
          let fxi = 0;
          let fyi = 0;
          for (let row = 0; row < 3; row++) {
            let m = row === 0 ? lo0 : row === 1 ? lo1 : lo2;
            const me = row === 0 ? hi0 : row === 1 ? hi1 : hi2;
            for (; m < me; m++) {
              const dx = sx[m] - xi;
              const dy = sy[m] - yi;
              const w = Math.max(0, 1 - (dx * dx + dy * dy) * invH2);
              const w2 = w * w;
              ri += w2;
              ni += w2 * w;
              // ∇(1 - r²/h²)³ is parallel to d and scales with w², so no unit vector is needed.
              gxi -= dx * w2;
              gyi -= dy * w2;
              if (smooth) {
                fxi += svx[m] * w2;
                fyi += svy[m] * w2;
              }
              list[p] = m;
              // `+(w > 0)` and `w > 0 ? 1 : 0` are the same value, but TurboFan gives the first a
              // branchless coercion and the second a jump it mispredicts two thirds of the time.
              // On this loop that one expression is the difference between 3.5 and 15 ns a row.
              p += +(w > 0);
            }
          }
          rho[k] = ri;
          near[k] = ni;
          sgx[k] = gxi;
          sgy[k] = gyi;
          if (smooth) {
            sfx[k] = fxi;
            sfy[k] = fyi;
          }
        }
      }
    }
    nbr[n] = p;
    this.pairs = p;
  }

  private growList(used: number): Int32Array<ArrayBuffer> {
    const next = new Int32Array(this.list.length * 2);
    next.set(this.list.subarray(0, used));
    this.list = next;
    return next;
  }

  /**
   * Pass two, Clavet's double density relaxation, over the neighbours the density pass recorded.
   * Pressure displaces neighbours apart, and because it goes negative below the rest density the
   * mass holds together as a blob instead of spreading over the floor; viscosity takes the speed
   * out of pairs that are closing. Gathering makes it Jacobi rather than Gauss-Seidel, so the
   * displacements land in their own buffer and are applied once every row has read the old
   * positions.
   */
  private relax(n: number, dt: number): void {
    const { world, sx, sy, svx, svy, rho, near, prs, prsn, ddx, ddy, list, nbr } = this;
    const invH2 = 1 / (this.h * this.h);
    const pressure = world.get(Fluid.pressure);
    const kp = (STIFFNESS * pressure * this.h) / this.rest;
    const kn = (NEAR_STIFFNESS * pressure * this.h) / this.restNear;
    // Cohesion is its own gain, and saturates. Sharing the pressure gain makes the two fight:
    // stiffening the fluid against compression also strengthens the pull that caused it, and the
    // mass slams together into clumps hundreds of times the rest density.
    const kc = (COHESION * world.get(Fluid.cohesion) * this.h) / this.rest;
    const grip = COHESION_RANGE * this.rest;
    const dt2 = dt * dt * 0.5;
    const viscosity = world.get(Fluid.viscosity);
    const sigma = viscosity * 5;
    const beta = viscosity * 2;
    const rest = this.rest;
    for (let k = 0; k < n; k++) {
      const d = rho[k] - rest;
      prs[k] = d >= 0 ? kp * d : -kc * (d < -grip ? grip : -d);
      prsn[k] = kn * near[k];
    }
    for (let k = 0; k < n; k++) {
      const xi = sx[k];
      const yi = sy[k];
      const vxi = svx[k];
      const vyi = svy[k];
      const pi = prs[k];
      const pni = prsn[k];
      const e = nbr[k + 1];
      let ax = 0;
      let ay = 0;
      for (let j = nbr[k]; j < e; j++) {
        const m = list[j];
        const dx = sx[m] - xi;
        const dy = sy[m] - yi;
        const r2 = dx * dx + dy * dy;
        const q = Math.max(0, 1 - r2 * invH2);
        // The separation has to be normalised. Displacing along d instead saves a root and a
        // divide, but the repulsion then falls to nothing as the separation does, and the fluid
        // collapses into clumps hundreds of times the rest density. At exactly zero the
        // direction is zero as well, so a particle still cannot push itself.
        const invR = 1 / Math.sqrt(r2 + 1e-12);
        const ux = dx * invR;
        const uy = dy * invR;
        // u > 0 means the pair is closing. Clavet's impulse takes that speed off both, so over
        // one step it reads as extra separation — the same sign as pressure, not the opposite.
        // Getting it backwards feeds the fluid energy and it boils.
        const u = Math.max(0, (vxi - svx[m]) * ux + (vyi - svy[m]) * uy);
        const d = dt2 * ((pi + prs[m]) * q + (pni + prsn[m]) * q * q + q * u * (sigma + beta * u));
        ax -= ux * d;
        ay -= uy * d;
      }
      ddx[k] = ax;
      ddy[k] = ay;
    }
    // Cap the step. The scheme is conditionally stable, and the pointer can concentrate the mass
    // faster than the pressure answers; without this the relaxation overshoots, piles rows into a
    // single grid cell and the next pass goes quadratic. Clamping the displacement — not the
    // pressure — keeps the fluid stiff while making a blow-up impossible.
    const limit = MAX_STEP * this.h;
    const limit2 = limit * limit;
    for (let k = 0; k < n; k++) {
      const dx = ddx[k];
      const dy = ddy[k];
      const d2 = dx * dx + dy * dy;
      if (d2 > limit2) {
        const scale = limit / Math.sqrt(d2);
        sx[k] += dx * scale;
        sy[k] += dy * scale;
      } else {
        sx[k] += dx;
        sy[k] += dy;
      }
    }
  }

  /** Walls, the velocity implied by the relaxed positions, and the scatter back to slot order. */
  private settle(n: number, dt: number, last: boolean): void {
    const { sx, sy, sox, soy, sgx, sgy, sfx, sfy, rho, order } = this;
    const { px, py, pvx, pvy, pgx, pgy, prho, pfx, pfy } = this;
    const m = this.spacing * 0.5;
    const xMax = this.aspect - m;
    const yMax = 1 - m;
    const invDt = 1 / dt;
    const invRest = 1 / this.rest;
    const max2 = MAX_SPEED * MAX_SPEED;
    for (let k = 0; k < n; k++) {
      let x = sx[k];
      let y = sy[k];
      // Written so a NaN lands at the origin rather than escaping the box: an escaped particle
      // would collapse the whole population into one grid cell and make the next step quadratic.
      x = x > -xMax ? (x < xMax ? x : xMax) : -xMax;
      y = y > -yMax ? (y < yMax ? y : yMax) : -yMax;
      let vx = (x - sox[k]) * invDt;
      let vy = (y - soy[k]) * invDt;
      const v2 = vx * vx + vy * vy;
      if (v2 > max2) {
        const s = MAX_SPEED / Math.sqrt(v2);
        vx *= s;
        vy *= s;
      }
      const i = order[k];
      px[i] = x;
      py[i] = y;
      pvx[i] = vx;
      pvy[i] = vy;
      if (last) {
        pgx[i] = sgx[k] * invRest;
        pgy[i] = sgy[k] * invRest;
        prho[i] = rho[k];
        pfx[i] = sfx[k];
        pfy[i] = sfy[k];
      }
    }
  }

  /**
   * Columns get the packed results back. Heading, hue and the shadow map advance here, on the
   * columns themselves, so the whole per-particle pass costs one walk.
   */
  private scatter(n: number, dt: number): void {
    const { world, px, py, pvx, pvy, pgx, pgy, prho, pfx, pfy, cover, counts } = this;
    const t = this.time;
    const H = (this.hue = fract(this.hue + world.get(Fluid.drift) * dt));
    const hueK = Math.min(1, dt * 1.1);
    const invRest = 1 / this.rest;
    const cw = COVER_W / (2 * this.aspect);
    const ch = COVER_H / 2;
    counts.fill(0);
    let slot = 0;
    for (const chunk of this.drops.chunks()) {
      const len = chunk.length;
      const p = chunk.get(Position);
      const v = chunk.get(Velocity);
      const g = chunk.get(Surface);
      const { dx, dy } = chunk.get(Rod);
      const { hue } = chunk.get(Tint);
      p.x.set(px.subarray(slot, slot + len));
      p.y.set(py.subarray(slot, slot + len));
      v.x.set(pvx.subarray(slot, slot + len));
      v.y.set(pvy.subarray(slot, slot + len));
      g.gx.set(pgx.subarray(slot, slot + len));
      g.gy.set(pgy.subarray(slot, slot + len));
      const { x, y } = p;
      const rho = g.rho;
      for (let i = 0; i < len; i++) {
        const j = slot + i;
        const X = x[i];
        const Y = y[i];
        const d = prho[j] * invRest;
        rho[i] = d;

        // The heading follows the SPH-smoothed flow, so neighbours comb the same way.
        const inv = 1 / prho[j];
        const fx = pfx[j] * inv;
        const fy = pfy[j] * inv;
        const speed = Math.sqrt(fx * fx + fy * fy);
        let hx = dx[i];
        let hy = dy[i];
        let tx: number;
        let ty: number;
        if (speed > 0.05) {
          tx = fx / speed;
          ty = fy / speed;
          // A rod has no head or tail; take whichever end is already closer.
          if (tx * hx + ty * hy < 0) {
            tx = -tx;
            ty = -ty;
          }
        } else {
          const im = 1 / Math.sqrt(hx * hx + hy * hy + 1e-9);
          tx = hx * im;
          ty = hy * im;
        }
        const mag = 0.42 + (0.58 * speed) / (speed + 1.1);
        const k = Math.min(1, dt * (2.5 + 6 * speed));
        hx += (tx * mag - hx) * k;
        hy += (ty * mag - hy) * k;
        dx[i] = hx;
        dy[i] = hy;

        // The drift leads and lags by region, so the flow stirs the hue into streaks. A folded
        // parabola stands in for a sine here: 30k transcendentals a frame is not worth the shape.
        const bx = wave(X * 0.38 + t * 0.049);
        const by = wave(Y * 0.48 - t * 0.038);
        const band = bx * by;
        let dh = H + band * 0.075 - hue[i];
        dh -= Math.round(dh);
        hue[i] = fract(hue[i] + dh * hueK);

        let ux = ((X + this.aspect) * cw) | 0;
        let uy = ((1 - Y) * ch) | 0;
        ux = ux < 0 ? 0 : ux >= COVER_W ? COVER_W - 1 : ux;
        uy = uy < 0 ? 0 : uy >= COVER_H ? COVER_H - 1 : uy;
        counts[uy * COVER_W + ux]++;
      }
      chunk.markChanged(Position);
      chunk.markChanged(Velocity);
      chunk.markChanged(Surface);
      chunk.markChanged(Rod);
      chunk.markChanged(Tint);
      slot += len;
    }
    // Saturating: a couple of particles deep already casts a full shadow.
    const scale = (255 * COVER_W * COVER_H) / (n * 3);
    for (let i = 0; i < cover.length; i++) {
      const c = counts[i] * scale;
      cover[i] = c > 255 ? 255 : c;
    }
  }
}

function fract(x: number): number {
  return x - Math.floor(x);
}

/** A cosine in spirit: a triangle rounded by a parabola, unit period, range [-1, 1]. */
function wave(x: number): number {
  const p = x - Math.floor(x);
  const t = 2 * Math.abs(2 * p - 1) - 1;
  return t * (2 - (t < 0 ? -t : t));
}

export function fmt(n: number): string {
  return n.toLocaleString('en-US');
}
