/**
 * Every piece of state in this demo is a trait, and every piece of the frame is
 * an entity: GPU resources, the passes that consume them, the scene, the
 * simulation parameters, the pointer. Nothing here is bookkeeping around an
 * engine — this *is* the engine.
 */
import { Relation, Trait, bool, f32, u32 } from 'apecs';

/* ------------------------------------------------------------------ resources */

/**
 * WebGPU objects are references, so they are AoS traits: one boxed column, the
 * reference itself arriving from `each` and `get`. Their entities are what own
 * them — `main.ts` subscribes `'remove'` to `destroy()`, which is the whole of
 * this demo's resource management.
 */
export const Buf = new Trait(() => null as unknown as GPUBuffer);
export const Tex = new Trait(() => null as unknown as GPUTexture);
export const View = new Trait(() => null as unknown as GPUTextureView);
export const Bind = new Trait(() => null as unknown as GPUBindGroup);
export const Computes = new Trait(() => null as unknown as GPUComputePipeline);
export const Draws = new Trait(() => null as unknown as GPURenderPipeline);

/** Rebuilds a pass's bind group from whatever its `Reads`/`Writes` targets hold now. */
export type BindFn = () => GPUBindGroup;
export const Binder = new Trait(() => (() => null) as unknown as BindFn);

/** Debug name, and the only string column in the world. */
export const Named = new Trait({ name: '' });

/** Sized to the drawing buffer: despawned and rebuilt on resize. */
export const Transient = new Trait();

/** This pass's bind group no longer refers to live resources. */
export const Stale = new Trait();

/* ---------------------------------------------------------------- frame graph */

/**
 * `RunsAfter` is exclusive and acyclic, which is exactly `Cascade`'s contract
 * (SPEC §7.6): ordering the passes is a depth sort the ECS already maintains,
 * not a hand-written call list that drifts from the dependencies.
 */
export const RunsAfter = new Relation(undefined, { exclusive: true });

/** Pass → the resources it samples or binds read-only. Drives bind-group rebuilds. */
export const Reads = new Relation();
/** Pass → its colour attachment. */
export const Writes = new Relation(undefined, { exclusive: true });
/** Pass → its depth attachment. */
export const DepthOf = new Relation(undefined, { exclusive: true });

/** Which of the two chains a pass belongs to. The sim chain runs once per substep. */
export const SimPass = new Trait();
export const DrawPass = new Trait();

/** This pass's extent is the particle count, not the grid or the viewport. */
export const PerParticle = new Trait();

export const Dispatch = new Trait({ x: u32(1), y: u32(1), z: u32(1) });
export const Geometry = new Trait({ vertices: u32(6), instances: u32(1) });

/** Attachment load ops. `depthClear` is ignored when the pass has no `DepthOf`. */
export const Clears = new Trait({
  color: bool(false),
  r: f32(0),
  g: f32(0),
  b: f32(0),
  a: f32(0),
  depth: bool(false),
});

/* --------------------------------------------------------------------- scene */

export const ChildOf = new Relation(undefined, { exclusive: true, onTargetDespawn: 'despawn' });

export const Transform = new Trait({ x: f32(0), y: f32(0), z: f32(0), r: f32(1) });
export const Velocity = new Trait({ x: f32(0), y: f32(0), z: f32(0) });
export const Spin = new Trait({ x: f32(0), y: f32(0), z: f32(0) });

/** Rigid bodies the fluid pushes back on. Only the ball has one. */
export const Body = new Trait({
  invMass: f32(1),
  invInertia: f32(1),
  drag: f32(0.02),
  buoyancy: f32(1),
});

/** The pointer owns this body: it is kinematic until released. */
export const Held = new Trait();

/* ------------------------------------------------------------- world  traits */

export const Time = new Trait({ delta: f32(0), current: f32(0), frame: u32(0) });

/**
 * Tracked, because the upload system re-writes the sim uniform buffer only on
 * `Changed(Sim)` — the UI writes it, and most frames it does not.
 */
export const Sim = new Trait(
  {
    dt: f32(0.1),
    substeps: u32(3),
    gravity: f32(2.4),
    stiffness: f32(250),
    restDensity: f32(4),
    viscosity: f32(0.12),
    count: u32(0),
    /** How hard the ball's boundary shoves the fluid. */
    push: f32(1),
  },
  { track: true },
);

export const Look = new Trait(
  {
    radius: f32(1.05),
    refract: f32(1),
    absorb: f32(0.175),
    fresnel: f32(0.48),
    blur: f32(1),
    tint: f32(1),
  },
  { track: true },
);

export const Camera = new Trait({
  yaw: f32(0.62),
  pitch: f32(0.24),
  dist: f32(126),
  tx: f32(48),
  ty: f32(7),
  tz: f32(20),
});

export const Viewport = new Trait({ w: u32(1), h: u32(1), dpr: f32(1) });

export const Pointer = new Trait({
  x: f32(0),
  y: f32(0),
  dx: f32(0),
  dy: f32(0),
  down: bool(false),
  orbiting: bool(false),
});
