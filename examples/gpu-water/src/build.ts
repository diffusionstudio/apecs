/**
 * Builds the world: one entity per GPU resource, one entity per pass, and the
 * `RunsAfter` chains that order them. Nothing below runs a frame — `frame.ts`
 * walks what this file spawned.
 */
import type { Entity, World } from 'apecs';

import { checkShaders, watchDevice } from './report';
import { MPM } from './shaders/mpm';
import { BLUR, COMPOSITE, FLUID, NO_FLUID, SCENE } from './shaders/render';
import {
  Bind,
  Binder,
  Buf,
  Clears,
  Computes,
  DepthOf,
  Dispatch,
  Draws,
  Geometry,
  Named,
  PerParticle,
  Reads,
  RunsAfter,
  SimPass,
  DrawPass,
  Tex,
  Transient,
  View,
  Writes,
} from './traits';

export const GRID = { x: 96, y: 48, z: 40 } as const;
export const CELLS = GRID.x * GRID.y * GRID.z;
export const MAX_PARTICLES = 1 << 18;
export const PARTICLE_BYTES = 80;

/** Particles per cell at rest; also `Sim.restDensity`, since particle mass is 1. */
export const PACKING = 4;

/** Cells of wall the grid boundary reserves — must match `gridUpdate`'s `b`. */
export const WALL = 2;

/** `struct Feedback` in the sim shader: twelve 32-bit accumulators. */
export const FEEDBACK_BYTES = 48;

export interface Gpu {
  device: GPUDevice;
  context: GPUCanvasContext;
  canvas: HTMLCanvasElement;
  format: GPUTextureFormat;
}

export async function initGpu(canvas: HTMLCanvasElement): Promise<Gpu> {
  if (!navigator.gpu) {
    throw new Error('WebGPU is not available in this browser.');
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) {
    throw new Error('No WebGPU adapter.');
  }
  const device = await adapter.requestDevice();
  const context = canvas.getContext('webgpu');
  if (!context) {
    throw new Error('No WebGPU canvas context.');
  }
  watchDevice(device);
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });
  return { device, context, canvas, format };
}

/* ------------------------------------------------------------- resources */

function resource(world: World, name: string): Entity {
  return world.spawn(Named({ name }));
}

export function spawnBuffer(
  world: World,
  device: GPUDevice,
  name: string,
  size: number,
  usage: GPUBufferUsageFlags,
): Entity {
  const e = resource(world, name);
  world.add(e, Buf(device.createBuffer({ label: name, size, usage })));
  return e;
}

/**
 * Replaces the texture behind a resource entity. The old one is destroyed by
 * the `'remove'` observer, and the `'change'` observer marks every pass that
 * `Reads` this entity stale, so bind groups rebuild themselves.
 */
export function fitTexture(
  world: World,
  device: GPUDevice,
  e: Entity,
  desc: GPUTextureDescriptor,
): void {
  const tex = device.createTexture(desc);
  if (world.has(e, Tex)) {
    world.get(e, Tex).destroy();
    world.set(e, View, tex.createView());
    world.set(e, Tex, tex);
  } else {
    world.add(e, View(tex.createView()), Tex(tex));
  }
}

/* ----------------------------------------------------------------- passes */

interface PassSpec {
  name: string;
  perParticle?: boolean;
  chain: 'sim' | 'draw';
  after?: Entity;
  compute?: GPUComputePipeline;
  draw?: GPURenderPipeline;
  reads?: Entity[];
  writes?: Entity;
  depth?: Entity;
  clear?: { color?: [number, number, number, number]; depth?: boolean };
  dispatch?: [number, number, number];
  geometry?: { vertices: number; instances: number };
  bind: BindFactory;
}

type BindFactory = () => GPUBindGroup;

function spawnPass(world: World, spec: PassSpec): Entity {
  const e = world.spawn(
    Named({ name: spec.name }),
    Binder(spec.bind),
    Bind(spec.bind()),
    spec.chain === 'sim' ? SimPass : DrawPass,
  );
  if (spec.compute) {
    world.add(e, Computes(spec.compute));
  }
  if (spec.draw) {
    world.add(e, Draws(spec.draw));
  }
  if (spec.after !== undefined) {
    world.add(e, RunsAfter(spec.after));
  }
  for (const r of spec.reads ?? []) {
    world.add(e, Reads(r));
  }
  if (spec.writes !== undefined) {
    world.add(e, Writes(spec.writes));
  }
  if (spec.depth !== undefined) {
    world.add(e, DepthOf(spec.depth));
  }
  const c = spec.clear?.color;
  world.add(
    e,
    Clears({
      color: c !== undefined,
      r: c?.[0] ?? 0,
      g: c?.[1] ?? 0,
      b: c?.[2] ?? 0,
      a: c?.[3] ?? 1,
      depth: spec.clear?.depth ?? false,
    }),
  );
  if (spec.dispatch) {
    world.add(e, Dispatch({ x: spec.dispatch[0], y: spec.dispatch[1], z: spec.dispatch[2] }));
  }
  if (spec.geometry) {
    world.add(e, Geometry(spec.geometry));
  }
  if (spec.perParticle) {
    world.add(e, PerParticle);
  }
  return e;
}

