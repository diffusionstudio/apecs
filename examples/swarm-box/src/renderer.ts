import { COVER_H, COVER_W } from './sim';
import { RODS, ROOM } from './shaders';

export const COLUMNS = 8; // x, y, dx, dy, hue, gx, gy, rho — WebGPU allows no more
const SAMPLES = 4;
/** The eye, and the box: opening at z = 0, back wall at z = -DEPTH. A cube, seen fairly wide. */
export const CAM_Z = 2.7;
export const DEPTH = 2;
/** Depth of the middle of the fluid slab, and how thick that slab is. */
export const FLUID_Z = 1.05;
export const SLAB = 1.15;
/** The opening spans 1 / FRAME of the viewport; the surplus is the marble surround. */
export const FRAME = 1.14;

export interface Look {
  /** Rod half-length and half-width, in rest spacings. */
  length: number;
  width: number;
  saturation: number;
  gain: number;
  exposure: number;
  glow: number;
  /** How far the depth layers shear apart, in rest spacings. */
  wobble: number;
}

export interface Scene {
  time: number;
  /** Rest spacing of the fluid, in device pixels at the middle of the slab. */
  spacingPx: number;
  spacing: number;
  glow: readonly [number, number, number];
  cover: Uint8Array;
}

export class Renderer {
  public readonly look: Look = {
    length: 3.3,
    width: 0.8,
    saturation: 0.95,
    gain: 1.0,
    exposure: 1.0,
    glow: 1.0,
    wobble: 0.5,
  };
  public width = 1;
  public height = 1;
  public readonly dpr = Math.min(
    window.devicePixelRatio || 1,
    Number(new URLSearchParams(location.search).get('dpr')) || 2,
  );

  private readonly columns: GPUBuffer[] = [];
  private capacity = 0;
  private msaa!: GPUTexture;
  private depth!: GPUTexture;

  private readonly cover: GPUTexture;
  private readonly roomUniforms: GPUBuffer;
  private readonly rodUniforms: GPUBuffer;
  private readonly roomBind: GPUBindGroup;
  private readonly rodBind: GPUBindGroup;
  private readonly roomPipeline: GPURenderPipeline;
  private readonly rodPipeline: GPURenderPipeline;
  private readonly scratch = new Float32Array(16);

