/**
 * The simulation: every particle is an entity, every frame is a chunk walk.
 *
 * Nothing here knows about the GPU. The renderer reads the same column pages
 * this file writes, which is the whole point of the demo.
 */
import { Not, Trait, World, eid, f32 } from 'apecs';
import type { Entity } from 'apecs';

export const Position = new Trait({ x: f32(0), y: f32(0) });
export const Velocity = new Trait({ x: f32(0), y: f32(0) });
/** A burning particle. Holding it moves the entity to another archetype — and another draw call. */
export const Ember = new Trait({ life: f32(1) });

/** World traits: singletons on the world entity, readable from React like any other. */
export const Attractor = new Trait({ x: f32(0), y: f32(0), strength: f32(1) });
export const Physics = new Trait({ gravity: f32(0.9), swirl: f32(0.8), drag: f32(0.25) });
export const Selection = new Trait({ entity: eid(0) });
export const Stats = new Trait({
  count: 0,
  embers: 0,
  sim: f32(0),
  upload: f32(0),
  frame: f32(0),
  fps: f32(0),
  draws: 0,
  chunks: 0,
  lastOp: '',
  lastOpMs: f32(0),
});

/** 4096 rows × four f32 columns is 64 KB per chunk: the whole working set of a page fits in L1/L2. */
export const PAGE_SIZE = 4096;
const SOFTENING = 0.015;
const EMBER_SECONDS = 3.5;

export class Sim {
  public readonly world = new World({ pageSize: PAGE_SIZE, maxEntities: 1 << 22 });
  public readonly base = this.world.query(Position, Velocity, Not(Ember));
  public readonly embers = this.world.query(Position, Velocity, Ember);

  /** World half-extent on x; y spans [-1, 1]. */
  public aspect = 1.6;
  public time = 0;

  private targetX = 0;
  private targetY = 0;
  private targetStrength = 1;
  private scratch = new Float64Array(1 << 16);

  public constructor(count: number) {
    this.world.add(Attractor, Physics, Selection, Stats);
    this.resize(count);
  }

  public get count(): number {
    return this.base.count + this.embers.count;
  }

  /** Grow or shrink the population with one structural operation. */
  public resize(count: number): void {
    const { world } = this;
    const current = this.count;
    const t0 = performance.now();
    if (count > current) {
      const batch = world.spawnMany(count - current, Position, Velocity);
      const spawnMs = performance.now() - t0;
      const px = world.accessor(Position.x);
      const py = world.accessor(Position.y);
      const vx = world.accessor(Velocity.x);
      const vy = world.accessor(Velocity.y);
      const aspect = this.aspect;
      for (let i = 0; i < batch.length; i++) {
        const e = batch[i] as Entity;
        const angle = Math.random() * Math.PI * 2;
        const radius = Math.sqrt(Math.random()) * 0.95;
        const speed = 0.2 + Math.random() * 0.7;
        px.set(e, Math.cos(angle) * radius * aspect);
        py.set(e, Math.sin(angle) * radius);
        vx.set(e, -Math.sin(angle) * speed);
        vy.set(e, Math.cos(angle) * speed);
      }
      this.report(`spawnMany(${fmt(count - current)})`, spawnMs);
    } else if (count < current) {
      const all = world.query(Position).entities();
      world.despawnMany(all.subarray(0, current - count));
      this.report(`despawnMany(${fmt(current - count)})`, performance.now() - t0);
    }
  }

  public setTarget(x: number, y: number, strength: number): void {
    this.targetX = x;
    this.targetY = y;
    this.targetStrength = strength;
  }

  /** Everything within `radius` of the attractor catches fire: one `addMany`. */
  public ignite(radius: number): number {
    const { world } = this;
    const ax = world.get(Attractor.x);
    const ay = world.get(Attractor.y);
    const r2 = radius * radius;
    let n = 0;
    for (const chunk of this.base.chunks()) {
      const { x, y } = chunk.get(Position);
      const entities = chunk.entities;
      for (let i = 0, len = chunk.length; i < len; i++) {
        const dx = x[i] - ax;
        const dy = y[i] - ay;
        if (dx * dx + dy * dy < r2) {
          if (n === this.scratch.length) {
            this.grow();
          }
          this.scratch[n++] = entities[i];
        }
      }
    }
    const t0 = performance.now();
    world.addMany(this.scratch.subarray(0, n), Ember);
    this.report(`addMany(${fmt(n)}, Ember)`, performance.now() - t0);
    return n;
  }

