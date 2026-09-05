/**
 * The systems. Every one of them is a plain function over a query — there is no
 * scheduler here, and there is no renderer class either: the frame is a walk
 * over the pass entities in `RunsAfter` order.
 */
import { Cascade, Changed, Not, Optional, With, type World } from 'apecs';

import { GRID, type Resources } from './build';
import { invert, lookAt, mat4, multiply, perspective } from './math';
import type { Readback } from './readback';
import {
  Bind,
  Binder,
  Body,
  Buf,
  Camera,
  Clears,
  Computes,
  Dispatch,
  DrawPass,
  Draws,
  Geometry,
  Held,
  Look,
  Named,
  PerParticle,
  Pointer,
  RunsAfter,
  Sim,
  SimPass,
  Spin,
  Stale,
  Time,
  Transform,
  Velocity,
  View,
  Viewport,
  Writes,
  DepthOf,
} from './traits';

export const BALL_RADIUS = 5;
export const BALL_MASS = 660;
const FOV = 0.74;
const NEAR = 1;
const FAR = 600;
/** The grid's fixed-point scale for the ball feedback accumulator. */
const FP_FEEDBACK = 1e4;

/* --------------------------------------------------------------- uniforms */

const simScratch = new Float32Array(24);
const simInts = new Uint32Array(simScratch.buffer);

export function writeSim(world: World, device: GPUDevice, res: Resources): void {
  const s = world.get(Sim);
  const ball = world.queryFirst(Body);
  simInts[0] = GRID.x;
  simInts[1] = GRID.y;
  simInts[2] = GRID.z;
  simInts[3] = s.count;
  simScratch[4] = s.dt;
  simScratch[5] = s.gravity;
  simScratch[6] = s.stiffness;
  simScratch[7] = s.restDensity;
  simScratch[8] = s.viscosity;
  simScratch[9] = s.push;
  simScratch[10] = world.get(Time.current);
  if (ball !== undefined) {
    simScratch[12] = world.get(ball, Transform.x);
    simScratch[13] = world.get(ball, Transform.y);
    simScratch[14] = world.get(ball, Transform.z);
    simScratch[15] = world.get(ball, Transform.r);
    simScratch[16] = world.get(ball, Velocity.x);
    simScratch[17] = world.get(ball, Velocity.y);
    simScratch[18] = world.get(ball, Velocity.z);
    simScratch[20] = world.get(ball, Spin.x);
    simScratch[21] = world.get(ball, Spin.y);
    simScratch[22] = world.get(ball, Spin.z);
  }
  device.queue.writeBuffer(world.get(res.sim, Buf), 0, simScratch);
}

const viewScratch = new Float32Array(116);
const proj = mat4();
const viewMat = mat4();
const viewProj = mat4();
const invViewProj = mat4();
const invView = mat4();
const eye = new Float32Array(3);
const target = new Float32Array(3);

export function writeView(world: World, device: GPUDevice, res: Resources): void {
  const cam = world.get(Camera);
  const vp = world.get(Viewport);
  const look = world.get(Look);
  const ball = world.queryFirst(Body);
  const aspect = vp.w / Math.max(vp.h, 1);

  const cp = Math.cos(cam.pitch);
  target[0] = cam.tx;
  target[1] = cam.ty;
  target[2] = cam.tz;
  eye[0] = cam.tx + cam.dist * cp * Math.sin(cam.yaw);
  eye[1] = cam.ty + cam.dist * Math.sin(cam.pitch);
  eye[2] = cam.tz + cam.dist * cp * Math.cos(cam.yaw);

  perspective(proj, FOV, aspect, NEAR, FAR);
  lookAt(viewMat, eye, target);
  multiply(viewProj, proj, viewMat);
  invert(invViewProj, viewProj);
  invert(invView, viewMat);

  viewScratch.set(viewProj, 0);
  viewScratch.set(invViewProj, 16);
  viewScratch.set(viewMat, 32);
  viewScratch.set(invView, 48);
  viewScratch.set(proj, 64);
  viewScratch.set(eye, 80);
  viewScratch[84] = vp.w;
  viewScratch[85] = vp.h;
  viewScratch[86] = 1 / vp.w;
  viewScratch[87] = 1 / vp.h;
  const tanY = Math.tan(FOV / 2);
  viewScratch[88] = tanY * aspect;
  viewScratch[89] = tanY;
  viewScratch[90] = NEAR;
  viewScratch[91] = FAR;
  viewScratch[92] = look.radius;
  viewScratch[93] = look.refract;
  viewScratch[94] = look.absorb;
  viewScratch[95] = look.fresnel;
  if (ball !== undefined) {
    viewScratch[96] = world.get(ball, Transform.x);
    viewScratch[97] = world.get(ball, Transform.y);
    viewScratch[98] = world.get(ball, Transform.z);
    viewScratch[99] = world.get(ball, Transform.r);
  }
  viewScratch[100] = GRID.x;
  viewScratch[101] = GRID.y;
  viewScratch[102] = GRID.z;
  viewScratch[103] = look.blur;
  viewScratch[104] = 0.42;
  viewScratch[105] = 0.78;
  viewScratch[106] = 0.46;
  viewScratch[107] = world.get(Time.current);
  // In-scatter colour: what deep water adds back as it absorbs. Ocean, so the
  // green survives the shallows and only the blue reaches the bottom.
  viewScratch[108] = 0.005;
  viewScratch[109] = 0.072;
  viewScratch[110] = 0.225;
  viewScratch[111] = look.tint;
  // Turns the thickness pass's overlapping chords back into a path length.
  const r = look.radius;
  viewScratch[112] = 3 / (4 * Math.PI * r * r * r * world.get(Sim.restDensity));
  device.queue.writeBuffer(world.get(res.view, Buf), 0, viewScratch);
}