export interface Resources {
  sim: Entity;
  view: Entity;
  particles: Entity;
  grid: Entity;
  feedback: Entity;
  sceneColor: Entity;
  sceneDepth: Entity;
  fluidDepth: Entity;
  fluidPing: Entity;
  thickness: Entity;
  swapchain: Entity;
  feedbackStage: GPUBuffer[];
}

const ceil = (n: number, d: number) => Math.ceil(n / d);

export function buildWorld(world: World, gpu: Gpu, w: number, h: number): Resources {
  const { device } = gpu;
  const U = GPUBufferUsage;

  const res: Resources = {
    sim: spawnBuffer(world, device, 'sim uniforms', 96, U.UNIFORM | U.COPY_DST),
    view: spawnBuffer(world, device, 'view uniforms', 464, U.UNIFORM | U.COPY_DST),
    particles: spawnBuffer(
      world,
      device,
      'particles',
      MAX_PARTICLES * PARTICLE_BYTES,
      U.STORAGE | U.COPY_DST,
    ),
    grid: spawnBuffer(world, device, 'grid', CELLS * 16, U.STORAGE),
    feedback: spawnBuffer(
      world,
      device,
      'feedback',
      FEEDBACK_BYTES,
      U.STORAGE | U.COPY_SRC | U.COPY_DST,
    ),
    sceneColor: resource(world, 'scene colour'),
    sceneDepth: resource(world, 'scene depth'),
    fluidDepth: resource(world, 'fluid depth'),
    fluidPing: resource(world, 'fluid depth ping'),
    thickness: resource(world, 'thickness'),
    swapchain: resource(world, 'swap chain'),
    feedbackStage: [0, 1].map(() =>
      device.createBuffer({
        label: 'feedback readback',
        size: FEEDBACK_BYTES,
        usage: U.MAP_READ | U.COPY_DST,
      }),
    ),
  };
  for (const e of [res.sceneColor, res.sceneDepth, res.fluidDepth, res.fluidPing, res.thickness]) {
    world.add(e, Transient);
  }
  // Before any pass: a bind group is built the moment its pass is spawned, and
  // three of them name these textures. The swap chain is a resource like any
  // other; only its view is replaced, once per frame.
  resizeTargets(world, gpu, res, w, h);
  world.add(res.swapchain, View(gpu.context.getCurrentTexture().createView()));

  const buf = (e: Entity) => ({ buffer: world.get(e, Buf) });
  const tex = (e: Entity) => world.get(e, View);

  /* ---- simulation ---- */

  const simLayout = device.createBindGroupLayout({
    label: 'mpm',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ],
  });
  const mpm = device.createShaderModule({ label: 'mpm', code: MPM });
  const simPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [simLayout] });
  const computeOf = (entryPoint: string) =>
    device.createComputePipeline({
      label: entryPoint,
      layout: simPipelineLayout,
      compute: { module: mpm, entryPoint },
    });
  const simBind: BindFactory = () =>
    device.createBindGroup({
      label: 'mpm',
      layout: simLayout,
      entries: [res.sim, res.particles, res.grid, res.feedback].map((e, i) => ({
        binding: i,
        resource: buf(e),
      })),
    });

  const cellGroups: [number, number, number] = [ceil(CELLS, 64), 1, 1];
  const particleGroups: [number, number, number] = [ceil(MAX_PARTICLES, 64), 1, 1];
  const simReads = [res.sim, res.particles, res.grid, res.feedback];

  let prev = spawnPass(world, {
    name: 'clear grid',
    chain: 'sim',
    compute: computeOf('clearGrid'),
    dispatch: cellGroups,
    reads: simReads,
    bind: simBind,
  });
  for (const [name, entry, groups] of [
    ['p2g · mass', 'p2g1', particleGroups],
    ['p2g · stress', 'p2g2', particleGroups],
    ['grid · forces', 'gridUpdate', cellGroups],
    ['g2p · advect', 'g2p', particleGroups],
  ] as const) {
    prev = spawnPass(world, {
      name,
      chain: 'sim',
      after: prev,
      compute: computeOf(entry),
      dispatch: groups as [number, number, number],
      perParticle: groups === particleGroups,
      reads: simReads,
      bind: simBind,
    });
  }

  /* ---- drawing ---- */

  const scene = device.createShaderModule({ label: 'scene', code: SCENE });
  const fluid = device.createShaderModule({ label: 'fluid', code: FLUID });
  const blur = device.createShaderModule({ label: 'blur', code: BLUR });
  const composite = device.createShaderModule({ label: 'composite', code: COMPOSITE });
  void checkShaders([mpm, scene, fluid, blur, composite]);

  const DEPTH_FORMAT: GPUTextureFormat = 'depth32float';
  const depthState = (write: boolean): GPUDepthStencilState => ({
    format: DEPTH_FORMAT,
    depthWriteEnabled: write,
    depthCompare: 'less',
  });

  const scenePipeline = device.createRenderPipeline({
    label: 'scene',
    layout: 'auto',
    vertex: { module: scene, entryPoint: 'vs' },
    fragment: { module: scene, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
    // The background writes depth 1.0 against a buffer cleared to 1.0, so this
    // pass — and only this pass — has to accept equality.
    depthStencil: { ...depthState(true), depthCompare: 'less-equal' },
  });
  const scenePass = spawnPass(world, {
    name: 'scene',
    chain: 'draw',
    draw: scenePipeline,
    writes: res.sceneColor,
    depth: res.sceneDepth,
    clear: { color: [0, 0, 0, 1], depth: true },
    geometry: { vertices: 3, instances: 1 },
    reads: [res.view],
    bind: () =>
      device.createBindGroup({
        layout: scenePipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: buf(res.view) }],
      }),
  });

  const thicknessPipeline = device.createRenderPipeline({
    label: 'thickness',
    layout: 'auto',
    vertex: { module: fluid, entryPoint: 'vs' },
    fragment: {
      module: fluid,
      entryPoint: 'thicknessFs',
      targets: [
        {
          format: 'rg16float',
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one' },
            alpha: { srcFactor: 'one', dstFactor: 'one' },
          },
        },
      ],
    },
    depthStencil: depthState(false),
  });
  const fluidBind =
    (pipeline: GPURenderPipeline): BindFactory =>
    () =>
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: buf(res.view) },
          { binding: 1, resource: buf(res.particles) },
        ],
      });

  const thicknessPass = spawnPass(world, {
    name: 'fluid · thickness',
    chain: 'draw',
    after: scenePass,
    draw: thicknessPipeline,
    writes: res.thickness,
    depth: res.sceneDepth,
    clear: { color: [0, 0, 0, 0] },
    geometry: { vertices: 6, instances: 0 },
    perParticle: true,
    reads: [res.view, res.particles],
    bind: fluidBind(thicknessPipeline),
  });

  const depthPipeline = device.createRenderPipeline({
    label: 'fluid depth',
    layout: 'auto',
    vertex: { module: fluid, entryPoint: 'vs' },
    fragment: { module: fluid, entryPoint: 'depthFs', targets: [{ format: 'r32float' }] },
    depthStencil: depthState(true),
  });
  const depthPass = spawnPass(world, {
    name: 'fluid · depth',
    chain: 'draw',
    after: thicknessPass,
    draw: depthPipeline,
    writes: res.fluidDepth,
    depth: res.sceneDepth,
    clear: { color: [NO_FLUID, 0, 0, 1] },
    geometry: { vertices: 6, instances: 0 },
    perParticle: true,
    reads: [res.view, res.particles],
    bind: fluidBind(depthPipeline),
  });

  const blurPipeline = (axisX: number) =>
    device.createRenderPipeline({
      label: `blur ${axisX ? 'x' : 'y'}`,
      layout: 'auto',
      vertex: { module: blur, entryPoint: 'vs' },
      fragment: {
        module: blur,
        entryPoint: 'fs',
        targets: [{ format: 'r32float' }],
        constants: { AXIS_X: axisX },
      },
    });
  const blurX = blurPipeline(1);
  const blurY = blurPipeline(0);
  const blurBind =
    (pipeline: GPURenderPipeline, src: Entity): BindFactory =>
    () =>
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: buf(res.view) },
          { binding: 1, resource: tex(src) },
        ],
      });

  const blurXPass = spawnPass(world, {
    name: 'blur · x',
    chain: 'draw',
    after: depthPass,
    draw: blurX,
    writes: res.fluidPing,
    geometry: { vertices: 3, instances: 1 },
    reads: [res.view, res.fluidDepth],
    bind: blurBind(blurX, res.fluidDepth),
  });
  const blurYPass = spawnPass(world, {
    name: 'blur · y',
    chain: 'draw',
    after: blurXPass,
    draw: blurY,
    writes: res.fluidDepth,
    geometry: { vertices: 3, instances: 1 },
    reads: [res.view, res.fluidPing],
    bind: blurBind(blurY, res.fluidPing),
  });

  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  const compositePipeline = device.createRenderPipeline({
    label: 'composite',
    layout: 'auto',
    vertex: { module: composite, entryPoint: 'vs' },
    fragment: { module: composite, entryPoint: 'fs', targets: [{ format: gpu.format }] },
  });
  spawnPass(world, {
    name: 'composite',
    chain: 'draw',
    after: blurYPass,
    draw: compositePipeline,
    writes: res.swapchain,
    geometry: { vertices: 3, instances: 1 },
    reads: [res.view, res.sceneColor, res.fluidDepth, res.thickness],
    bind: () =>
      device.createBindGroup({
        layout: compositePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: buf(res.view) },
          { binding: 1, resource: tex(res.sceneColor) },
          { binding: 2, resource: tex(res.fluidDepth) },
          { binding: 3, resource: tex(res.thickness) },
          { binding: 4, resource: sampler },
        ],
      }),
  });

  return res;
}

