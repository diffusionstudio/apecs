/**
 * MLS-MPM (Hu et al. 2018) for a weakly compressible fluid, in grid units so
 * `dx` is 1 and every `inv_dx` factor in the paper disappears.
 *
 * Five dispatches per substep. The two P2G halves cannot be one pass: the
 * pressure a particle scatters in the second depends on the density every
 * *other* particle deposited in the first, and a workgroup barrier does not
 * span a dispatch.
 *
 * Grid momentum is fixed-point because WebGPU has no float atomics. FP is 1e6:
 * with mass 1 per particle a busy cell holds ~30 mass and ~180 momentum, which
 * leaves an order of magnitude before i32 wraps.
 */
export const MPM = /* wgsl */ `

const FP: f32 = 1e6;
const FP_FEEDBACK: f32 = 1e4;

struct Sim {
  grid: vec3u,
  count: u32,
  dt: f32,
  gravity: f32,
  stiffness: f32,
  restDensity: f32,
  viscosity: f32,
  push: f32,
  time: f32,
  pad: u32,
  ball: vec4f,      // xyz centre, w radius
  ballVel: vec4f,
  ballSpin: vec4f,
};

struct Particle {
  pos: vec3f,
  pad0: f32,
  vel: vec3f,
  pad1: f32,
  c0: vec3f,
  pad2: f32,
  c1: vec3f,
  pad3: f32,
  c2: vec3f,
  pad4: f32,
};

struct Cell {
  vx: atomic<i32>,
  vy: atomic<i32>,
  vz: atomic<i32>,
  m: atomic<i32>,
};

/**
 * What the ball needs to know about the water around it, summed over every
 * substep of the frame and read back asynchronously.
 *
 * The level is the point of it. A one-sided separating boundary cannot produce
 * buoyancy: gravity kicks every grid node down by g*dt each substep, which
 * counts as approaching on the ball's upper hemisphere and receding on its
 * lower one, so the constraint fires above and stays quiet below and the net
 * vertical impulse points *down* however buoyant the body is. The horizontal
 * components carry no such bias, so those are used as they are and the
 * vertical force is Archimedes against this measured water line instead.
 */
struct Feedback {
  ix: atomic<i32>,
  iy: atomic<i32>,
  iz: atomic<i32>,
  tx: atomic<i32>,
  ty: atomic<i32>,
  tz: atomic<i32>,
  fx: atomic<i32>,
  fy: atomic<i32>,
  fz: atomic<i32>,
  fm: atomic<i32>,
  level: atomic<i32>,
  wet: atomic<u32>,
};

@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(2) var<storage, read_write> grid: array<Cell>;
@group(0) @binding(3) var<storage, read_write> feedback: Feedback;

fn cellIndex(c: vec3i) -> u32 {
  return u32((c.z * i32(sim.grid.y) + c.y) * i32(sim.grid.x) + c.x);
}

/** Quadratic B-spline weights over the three nodes fx straddles. */
fn weights(fx: vec3f) -> array<vec3f, 3> {
  return array<vec3f, 3>(
    0.5 * (1.5 - fx) * (1.5 - fx),
    0.75 - (fx - 1.0) * (fx - 1.0),
    0.5 * (fx - 0.5) * (fx - 0.5),
  );
}

fn scatter(idx: u32, v: vec3f) {
  atomicAdd(&grid[idx].vx, i32(v.x * FP));
  atomicAdd(&grid[idx].vy, i32(v.y * FP));
  atomicAdd(&grid[idx].vz, i32(v.z * FP));
}

fn cellVelocity(idx: u32) -> vec3f {
  return vec3f(
    f32(atomicLoad(&grid[idx].vx)),
    f32(atomicLoad(&grid[idx].vy)),
    f32(atomicLoad(&grid[idx].vz)),
  ) / FP;
}

@compute @workgroup_size(64)
fn clearGrid(@builtin(global_invocation_id) gid: vec3u) {
  let total = sim.grid.x * sim.grid.y * sim.grid.z;
  if (gid.x >= total) { return; }
  atomicStore(&grid[gid.x].vx, 0);
  atomicStore(&grid[gid.x].vy, 0);
  atomicStore(&grid[gid.x].vz, 0);
  atomicStore(&grid[gid.x].m, 0);
}

/** Mass and affine-corrected momentum to the grid. */
@compute @workgroup_size(64)
fn p2g1(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= sim.count) { return; }
  let p = particles[i];
  let base = vec3i(floor(p.pos - 0.5));
  let fx = p.pos - vec3f(base);
  var w = weights(fx);
  let C = mat3x3f(p.c0, p.c1, p.c2);

  for (var gx = 0; gx < 3; gx++) {
    for (var gy = 0; gy < 3; gy++) {
      for (var gz = 0; gz < 3; gz++) {
        let weight = w[gx].x * w[gy].y * w[gz].z;
        let off = vec3f(f32(gx), f32(gy), f32(gz));
        let dpos = off - fx;
        let idx = cellIndex(base + vec3i(i32(gx), i32(gy), i32(gz)));
        scatter(idx, weight * (p.vel + C * dpos));
        atomicAdd(&grid[idx].m, i32(weight * FP));
      }
    }
  }
}

/**
 * Gather the density the first half deposited, turn it into a Tait pressure,
 * and scatter the resulting stress back as momentum (paper eq. 16).
 */
@compute @workgroup_size(64)
fn p2g2(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= sim.count) { return; }
  let p = particles[i];
  let base = vec3i(floor(p.pos - 0.5));
  let fx = p.pos - vec3f(base);
  var w = weights(fx);

  var density = 0.0;
  for (var gx = 0; gx < 3; gx++) {
    for (var gy = 0; gy < 3; gy++) {
      for (var gz = 0; gz < 3; gz++) {
        let weight = w[gx].x * w[gy].y * w[gz].z;
        let idx = cellIndex(base + vec3i(i32(gx), i32(gy), i32(gz)));
        density += weight * f32(atomicLoad(&grid[idx].m)) / FP;
      }
    }
  }

  let volume = 1.0 / max(density, 1e-4);
  // Clamped below zero, but not to zero: a little cohesion keeps the surface
  // from shredding into spray, and none at all makes the sheet break up.
  let ratio = density / sim.restDensity;
  let pressure = max(-0.2, sim.stiffness * (ratio * ratio * ratio * ratio * ratio - 1.0));

  let C = mat3x3f(p.c0, p.c1, p.c2);
  var stress = mat3x3f(
    vec3f(-pressure, 0.0, 0.0),
    vec3f(0.0, -pressure, 0.0),
    vec3f(0.0, 0.0, -pressure),
  );
  stress += sim.viscosity * (C + transpose(C));
  let term = (-volume * 4.0 * sim.dt) * stress;

  for (var gx = 0; gx < 3; gx++) {
    for (var gy = 0; gy < 3; gy++) {
      for (var gz = 0; gz < 3; gz++) {
        let weight = w[gx].x * w[gy].y * w[gz].z;
        let off = vec3f(f32(gx), f32(gy), f32(gz));
        let dpos = off - fx;
        let idx = cellIndex(base + vec3i(i32(gx), i32(gy), i32(gz)));
        scatter(idx, weight * (term * dpos));
      }
    }
  }
}

/**
 * Momentum to velocity, then gravity, the ball, and the walls. The ball is a
 * slip boundary: only the approaching normal component is cancelled, and the
 * momentum that cancellation destroys is exactly the impulse the fluid owes
 * back to the body, so buoyancy and drag are not modelled separately — they
 * are what this loop already computed.
 */
@compute @workgroup_size(64)
fn gridUpdate(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  let total = sim.grid.x * sim.grid.y * sim.grid.z;
  if (idx >= total) { return; }

  let m = f32(atomicLoad(&grid[idx].m)) / FP;
  if (m <= 1e-5) {
    atomicStore(&grid[idx].vx, 0);
    atomicStore(&grid[idx].vy, 0);
    atomicStore(&grid[idx].vz, 0);
    return;
  }

  var v = cellVelocity(idx) / m;
  v.y -= sim.gravity * sim.dt;

  let g = vec3i(sim.grid);
  let c = vec3i(
    i32(idx % sim.grid.x),
    i32((idx / sim.grid.x) % sim.grid.y),
    i32(idx / (sim.grid.x * sim.grid.y)),
  );

  let d = (vec3f(c) + 0.5) - sim.ball.xyz;
  let r = length(d);

  // The water line the ball floats against, and the flow it is carried by:
  // the highest solid cell in the ball's own footprint, and the mass-weighted
  // velocity of the shell around it.
  if (m > 1.0 && length(d.xz) < sim.ball.w + 2.0) {
    atomicMax(&feedback.level, i32((f32(c.y) + 0.5) * 256.0));
  }
  if (r < sim.ball.w + 2.5) {
    atomicAdd(&feedback.fx, i32(m * v.x * FP_FEEDBACK));
    atomicAdd(&feedback.fy, i32(m * v.y * FP_FEEDBACK));
    atomicAdd(&feedback.fz, i32(m * v.z * FP_FEEDBACK));
    atomicAdd(&feedback.fm, i32(m * FP_FEEDBACK));
  }

  if (r < sim.ball.w) {
    let n = d / max(r, 1e-4);
    let rigid = sim.ballVel.xyz + cross(sim.ballSpin.xyz, d);
    let approach = dot(v - rigid, n);
    if (approach < 0.0) {
      let dv = (-approach * sim.push) * n;
      let impulse = -m * dv;
      let torque = cross(d, impulse);
      atomicAdd(&feedback.ix, i32(impulse.x * FP_FEEDBACK));
      atomicAdd(&feedback.iy, i32(impulse.y * FP_FEEDBACK));
      atomicAdd(&feedback.iz, i32(impulse.z * FP_FEEDBACK));
      atomicAdd(&feedback.tx, i32(torque.x * FP_FEEDBACK));
      atomicAdd(&feedback.ty, i32(torque.y * FP_FEEDBACK));
      atomicAdd(&feedback.tz, i32(torque.z * FP_FEEDBACK));
      atomicAdd(&feedback.wet, 1u);
      v += dv;
    }
  }

  let b = 2;
  if (c.x < b && v.x < 0.0) { v.x = 0.0; }
  if (c.x >= g.x - b && v.x > 0.0) { v.x = 0.0; }
  if (c.y < b && v.y < 0.0) { v.y = 0.0; }
  if (c.y >= g.y - b && v.y > 0.0) { v.y = 0.0; }
  if (c.z < b && v.z < 0.0) { v.z = 0.0; }
  if (c.z >= g.z - b && v.z > 0.0) { v.z = 0.0; }

  // Hard CFL cap: nothing may cross more than 0.6 of a cell in one substep,
  // which is the difference between a splash and a NaN.
  let cap = 0.6 / max(sim.dt, 1e-4);
  let speed = length(v);
  if (speed > cap) { v *= cap / speed; }

  atomicStore(&grid[idx].vx, i32(v.x * FP));
  atomicStore(&grid[idx].vy, i32(v.y * FP));
  atomicStore(&grid[idx].vz, i32(v.z * FP));
}

@compute @workgroup_size(64)
fn g2p(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= sim.count) { return; }
  let p = particles[i];
  let base = vec3i(floor(p.pos - 0.5));
  let fx = p.pos - vec3f(base);
  var w = weights(fx);

  var vel = vec3f(0.0);
  var B = mat3x3f();
  for (var gx = 0; gx < 3; gx++) {
    for (var gy = 0; gy < 3; gy++) {
      for (var gz = 0; gz < 3; gz++) {
        let weight = w[gx].x * w[gy].y * w[gz].z;
        let off = vec3f(f32(gx), f32(gy), f32(gz));
        let dpos = off - fx;
        let gv = cellVelocity(cellIndex(base + vec3i(i32(gx), i32(gy), i32(gz))));
        vel += weight * gv;
        B += weight * mat3x3f(gv * dpos.x, gv * dpos.y, gv * dpos.z);
      }
    }
  }

  var pos = p.pos + vel * sim.dt;

  // The grid boundary keeps the ball watertight in momentum; this keeps it
  // watertight on screen, where one particle inside the sphere is visible.
  let d = pos - sim.ball.xyz;
  let r = length(d);
  if (r < sim.ball.w) {
    let n = d / max(r, 1e-4);
    pos = sim.ball.xyz + n * sim.ball.w;
    vel -= min(0.0, dot(vel - sim.ballVel.xyz, n)) * n;
  }

  let lo = vec3f(1.0);
  let hi = vec3f(sim.grid) - 2.0;
  particles[i].pos = clamp(pos, lo, hi);
  particles[i].vel = vel;
  let C = 4.0 * B;
  particles[i].c0 = C[0];
  particles[i].c1 = C[1];
  particles[i].c2 = C[2];
}
`;