  public extinguish(): void {
    const batch = this.embers.entities();
    const t0 = performance.now();
    this.world.removeMany(batch, Ember);
    this.report(`removeMany(${fmt(batch.length)}, Ember)`, performance.now() - t0);
  }

  public step(dt: number): void {
    const { world } = this;
    this.time += dt;

    // Ease the attractor toward its target so the swarm never snaps.
    const k = 1 - Math.exp(-dt * 10);
    const ax = world.get(Attractor.x) + (this.targetX - world.get(Attractor.x)) * k;
    const ay = world.get(Attractor.y) + (this.targetY - world.get(Attractor.y)) * k;
    world.set(Attractor, { x: ax, y: ay, strength: this.targetStrength });

    const gravity = world.get(Physics.gravity) * this.targetStrength;
    const swirl = world.get(Physics.swirl);
    const drag = Math.exp(-world.get(Physics.drag) * dt);
    const aspect = this.aspect;

    for (const chunk of this.base.chunks()) {
      const p = chunk.get(Position);
      const v = chunk.get(Velocity);
      integrate(p.x, p.y, v.x, v.y, chunk.length, dt, ax, ay, gravity, swirl, drag, aspect);
      // Direct page writes bypass change ticks; this is what lets the inspector follow a particle.
      chunk.markChanged(Position);
      chunk.markChanged(Velocity);
    }

    let dead = 0;
    const emberDrag = Math.exp(-2.2 * dt);
    const time = this.time;
    for (const chunk of this.embers.chunks()) {
      const p = chunk.get(Position);
      const v = chunk.get(Velocity);
      const { life } = chunk.get(Ember);
      const { x, y } = p;
      const { x: vx, y: vy } = v;
      const entities = chunk.entities;
      for (let i = 0, n = chunk.length; i < n; i++) {
        const px = x[i];
        const py = y[i];
        const l = life[i] - dt / EMBER_SECONDS;
        life[i] = l;
        if (l <= 0) {
          if (dead === this.scratch.length) {
            this.grow();
          }
          this.scratch[dead++] = entities[i];
        }
        const turbulence = 3 * l;
        const nvx = (vx[i] + Math.sin(py * 9 + time * 4 + px * 3) * turbulence * dt) * emberDrag;
        const nvy = (vy[i] + (1.1 + Math.cos(px * 7 - time * 3) * turbulence) * dt) * emberDrag;
        vx[i] = nvx;
        vy[i] = nvy;
        x[i] = px + nvx * dt;
        y[i] = py + nvy * dt;
      }
      chunk.markChanged(Position);
      chunk.markChanged(Velocity);
      chunk.markChanged(Ember);
    }
    if (dead > 0) {
      world.removeMany(this.scratch.subarray(0, dead), Ember);
    }
    world.step();
  }

  private grow(): void {
    const next = new Float64Array(this.scratch.length * 2);
    next.set(this.scratch);
    this.scratch = next;
  }

  private report(op: string, ms: number): void {
    this.world.set(Stats, { lastOp: op, lastOpMs: ms });
  }
}

/** The hot loop: one page of one archetype, four typed arrays, no calls. */
function integrate(
  x: Float32Array,
  y: Float32Array,
  vx: Float32Array,
  vy: Float32Array,
  n: number,
  dt: number,
  ax: number,
  ay: number,
  gravity: number,
  swirl: number,
  drag: number,
  aspect: number,
): void {
  for (let i = 0; i < n; i++) {
    const px = x[i];
    const py = y[i];
    const dx = ax - px;
    const dy = ay - py;
    const inv = 1 / Math.sqrt(dx * dx + dy * dy + SOFTENING);
    const pull = gravity * inv;
    const spin = swirl * inv * 0.25;
    const nvx = (vx[i] + (dx * pull - dy * spin) * inv * dt) * drag;
    const nvy = (vy[i] + (dy * pull + dx * spin) * inv * dt) * drag;
    let nx = px + nvx * dt;
    let ny = py + nvy * dt;
    let bx = nvx;
    let by = nvy;
    if (nx > aspect) {
      nx = aspect;
      bx = -nvx * 0.6;
    } else if (nx < -aspect) {
      nx = -aspect;
      bx = -nvx * 0.6;
    }
    if (ny > 1) {
      ny = 1;
      by = -nvy * 0.6;
    } else if (ny < -1) {
      ny = -1;
      by = -nvy * 0.6;
    }
    x[i] = nx;
    y[i] = ny;
    vx[i] = bx;
    vy[i] = by;
  }
}

export function fmt(n: number): string {
  return n.toLocaleString('en-US');
}
