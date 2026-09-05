import { Trait, World, bool, f32 } from 'apecs';
import type { Entity } from 'apecs';

export const Position = new Trait({ x: f32(0), y: f32(0) });
export const Velocity = new Trait({ x: f32(0), y: f32(0) });
/**
 * What the rod shader draws: a heading whose length tracks the local speed. Depth inside the slab
 * is not simulation data — the shader hashes it from the instance index, which also keeps the
 * column count inside WebGPU's eight vertex buffers.
 */
export const Rod = new Trait({ dx: f32(1), dy: f32(0) });
export const Tint = new Trait({ hue: f32(0) });
/** Solver output the shader shades with: the outward density gradient and the density itself. */
export const Surface = new Trait({ gx: f32(0), gy: f32(0), rho: f32(1) });

/** World traits: singletons on the world entity, written by the UI and read by the solver. */
export const Swarm = new Trait({
  align: f32(1),
  cohere: f32(1),
  separate: f32(1),
  flow: f32(1),
  churn: f32(1),
  speed: f32(1),
  drift: f32(0.055),
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

/** Fraction of the box the swarm covers when evenly spread; with the count it fixes the spacing. */
const FILL = 0.8;
/**
 * Neighbourhood radius in rest spacings. Boids need only a handful of neighbours, and the pair
 * count grows with the square of this, so it is the cheapest knob in the solver.
 */
const RADIUS = 1.45;
/** Cruise speed. Everything is steered back toward it, which is what keeps the flock coherent. */
const CRUISE = 0.66;
const MAX_SPEED = 2.6;
/** How hard a body is pulled back to cruise speed, per second. */
const SPEED_REGULATION = 2.6;
const ALIGN = 8;
// Weak on purpose. Cohesion and the ambient field reinforce each other: turn it up and the flock
// stops being a volume and collapses onto the field's streamlines as a few thin ribbons.
const COHERE = 2.4;
const SEPARATE = 70;
const FLOW = 2.0;
/** Distance from a wall at which bodies start turning away, and how hard they turn. */
const WALL_MARGIN = 0.09;
const WALL = 12;
const BOUNCE = 0.45;
const STIR_RADIUS = 0.34;
const STIR = 12;
const PULL = 3;
/**
 * Ceiling on the velocity the pointer may impart, as a multiple of cruise. A fast sweep across the
 * canvas is several units a second — far more than the swarm ever reaches on its own — and handing
 * that straight to the bodies moves them more than a neighbourhood radius in one step, which
 * destroys the neighbourhood the solver just measured.
 */
const STIR_SPEED = 1.6;
/** Room left in the neighbour list for one more row, so the append needs no bounds test. */
const PAIR_MARGIN = 512;
/** Most neighbours any one body steers by. */
const MAX_NEIGHBOURS = 48;

/** Resolution of the ambient flow field. It is smooth, so it can be very coarse. */
const FLOW_W = 37;
const FLOW_H = 25;
/**
 * The flow field is the curl of this stream function, which makes it divergence-free: the swarm is
 * carried and folded but never piled up or torn apart. Three scales, each drifting at its own rate,
 * so the cells are always rearranging and never repeat.
 */
const CELLS = [
  { kx: 1.7, ky: 2.1, wx: 0.13, wy: -0.09, a: 1.0 },
  { kx: 3.3, ky: 2.7, wx: -0.21, wy: 0.17, a: 0.45 },
  { kx: 5.3, ky: 4.3, wx: 0.31, wy: 0.27, a: 0.2 },
];

export class Sim {
  public readonly world = new World({ pageSize: PAGE_SIZE, maxEntities: 1 << 18 });
  public readonly bodies = this.world.query(Position, Velocity, Rod, Tint, Surface);

  /** Box half-extent on x; y spans [-1, 1]. */
  public aspect = 1.6;
  public time = 0;
  public spacing = 0.01;
  public hue = 0.32;
  public pairs = 0;
  public readonly cover = new Uint8Array(COVER_W * COVER_H);

  private h = 0.02;
  private rest = 1;
  private nx = 1;
  private ny = 1;
  private capacity = 0;
  private burstX = 0;
  private burstY = 0;
  private burstLeft = 0;

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
  // Cell order: the neighbour pass runs here, so a cell's bodies share cache lines.
  private sx = new Float32Array(0);
  private sy = new Float32Array(0);
  private svx = new Float32Array(0);
  private svy = new Float32Array(0);
  private rho = new Float32Array(0);
  private prs = new Float32Array(0);
  private sgx = new Float32Array(0);
  private sgy = new Float32Array(0);
  private sfx = new Float32Array(0);
  private sfy = new Float32Array(0);
  private order = new Int32Array(0);
  private cell = new Int32Array(0);
  private start = new Int32Array(0);
  private cursor = new Int32Array(0);
  /** In-range neighbours per row, recorded by the density pass for the separation pass to reuse. */
  private list: Int32Array<ArrayBuffer> = new Int32Array(0);
  private nbr = new Int32Array(0);
  private counts = new Uint16Array(COVER_W * COVER_H);
  private readonly flowU = new Float32Array(FLOW_W * FLOW_H);
  private readonly flowV = new Float32Array(FLOW_W * FLOW_H);

  public constructor(count: number) {
    this.world.add(Swarm, Pointer, Stats);
    this.resize(count);
  }

  public get count(): number {
    return this.bodies.count;
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
      this.world.despawnMany(this.bodies.entities().subarray(0, current - count));
      this.fit(count);
    }
  }

  /** Scatter the flock with a single impulse, then let it re-form. */
  public burst(): void {
    const angle = Math.random() * Math.PI * 2;
    this.burstX = Math.cos(angle) * 14;
    this.burstY = Math.sin(angle) * 14;
    this.burstLeft = 0.22;
  }

  public step(dt: number): void {
    const { world } = this;
    const n = this.count;
    this.time += dt;
    if (n === 0) {
      return;
    }

    let slot = 0;
    for (const chunk of this.bodies.chunks()) {
      const len = chunk.length;
      this.px.set(chunk.column(Position.x).subarray(0, len), slot);
      this.py.set(chunk.column(Position.y).subarray(0, len), slot);
      this.pvx.set(chunk.column(Velocity.x).subarray(0, len), slot);
      this.pvy.set(chunk.column(Velocity.y).subarray(0, len), slot);
      slot += len;
    }

    this.field();
    this.sort(n);
    this.density(n);
    this.steer(n, dt);
    this.scatter(n, dt);
    world.step();
  }

  private fit(count: number): void {
    const s = Math.sqrt((FILL * 4 * this.aspect) / Math.max(count, 1));
    const h = s * RADIUS;
    const perArea = 2 / (Math.sqrt(3) * s * s);
    this.spacing = s;
    this.h = h;
    // Kernel is q = 1 - r²/h²: ∫q² over the disc is πh²/3, plus the body itself.
    this.rest = (perArea * Math.PI * h * h) / 3 + 1;
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
      this.svx = new Float32Array(capacity);
      this.svy = new Float32Array(capacity);
      this.rho = new Float32Array(capacity);
      this.prs = new Float32Array(capacity);
      this.sgx = new Float32Array(capacity);
      this.sgy = new Float32Array(capacity);
      this.sfx = new Float32Array(capacity);
      this.sfy = new Float32Array(capacity);
      this.order = new Int32Array(capacity);
      this.cell = new Int32Array(capacity);
      this.nbr = new Int32Array(capacity + 1);
      this.list = new Int32Array(capacity * 16 + PAIR_MARGIN);
    }
  }

  /** Bodies start spread through the box, already flying along the field they will be steered by. */
  private spawn(count: number): void {
    const { world } = this;
    const batch = world.spawnMany(count, Position, Velocity, Rod, Tint, Surface);
    const px = world.accessor(Position.x);
    const py = world.accessor(Position.y);
    const vx = world.accessor(Velocity.x);
    const vy = world.accessor(Velocity.y);
    const dx = world.accessor(Rod.dx);
    const dy = world.accessor(Rod.dy);
    const hue = world.accessor(Tint.hue);
    const a = this.aspect - this.spacing;
    for (let i = 0; i < batch.length; i++) {
      const e = batch[i] as Entity;
      const x = (Math.random() * 2 - 1) * a * 0.9;
      const y = (Math.random() * 2 - 1) * 0.9;
      const angle = 2.4 * Math.sin(x * 2.3) + 1.7 * Math.cos(y * 1.9 + 0.7);
      px.set(e, x);
      py.set(e, y);
      vx.set(e, Math.cos(angle) * CRUISE);
      vy.set(e, Math.sin(angle) * CRUISE);
      dx.set(e, Math.cos(angle) * 0.6);
      dy.set(e, Math.sin(angle) * 0.6);
      hue.set(e, this.hue + (Math.random() - 0.5) * 0.02);
    }
  }

  /**
   * Rebuild the ambient flow field: the curl of a drifting stream function, sampled on a grid too
   * coarse to cost anything. Taking the curl rather than the gradient is what gives the swarm
   * several simultaneous directions — cells that turn against each other and fold the flock —
   * instead of one basin everything slides into.
   */
  private field(): void {
    const { flowU, flowV } = this;
    const t = this.time * this.world.get(Swarm.churn);
    const a = this.aspect;
    const dx = (2 * a) / (FLOW_W - 1);
    const dy = 2 / (FLOW_H - 1);
    // Half a cell, so the differences below land on the node itself.
    const ex = dx * 0.5;
    const ey = dy * 0.5;
    for (let j = 0; j < FLOW_H; j++) {
      const y = -1 + j * dy;
      for (let i = 0; i < FLOW_W; i++) {
        const x = -a + i * dx;
        flowU[j * FLOW_W + i] = (stream(x, y + ey, t) - stream(x, y - ey, t)) / dy;
        flowV[j * FLOW_W + i] = -(stream(x + ex, y, t) - stream(x - ex, y, t)) / dx;
      }
    }
  }

  /** Counting sort by grid cell; the sorted copies are what the neighbour pass reads. */
  private sort(n: number): void {
    const { px, py, pvx, pvy, sx, sy, svx, svy, order, cell, start, cursor } = this;
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
    for (let k = 0; k < n; k++) {
      const i = order[k];
      sx[k] = px[i];
      sy[k] = py[i];
      svx[k] = pvx[i];
      svy[k] = pvy[i];
    }
  }

  /**
   * The one neighbour pass: crowding, the direction away from the neighbours, and their average
   * heading — separation, cohesion and alignment all come out of these three.
   *
   * It gathers over the whole 3×3 stencil rather than scattering over half of it. That doubles the
   * distance tests and removes every scattered read-modify-write, which on this machine is a little
   * over twice as fast: the accumulators stay in registers, the loads are sequential, and clamping
   * the kernel with `Math.max` instead of a branch keeps a body that rejects two thirds of its
   * candidates free of mispredictions. A body finds itself at distance zero, where the kernel is 1
   * and its gradient vanishes, so it needs no special case — only a rest density that counts it.
   *
   * The rows that survive are appended to a neighbour list, which is what lets the separation pass
   * visit six neighbours instead of twenty candidates.
   */
  private density(n: number): void {
    const { sx, sy, svx, svy, rho, sgx, sgy, sfx, sfy, start, nbr, nx, ny } = this;
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
        // Each row of the stencil is one contiguous run once the bodies are in cell order.
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
              // ∇(1 - r²/h²)³ is parallel to d and scales with w², so no unit vector is needed.
              gxi -= dx * w2;
              gyi -= dy * w2;
              fxi += svx[m] * w2;
              fyi += svy[m] * w2;
              list[p] = m;
              // `+(w > 0)` and `w > 0 ? 1 : 0` are the same value, but TurboFan gives the first a
              // branchless coercion and the second a jump it mispredicts two thirds of the time.
              // On this loop that one expression is the difference between 3.5 and 15 ns a row.
              p += +(w > 0);
            }
          }
          // Six neighbours steer as well as six hundred, and this keeps a pathological packing
          // from growing the list without bound.
          if (p - nbr[k] > MAX_NEIGHBOURS) {
            p = nbr[k] + MAX_NEIGHBOURS;
          }
          rho[k] = ri;
          sgx[k] = gxi;
          sgy[k] = gyi;
          sfx[k] = fxi;
          sfy[k] = fyi;
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
   * Reynolds' three rules, plus the ambient field and the walls.
   *
   * Separation is the only one that needs the neighbours individually: crowding is a scalar, and a
   * uniformly over-dense patch has no gradient to push along, so the force has to come from the
   * pressure of each neighbour in turn. Cohesion and alignment are already answered by the
   * aggregates — the density gradient points out of the flock, and the kernel-weighted velocity is
   * what the neighbours are doing on average.
   */
  private steer(n: number, dt: number): void {
    const { world, sx, sy, svx, svy, rho, prs, sgx, sgy, sfx, sfy, list, nbr } = this;
    const { flowU, flowV, order, px, py, pvx, pvy, pgx, pgy, prho, pfx, pfy } = this;
    const rest = this.rest;
    const invRest = 1 / rest;
    const invH2 = 1 / (this.h * this.h);
    const kSep = SEPARATE * world.get(Swarm.separate) * this.h;
    const kAlign = ALIGN * world.get(Swarm.align);
    const kCohere = (COHERE * world.get(Swarm.cohere)) / (rest * this.h);
    const kFlow = FLOW * world.get(Swarm.flow);
    const cruise = CRUISE * world.get(Swarm.speed);

    const on = world.get(Pointer.on);
    const qx = world.get(Pointer.x);
    const qy = world.get(Pointer.y);
    let ux = world.get(Pointer.vx);
    let uy = world.get(Pointer.vy);
    const cap = cruise * STIR_SPEED;
    const us = Math.sqrt(ux * ux + uy * uy);
    if (us > cap) {
      ux = (ux / us) * cap;
      uy = (uy / us) * cap;
    }
    const pull = world.get(Pointer.hold) ? PULL : 0;
    const r2max = on ? STIR_RADIUS * STIR_RADIUS : 0;
    const invStir = 1 / (STIR_RADIUS * STIR_RADIUS);

    let bx = 0;
    let by = 0;
    if (this.burstLeft > 0) {
      this.burstLeft -= dt;
      bx = this.burstX;
      by = this.burstY;
    }

    // Crowding above the rest density, which is the only part separation answers to.
    for (let k = 0; k < n; k++) {
      const d = rho[k] - rest;
      prs[k] = d > 0 ? kSep * d : 0;
    }

    const a = this.aspect;
    const margin = this.spacing * 0.5;
    const xMax = a - margin;
    const yMax = 1 - margin;
    const fdx = (FLOW_W - 1) / (2 * a);
    const fdy = (FLOW_H - 1) / 2;
    const maxSpeed = MAX_SPEED * world.get(Swarm.speed);
    const max2 = maxSpeed * maxSpeed;

    for (let k = 0; k < n; k++) {
      const x = sx[k];
      const y = sy[k];
      let vx = svx[k];
      let vy = svy[k];

      // Separation.
      let ax = 0;
      let ay = 0;
      const pi = prs[k];
      const e = nbr[k + 1];
      for (let j = nbr[k]; j < e; j++) {
        const m = list[j];
        const dx = sx[m] - x;
        const dy = sy[m] - y;
        const r2 = dx * dx + dy * dy;
        const q = Math.max(0, 1 - r2 * invH2);
        // The direction has to be normalised. Along d alone the push falls to nothing as the
        // separation does, and bodies settle on top of each other instead of packing.
        const invR = 1 / Math.sqrt(r2 + 1e-12);
        const f = (pi + prs[m]) * q * invR;
        ax -= dx * f;
        ay -= dy * f;
      }

      // Cohesion: the density gradient points out of the flock, so steer back down it. Inside a
      // uniform patch it is zero, which is correct — only an edge pulls.
      ax -= sgx[k] * kCohere;
      ay -= sgy[k] * kCohere;

      // Alignment: match what the neighbourhood is doing.
      const inv = 1 / rho[k];
      const fx = sfx[k] * inv;
      const fy = sfy[k] * inv;
      ax += (fx - vx) * kAlign;
      ay += (fy - vy) * kAlign;

      // The ambient field, sampled bilinearly off the coarse grid.
      const gx = (x + a) * fdx;
      const gy = (y + 1) * fdy;
      let i0 = gx | 0;
      let j0 = gy | 0;
      i0 = i0 < 0 ? 0 : i0 > FLOW_W - 2 ? FLOW_W - 2 : i0;
      j0 = j0 < 0 ? 0 : j0 > FLOW_H - 2 ? FLOW_H - 2 : j0;
      const tx = gx - i0;
      const ty = gy - j0;
      const o = j0 * FLOW_W + i0;
      const w00 = (1 - tx) * (1 - ty);
      const w10 = tx * (1 - ty);
      const w01 = (1 - tx) * ty;
      const w11 = tx * ty;
      const fux =
        flowU[o] * w00 + flowU[o + 1] * w10 + flowU[o + FLOW_W] * w01 + flowU[o + FLOW_W + 1] * w11;
      const fuy =
        flowV[o] * w00 + flowV[o + 1] * w10 + flowV[o + FLOW_W] * w01 + flowV[o + FLOW_W + 1] * w11;
      ax += (fux * cruise - vx) * kFlow;
      ay += (fuy * cruise - vy) * kFlow;

      // Walls: turn away before arriving, so the flock banks instead of piling up.
      const dl = x + xMax;
      const dr = xMax - x;
      const db = y + yMax;
      const dt2 = yMax - y;
      if (dl < WALL_MARGIN) {
        const t = 1 - dl / WALL_MARGIN;
        ax += WALL * t * t;
      } else if (dr < WALL_MARGIN) {
        const t = 1 - dr / WALL_MARGIN;
        ax -= WALL * t * t;
      }
      if (db < WALL_MARGIN) {
        const t = 1 - db / WALL_MARGIN;
        ay += WALL * t * t;
      } else if (dt2 < WALL_MARGIN) {
        const t = 1 - dt2 / WALL_MARGIN;
        ay -= WALL * t * t;
      }

      // The pointer.
      const sdx = qx - x;
      const sdy = qy - y;
      const sr2 = sdx * sdx + sdy * sdy;
      if (sr2 < r2max) {
        const w = 1 - sr2 * invStir;
        const k2 = w * w;
        // A push along the pointer's motion, not a lock onto its velocity. Steering toward the
        // pointer's velocity damps bodies to a standstill whenever the cursor is still, and with
        // `hold` gathering more in behind them the flock packs into a knot separation cannot open.
        const room = 1 - rho[k] * invRest;
        const grip = room > 0 ? room : 0;
        ax += (ux * STIR + sdx * pull * grip) * k2;
        ay += (uy * STIR + sdy * pull * grip) * k2;
      }

      vx += (ax + bx) * dt;
      vy += (ay + by) * dt;

      // Hold everyone near cruise. Without this the flock separates into stalled clots and
      // bolting stragglers, and the rods stop reading as one body moving.
      const sp2 = vx * vx + vy * vy;
      if (sp2 > 1e-9) {
        const sp = Math.sqrt(sp2);
        const scale = 1 + (cruise / sp - 1) * Math.min(1, SPEED_REGULATION * dt);
        vx *= scale;
        vy *= scale;
      }
      if (sp2 > max2) {
        const scale = maxSpeed / Math.sqrt(sp2);
        vx *= scale;
        vy *= scale;
      }

      let nx2 = x + vx * dt;
      let ny2 = y + vy * dt;
      // Written so a NaN lands inside the box rather than escaping it: an escaped body would
      // collapse the whole population into one grid cell and make the next step quadratic.
      if (!(nx2 > -xMax)) {
        nx2 = -xMax;
        vx = Math.abs(vx) * BOUNCE;
      } else if (nx2 > xMax) {
        nx2 = xMax;
        vx = -Math.abs(vx) * BOUNCE;
      }
      if (!(ny2 > -yMax)) {
        ny2 = -yMax;
        vy = Math.abs(vy) * BOUNCE;
      } else if (ny2 > yMax) {
        ny2 = yMax;
        vy = -Math.abs(vy) * BOUNCE;
      }

      const i = order[k];
      px[i] = nx2;
      py[i] = ny2;
      pvx[i] = vx;
      pvy[i] = vy;
      pgx[i] = sgx[k] * invRest;
      pgy[i] = sgy[k] * invRest;
      prho[i] = rho[k];
      pfx[i] = fx;
      pfy[i] = fy;
    }
  }

  /**
   * Columns get the packed results back. Heading, hue and the shadow map advance here, on the
   * columns themselves, so the whole per-body pass costs one walk.
   */
  private scatter(n: number, dt: number): void {
    const { world, px, py, pvx, pvy, pgx, pgy, prho, pfx, pfy, cover, counts } = this;
    const t = this.time;
    const H = (this.hue = fract(this.hue + world.get(Swarm.drift) * dt));
    const hueK = Math.min(1, dt * 1.1);
    const invRest = 1 / this.rest;
    const cw = COVER_W / (2 * this.aspect);
    const ch = COVER_H / 2;
    counts.fill(0);
    let slot = 0;
    for (const chunk of this.bodies.chunks()) {
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
        rho[i] = prho[j] * invRest;

        // The heading follows the kernel-smoothed flow, so neighbours comb the same way.
        const fx = pfx[j];
        const fy = pfy[j];
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
        const mag = 0.42 + (0.58 * speed) / (speed + 0.75);
        const k = Math.min(1, dt * (3 + 5 * speed));
        hx += (tx * mag - hx) * k;
        hy += (ty * mag - hy) * k;
        dx[i] = hx;
        dy[i] = hy;

        // The drift leads and lags by region, so the flow stirs the hue into streaks. A folded
        // parabola stands in for a sine here: 24k transcendentals a frame is not worth the shape.
        const band = wave(X * 0.38 + t * 0.049) * wave(Y * 0.48 - t * 0.038);
        let dh = H + band * 0.075 - hue[i];
        dh -= Math.round(dh);
        hue[i] = fract(hue[i] + dh * hueK);

        let cx = ((X + this.aspect) * cw) | 0;
        let cy = ((1 - Y) * ch) | 0;
        cx = cx < 0 ? 0 : cx >= COVER_W ? COVER_W - 1 : cx;
        cy = cy < 0 ? 0 : cy >= COVER_H ? COVER_H - 1 : cy;
        counts[cy * COVER_W + cx]++;
      }
      chunk.markChanged(Position);
      chunk.markChanged(Velocity);
      chunk.markChanged(Surface);
      chunk.markChanged(Rod);
      chunk.markChanged(Tint);
      slot += len;
    }
    // Saturating: a couple of bodies deep already casts a full shadow.
    const scale = (255 * COVER_W * COVER_H) / (n * 3);
    for (let i = 0; i < cover.length; i++) {
      const c = counts[i] * scale;
      cover[i] = c > 255 ? 255 : c;
    }
  }
}

/** Three drifting scales of counter-rotating cells. The flow field is this function's curl. */
function stream(x: number, y: number, t: number): number {
  let s = 0;
  for (let i = 0; i < CELLS.length; i++) {
    const c = CELLS[i];
    s += c.a * Math.sin(c.kx * x + c.wx * t) * Math.sin(c.ky * y + c.wy * t);
  }
  return s;
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
