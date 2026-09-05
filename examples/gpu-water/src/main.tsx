import { With, World, type Entity } from 'apecs';
import { WorldProvider } from 'apecs/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import {
  FEEDBACK_BYTES,
  GRID,
  buildWorld,
  initGpu,
  resizeTargets,
  seedParticles,
  waterLine,
  type Gpu,
  type Resources,
} from './build';
import {
  BALL_MASS,
  BALL_RADIUS,
  dolly,
  orbit,
  pickRay,
  rebind,
  runChain,
  stepBall,
  syncSimShape,
  writeSim,
  writeView,
} from './frame';
import { Readback } from './readback';
import './styles.css';
import {
  Body,
  Buf,
  Camera,
  DrawPass,
  Held,
  Look,
  Pointer,
  Reads,
  Sim,
  SimPass,
  Spin,
  Stale,
  Tex,
  Time,
  Transform,
  Velocity,
  View,
  Viewport,
} from './traits';
import { Overlay } from './ui';

/**
 * A `World` subclass is the intended extension point (SPEC §5.2): the GPU
 * device and the resource handles are fields on the world, and every system in
 * `frame.ts` takes the world and nothing else.
 */
class Pool extends World {
  public gpu!: Gpu;
  public res!: Resources;
  public feedback!: Readback;
  public holdDistance = 0;

  public constructor() {
    super({ pageSize: 8192 });
    this.add(Time, Sim({ count: 196608, restDensity: 4 }), Look, Camera, Viewport, Pointer);

    // Resource lifetime, in two lines. Nothing else in this example calls
    // `destroy()`, and nothing else has to: despawning the entity is the API.
    this.on('remove', Buf, (e) => this.get(e, Buf).destroy());
    this.on('remove', Tex, (e) => this.get(e, Tex).destroy());

    // A resized texture is a new GPU object, so every bind group naming it is
    // stale. The relation index answers "who reads this?" without a back-pointer.
    this.on('change', Tex, (resource) => {
      for (const pass of this.query(Reads(resource))) {
        this.add(pass, Stale);
      }
    });
  }
}

const canvas = document.getElementById('gpu') as HTMLCanvasElement;
const world = new Pool();

async function boot(): Promise<void> {
  const gpu = await initGpu(canvas);
  world.gpu = gpu;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  canvas.width = w;
  canvas.height = h;
  world.set(Viewport, { w, h, dpr });

  const res = buildWorld(world, gpu, w, h);
  world.res = res;
  world.feedback = new Readback(res.feedbackStage, FEEDBACK_BYTES);

  // Mid-pool: far enough downstream that the front reaches it as a wave, not
  // close enough to the end wall to be pinned there by the first one.
  const line = waterLine(world.get(Sim.count));
  world.spawn(
    Transform({ x: GRID.x * 0.5, y: line + BALL_RADIUS * 0.5, z: GRID.z / 2, r: BALL_RADIUS }),
    Velocity,
    Spin,
    Body({
      invMass: 1 / BALL_MASS,
      invInertia: 1 / (0.4 * BALL_MASS * BALL_RADIUS * BALL_RADIUS),
      drag: 0.015,
      buoyancy: 1,
    }),
  );

  attachInput(gpu);
  requestAnimationFrame(loop);
}

/* ------------------------------------------------------------------- input */

const ray = new Float32Array(6);

function attachInput(gpu: Gpu): void {
  const observer = new ResizeObserver(() => {
    const dpr = world.get(Viewport.dpr);
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (w === world.get(Viewport.w) && h === world.get(Viewport.h)) {
      return;
    }
    canvas.width = w;
    canvas.height = h;
    world.set(Viewport, { w, h });
    resizeTargets(world, gpu, world.res, w, h);
  });
  observer.observe(canvas);

  const local = (ev: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    const dpr = world.get(Viewport.dpr);
    return [(ev.clientX - rect.left) * dpr, (ev.clientY - rect.top) * dpr] as const;
  };

  canvas.addEventListener('pointerdown', (ev) => {
    const [x, y] = local(ev);
    world.set(Pointer, { x, y, down: true });
    canvas.setPointerCapture(ev.pointerId);

    const ball = world.queryFirst(Body);
    if (ball !== undefined && hitsBall(ball, x, y)) {
      world.add(ball, Held);
      return;
    }
    world.set(Pointer.orbiting, true);
  });

  canvas.addEventListener('pointermove', (ev) => {
    const [x, y] = local(ev);
    const dx = x - world.get(Pointer.x);
    const dy = y - world.get(Pointer.y);
    world.set(Pointer, { x, y, dx, dy });
    if (world.get(Pointer.orbiting)) {
      orbit(world, dx, dy);
    }
  });

  const release = () => {
    world.set(Pointer, { down: false, orbiting: false, dx: 0, dy: 0 });
    const ball = world.queryFirst(Body);
    if (ball !== undefined && world.has(ball, Held)) {
      world.remove(ball, Held);
    }
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault();
      dolly(world, ev.deltaY);
    },
    { passive: false },
  );
}