/** The camera ray through a pixel, from the matrices `writeView` just built. */
export function pickRay(world: World, px: number, py: number, out: Float32Array): Float32Array {
  const vp = world.get(Viewport);
  const nx = (px / vp.w) * 2 - 1;
  const ny = 1 - (py / vp.h) * 2;
  const m = invViewProj;
  const w = m[3] * nx + m[7] * ny + m[11] + m[15];
  out[0] = (m[0] * nx + m[4] * ny + m[8] + m[12]) / w - eye[0];
  out[1] = (m[1] * nx + m[5] * ny + m[9] + m[13]) / w - eye[1];
  out[2] = (m[2] * nx + m[6] * ny + m[10] + m[14]) / w - eye[2];
  const len = Math.hypot(out[0], out[1], out[2]) || 1;
  out[0] /= len;
  out[1] /= len;
  out[2] /= len;
  out[3] = eye[0];
  out[4] = eye[1];
  out[5] = eye[2];
  return out;
}

/* ---------------------------------------------------------- pass execution */

const clearValue = { r: 0, g: 0, b: 0, a: 1 };
const colorAttachment: GPURenderPassColorAttachment = {
  view: undefined as unknown as GPUTextureView,
  loadOp: 'load',
  storeOp: 'store',
  clearValue,
};
const depthAttachment: GPURenderPassDepthStencilAttachment = {
  view: undefined as unknown as GPUTextureView,
  depthLoadOp: 'load',
  depthStoreOp: 'store',
  depthClearValue: 1,
};
const renderDesc: GPURenderPassDescriptor = {
  label: '',
  colorAttachments: [colorAttachment],
};
const computeDesc: GPUComputePassDescriptor = { label: '' };

/**
 * Walks one chain. `Cascade(RunsAfter)` is the whole ordering mechanism: the
 * ECS maintains hierarchy depth incrementally, so inserting a pass is one
 * `world.add(pass, RunsAfter(other))` and never an edit to this function.
 */
export function runChain(world: World, encoder: GPUCommandEncoder, chain: typeof SimPass): void {
  world
    .query(
      Optional(Computes),
      Optional(Draws),
      Optional(Dispatch),
      Optional(Geometry),
      Bind,
      Clears,
      Named,
      Cascade(RunsAfter),
      With(chain),
    )
    .each((compute, draw, dispatch, geometry, bind, clears, named, e) => {
      if (compute !== null) {
        computeDesc.label = named.name;
        const pass = encoder.beginComputePass(computeDesc);
        pass.setPipeline(compute);
        pass.setBindGroup(0, bind);
        pass.dispatchWorkgroups(dispatch?.x ?? 1, dispatch?.y ?? 1, dispatch?.z ?? 1);
        pass.end();
        return;
      }
      if (draw === null || geometry === null || geometry.instances === 0) {
        return;
      }
      const colorTarget = world.target(e, Writes);
      const depthTarget = world.target(e, DepthOf);
      colorAttachment.view = world.get(colorTarget, View);
      colorAttachment.loadOp = clears.color ? 'clear' : 'load';
      clearValue.r = clears.r;
      clearValue.g = clears.g;
      clearValue.b = clears.b;
      clearValue.a = clears.a;
      renderDesc.label = named.name;
      if (!depthTarget) {
        renderDesc.depthStencilAttachment = undefined;
      } else {
        depthAttachment.view = world.get(depthTarget, View);
        depthAttachment.depthLoadOp = clears.depth ? 'clear' : 'load';
        renderDesc.depthStencilAttachment = depthAttachment;
      }
      const pass = encoder.beginRenderPass(renderDesc);
      pass.setPipeline(draw);
      pass.setBindGroup(0, bind);
      pass.draw(geometry.vertices, geometry.instances);
      pass.end();
    });
}

/** Bind groups whose textures were replaced by a resize, rebuilt from `Binder`. */
export function rebind(world: World): void {
  world.query(Binder, With(Stale)).each((build, e) => {
    world.set(e, Bind, build());
    world.remove(e, Stale);
  });
}

/**
 * Only when the UI actually moved something: `Changed(Sim)` is false on the
 * overwhelming majority of frames, and reseeding 130k particles is not.
 */