/** Re-fits every viewport-sized texture. Bind groups follow via the observers. */
export function resizeTargets(world: World, gpu: Gpu, res: Resources, w: number, h: number): void {
  const size = { width: w, height: h };
  const R = GPUTextureUsage.RENDER_ATTACHMENT;
  const T = GPUTextureUsage.TEXTURE_BINDING;
  fitTexture(world, gpu.device, res.sceneColor, {
    label: 'scene colour',
    size,
    format: 'rgba16float',
    usage: R | T,
  });
  fitTexture(world, gpu.device, res.sceneDepth, {
    label: 'scene depth',
    size,
    format: 'depth32float',
    usage: R,
  });
  for (const e of [res.fluidDepth, res.fluidPing]) {
    fitTexture(world, gpu.device, e, {
      label: world.get(e, Named.name),
      size,
      format: 'r32float',
      usage: R | T,
    });
  }
  fitTexture(world, gpu.device, res.thickness, {
    label: 'thickness',
    size,
    format: 'rg16float',
    usage: R | T,
  });
}

/* ------------------------------------------------------------------ scene */

const SPACING = Math.cbrt(1 / PACKING);

/**
 * A dam break: the whole pool's worth of water stacked in a column against one
 * end, released on the first frame. It arrives as a front that runs the length
 * of the tank and sloshes back, which is the wave the pool is worth watching
 * for; seeding it level just gives a puddle that was already finished.
 *
 * The column is a jittered lattice, not uniform noise. Poisson clumping in a
 * random fill varies the local density by tens of percent, and a stiff equation
 * of state answers that with an impulse on the first substep that the water
 * never finishes ringing from.
 */