function hitsBall(ball: Entity, px: number, py: number): boolean {
  pickRay(world, px, py, ray);
  const cx = world.get(ball, Transform.x) - ray[3];
  const cy = world.get(ball, Transform.y) - ray[4];
  const cz = world.get(ball, Transform.z) - ray[5];
  const along = cx * ray[0] + cy * ray[1] + cz * ray[2];
  if (along <= 0) {
    return false;
  }
  const r = world.get(ball, Transform.r);
  const perp = cx * cx + cy * cy + cz * cz - along * along;
  if (perp > r * r) {
    return false;
  }
  world.holdDistance = along - Math.sqrt(r * r - perp);
  return true;
}

const HELD = With(Held);

/** The held ball is kinematic: the pointer writes its position, the fluid reads it. */
function dragHeld(dt: number): void {
  const px = world.get(Pointer.x);
  const py = world.get(Pointer.y);
  world.query(Transform, Velocity, HELD).each((t, v) => {
    pickRay(world, px, py, ray);
    const r = t.r;
    const nx = Math.min(GRID.x - r, Math.max(r, ray[3] + ray[0] * world.holdDistance));
    const ny = Math.min(GRID.y - r, Math.max(r, ray[4] + ray[1] * world.holdDistance));
    const nz = Math.min(GRID.z - r, Math.max(r, ray[5] + ray[2] * world.holdDistance));
    // Capped, because a flick that moves the ball further than a cell per
    // substep punches a hole through the neighbourhood instead of splashing.
    const cap = 5;
    v.x = Math.min(cap, Math.max(-cap, (nx - t.x) / dt));
    v.y = Math.min(cap, Math.max(-cap, (ny - t.y) / dt));
    v.z = Math.min(cap, Math.max(-cap, (nz - t.z) / dt));
    t.x += v.x * dt;
    t.y += v.y * dt;
    t.z += v.z * dt;
  });
}

/* -------------------------------------------------------------------- loop */

const ZERO = new Int32Array(FEEDBACK_BYTES / 4);
let previous = 0;

function loop(now: number): void {
  requestAnimationFrame(loop);
  const dt = previous === 0 ? 1 / 60 : Math.min(0.05, (now - previous) / 1000);
  previous = now;

  world.step();
  world.set(Time, { delta: dt, current: world.get(Time.current) + dt, frame: world.tick });

  syncSimShape(world, world.gpu.device, world.res, seedParticles);
  rebind(world);

  const sim = world.get(Sim);
  const step = sim.dt * sim.substeps;
  dragHeld(step);
  stepBall(world, world.feedback, step);

  writeView(world, world.gpu.device, world.res);
  writeSim(world, world.gpu.device, world.res);
  world.set(world.res.swapchain, View, world.gpu.context.getCurrentTexture().createView());

  const device = world.gpu.device;
  device.queue.writeBuffer(world.get(world.res.feedback, Buf), 0, ZERO);
  const encoder = device.createCommandEncoder({ label: 'frame' });
  for (let i = 0; i < sim.substeps; i++) {
    runChain(world, encoder, SimPass);
  }
  runChain(world, encoder, DrawPass);
  world.feedback.request(encoder, world.get(world.res.feedback, Buf), FEEDBACK_BYTES);
  device.queue.submit([encoder.finish()]);
  world.feedback.poll();
}

createRoot(document.getElementById('ui')!).render(
  <StrictMode>
    <WorldProvider world={world} flush="frame">
      <Overlay />
    </WorldProvider>
  </StrictMode>,
);

void boot().catch((err: unknown) => {
  const box = document.createElement('div');
  box.className = 'fatal';
  box.textContent = String(err);
  document.body.append(box);
  console.error(err);
});