export function syncSimShape(
  world: World,
  device: GPUDevice,
  res: Resources,
  seed: (count: number) => Float32Array,
): boolean {
  let reseeded = false;
  world.query(Sim, Changed(Sim)).each((sim) => {
    // Which passes scale with the particle count is a tag, not a name test.
    const groups = Math.ceil(sim.count / 64);
    world.query(Dispatch, With(PerParticle)).each((d) => {
      d.x = groups;
    });
    world.query(Geometry, With(PerParticle)).each((g) => {
      g.instances = sim.count;
    });
    if (sim.count !== lastCount) {
      lastCount = sim.count;
      device.queue.writeBuffer(world.get(res.particles, Buf), 0, seed(sim.count));
      reseeded = true;
    }
  });
  return reseeded;
}
let lastCount = -1;

/* ------------------------------------------------------------------ bodies */

/**
 * The ball, from what the grid measured around it last frame.
 *
 * Vertical force is Archimedes against the water line the shader reported: the
 * boundary impulse cannot supply it (see `struct Feedback` in the sim shader),
 * and a spherical cap is exact for a sphere anyway. Horizontal force is the
 * boundary impulse, which has no such bias, plus drag toward the flow the ball
 * is sitting in. The ball still pushes the water — that half of the coupling
 * is the grid boundary itself, and it is unchanged.
 */
export function stepBall(world: World, feedback: Readback, dt: number): void {
  const ready = feedback.ready;
  const at = (i: number) => (ready ? feedback.int(i) / FP_FEEDBACK : 0);
  const ix = at(0);
  const iz = at(2);
  const tx = at(3);
  const ty = at(4);
  const tz = at(5);
  const flowMass = at(9);
  const inv = flowMass > 1e-3 ? 1 / flowMass : 0;
  const flowX = at(6) * inv;
  const flowY = at(7) * inv;
  const flowZ = at(8) * inv;
  const level = ready ? feedback.int(10) / 256 : 0;

  const sim = world.get(Sim);
  const gravity = sim.gravity * dt;

  world.query(Transform, Velocity, Spin, Body, Not(Held)).each((t, v, w, body) => {
    const r = t.r;
    const submerged = Math.min(Math.max(level - (t.y - r), 0), 2 * r);
    const cap = (Math.PI * submerged * submerged * (3 * r - submerged)) / 3;
    const whole = (4 / 3) * Math.PI * r * r * r;
    const soak = cap / whole;

    // Added mass divides the whole acceleration, gravity included. Applied to
    // the fluid terms alone it leaves the weight undivided and the ball sinks
    // however buoyant it is; a sphere lighter than the fluid it displaces is a
    // nearly undamped oscillator without it and the drag below.
    const share = 1 / (1 + soak * 2.0);
    const lift = cap * sim.restDensity * sim.gravity * dt * body.invMass * body.buoyancy;

    v.y += (lift - gravity) * share;
    v.x += ix * body.invMass * share * 0.5;
    v.z += iz * body.invMass * share * 0.5;

    // Carried by the water it is in, at a rate set by how much of it is in.
    const grip = Math.min(0.25, 0.7 * soak * dt);
    v.x += (flowX - v.x) * grip;
    v.y += (flowY - v.y) * grip * 0.5;
    v.z += (flowZ - v.z) * grip;

    w.x += tx * body.invInertia;
    w.y += ty * body.invInertia;
    w.z += tz * body.invInertia;

    const damp = 1 - body.drag - soak * 0.05;
    v.x *= damp;
    v.y *= damp;
    v.z *= damp;
    w.x *= 0.94;
    w.y *= 0.94;
    w.z *= 0.94;

    t.x += v.x * dt;
    t.y += v.y * dt;
    t.z += v.z * dt;

    if (t.x < r) {
      t.x = r;
      v.x = Math.abs(v.x) * 0.4;
    }
    if (t.x > GRID.x - r) {
      t.x = GRID.x - r;
      v.x = -Math.abs(v.x) * 0.4;
    }
    if (t.z < r) {
      t.z = r;
      v.z = Math.abs(v.z) * 0.4;
    }
    if (t.z > GRID.z - r) {
      t.z = GRID.z - r;
      v.z = -Math.abs(v.z) * 0.4;
    }
    if (t.y < r) {
      t.y = r;
      v.y = Math.abs(v.y) * 0.3;
    }
    if (t.y > GRID.y - r) {
      t.y = GRID.y - r;
      v.y = -Math.abs(v.y) * 0.3;
    }
  });
}

/* ------------------------------------------------------------------ camera */

export function orbit(world: World, dx: number, dy: number): void {
  const cam = world.accessor(Camera.yaw);
  const pitch = world.accessor(Camera.pitch);
  const e = world.entity;
  cam.set(e, cam.get(e) - dx * 0.005);
  pitch.set(e, Math.min(1.35, Math.max(-0.2, pitch.get(e) - dy * 0.005)));
}

export function dolly(world: World, delta: number): void {
  const dist = world.accessor(Camera.dist);
  const e = world.entity;
  dist.set(e, Math.min(320, Math.max(45, dist.get(e) * (1 + delta * 0.0012))));
}