  private constructor(
    private readonly device: GPUDevice,
    private readonly context: GPUCanvasContext,
    private readonly canvas: HTMLCanvasElement,
    private readonly format: GPUTextureFormat,
  ) {
    const room = device.createShaderModule({ code: ROOM, label: 'room' });
    const rods = device.createShaderModule({ code: RODS, label: 'rods' });
    if (__DEV__) {
      // A WGSL error otherwise surfaces only as "invalid pipeline" at draw time.
      for (const module of [room, rods]) {
        void module.getCompilationInfo().then((info) => {
          for (const m of info.messages) {
            if (m.type !== 'info') {
              console.error(`WGSL ${module.label} ${m.lineNum}:${m.linePos} — ${m.message}`);
            }
          }
        });
      }
    }
    const usage = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;

    this.cover = device.createTexture({
      size: [COVER_W, COVER_H],
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const roomLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
    this.roomUniforms = device.createBuffer({ size: 48, usage });
    this.roomBind = device.createBindGroup({
      layout: roomLayout,
      entries: [
        { binding: 0, resource: { buffer: this.roomUniforms } },
        { binding: 1, resource: this.cover.createView() },
        {
          binding: 2,
          resource: device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
          }),
        },
      ],
    });

    const rodLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });
    this.rodUniforms = device.createBuffer({ size: 64, usage });
    this.rodBind = device.createBindGroup({
      layout: rodLayout,
      entries: [{ binding: 0, resource: { buffer: this.rodUniforms } }],
    });

    const vertexBuffers: GPUVertexBufferLayout[] = [];
    for (let i = 0; i < COLUMNS; i++) {
      vertexBuffers.push({
        arrayStride: 4,
        stepMode: 'instance',
        attributes: [{ shaderLocation: i, offset: 0, format: 'float32' }],
      });
    }
    this.roomPipeline = device.createRenderPipeline({
      label: 'room',
      layout: device.createPipelineLayout({ bindGroupLayouts: [roomLayout] }),
      vertex: { module: room, entryPoint: 'vs' },
      fragment: { module: room, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' },
      multisample: { count: SAMPLES },
    });
    this.rodPipeline = device.createRenderPipeline({
      label: 'rods',
      layout: device.createPipelineLayout({ bindGroupLayouts: [rodLayout] }),
      vertex: { module: rods, entryPoint: 'vs', buffers: vertexBuffers },
      fragment: { module: rods, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
      multisample: { count: SAMPLES },
    });
    this.resize();
  }

  public static async create(canvas: HTMLCanvasElement): Promise<Renderer> {
    if (!('gpu' in navigator)) {
      throw new Error('WebGPU is not available in this browser.');
    }
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (adapter === null) {
      throw new Error('No WebGPU adapter found.');
    }
    const device = await adapter.requestDevice();
    device.addEventListener('uncapturederror', (e) => {
      console.error('WebGPU:', (e as GPUUncapturedErrorEvent).error.message);
    });
    const context = canvas.getContext('webgpu');
    if (context === null) {
      throw new Error('Could not create a WebGPU canvas context.');
    }
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'opaque' });
    return new Renderer(device, context, canvas, format);
  }

  public get aspect(): number {
    return this.width / this.height;
  }

  /** Match the canvas to its CSS box; rebuild the multisampled targets. */
  public resize(): boolean {
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * this.dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * this.dpr));
    if (w === this.width && h === this.height && this.msaa !== undefined) {
      return false;
    }
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.msaa?.destroy();
    this.depth?.destroy();
    this.msaa = this.device.createTexture({
      size: [w, h],
      format: this.format,
      sampleCount: SAMPLES,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.depth = this.device.createTexture({
      size: [w, h],
      format: 'depth24plus',
      sampleCount: SAMPLES,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    return true;
  }

  /** Make room for `slots` instances; existing contents are not preserved. */
  public reserve(slots: number): void {
    if (slots <= this.capacity) {
      return;
    }
    let capacity = Math.max(1 << 14, this.capacity);
    while (capacity < slots) {
      capacity *= 2;
    }
    for (const buffer of this.columns) {
      buffer.destroy();
    }
    this.columns.length = 0;
    for (let i = 0; i < COLUMNS; i++) {
      this.columns.push(
        this.device.createBuffer({
          size: capacity * 4,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        }),
      );
    }
    this.capacity = capacity;
  }

  /** One ECS column page into the matching vertex buffer: a memcpy, no repacking. */
  public writeColumn(column: number, slot: number, page: Float32Array, length: number): void {
    this.device.queue.writeBuffer(this.columns[column], slot * 4, page, 0, length);
  }

  public frame(count: number, scene: Scene): void {
    const { device, look } = this;
    device.queue.writeTexture({ texture: this.cover }, scene.cover, { bytesPerRow: COVER_W }, [
      COVER_W,
      COVER_H,
    ]);

    const u = this.scratch;
    u[0] = this.aspect;
    u[1] = FRAME;
    u[2] = CAM_Z;
    u[3] = DEPTH;
    u[4] = FLUID_Z;
    u[5] = SLAB;
    u[6] = scene.time;
    u[7] = look.exposure;
    u[8] = scene.glow[0];
    u[9] = scene.glow[1];
    u[10] = scene.glow[2];
    u[11] = look.glow;
    device.queue.writeBuffer(this.roomUniforms, 0, u, 0, 12);

    u[8] = look.length * scene.spacingPx;
    u[9] = look.width * scene.spacingPx;
    u[10] = this.width / 2;
    u[11] = this.height / 2;
    u[12] = look.saturation;
    u[13] = look.gain;
    u[14] = 0;
    u[15] = look.wobble * scene.spacing;
    device.queue.writeBuffer(this.rodUniforms, 0, u, 0, 16);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.msaa.createView(),
          resolveTarget: this.context.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'discard',
        },
      ],
      depthStencilAttachment: {
        view: this.depth.createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
      },
    });
    pass.setPipeline(this.roomPipeline);
    pass.setBindGroup(0, this.roomBind);
    pass.draw(3);
    if (count > 0) {
      pass.setPipeline(this.rodPipeline);
      pass.setBindGroup(0, this.rodBind);
      for (let i = 0; i < COLUMNS; i++) {
        pass.setVertexBuffer(i, this.columns[i]);
      }
      pass.draw(6, count);
    }
    pass.end();
    device.queue.submit([encoder.finish()]);
  }
}