export function seedParticles(count: number): Float32Array {
  const data = new Float32Array(count * (PARTICLE_BYTES / 4));
  const { across, deep } = pourShape(count);
  const jitter = SPACING * 0.2;
  for (let i = 0; i < count; i++) {
    const o = i * 20;
    const layer = (i / (across * deep)) | 0;
    const r = i - layer * across * deep;
    data[o] = WALL + ((r % across) + 0.5) * SPACING + (Math.random() - 0.5) * jitter;
    data[o + 1] = WALL + (layer + 0.5) * SPACING + (Math.random() - 0.5) * jitter;
    data[o + 2] = WALL + (((r / across) | 0) + 0.5) * SPACING + (Math.random() - 0.5) * jitter;
  }
  return data;
}

/**
 * The column's footprint. Height is aimed at a fixed multiple of the level the
 * water will settle to, not at the ceiling: a taller dam makes a faster front,
 * and past about twice the rest depth it stops looking like a wave and starts
 * firing anything floating at the far wall.
 */
const POUR_RATIO = 2.2;

function pourShape(count: number): { across: number; deep: number } {
  const deep = Math.max(1, Math.floor((GRID.z - 2 * WALL) / SPACING));
  const headroom = Math.max(1, Math.floor((GRID.y - WALL - 4) / SPACING));
  const widest = Math.max(1, Math.floor((GRID.x - 2 * WALL) / SPACING));
  const wanted = Math.ceil((count * SPACING) / (deep * POUR_RATIO * (waterLine(count) - WALL)));
  const fits = Math.ceil(count / (deep * headroom));
  const across = Math.min(widest, Math.max(4, wanted, fits));
  return { across, deep };
}

/** Where the water settles once the pour has run out — where the ball floats. */
export function waterLine(count: number): number {
  return WALL + count / ((GRID.x - 2 * WALL) * (GRID.z - 2 * WALL) * PACKING);
}
