import { PARTICLE, SCREEN } from './shaders';

export const COLUMNS = 5; // x, y, vx, vy, life
const UNIFORM_STRIDE = 256;
/** Staging buffers in flight; each one takes a frame or two to come back mapped. */
const STAGING_RING = 4;

export interface DrawRange {
  first: number;
  count: number;
  palette: 0 | 1;
}

export interface Look {
  /** Point radius in device pixels per palette. */
  radius: [number, number];
  /** Brightness multiplier per palette. */
  gain: [number, number];
  exposure: number;
  /** Fraction of the trail buffer surviving each frame at 60 Hz. */
  trail: number;
}

export interface SelectionMark {
  on: boolean;
  x: number;
  y: number;
}

export class Renderer {
  public readonly look: Look = {
    radius: [1.6, 2.6],
    gain: [0.014, 0.08],
    exposure: 1.0,
    trail: 0.82,
  };
  public width = 1;
  public height = 1;
  public readonly dpr = Math.min(
    window.devicePixelRatio || 1,
    Number(new URLSearchParams(location.search).get('dpr')) || 2,
  );

  private readonly columns: GPUBuffer[] = [];
  private capacity = 0;
  /**
   * Mapped staging ring. Filling a mapped range is a memcpy in the page's
   * process; `writeBuffer` pays an IPC copy per byte, which at 16 MB a frame
   * costs more than the simulation itself.
   */
  private readonly staging: GPUBuffer[] = [];
  private active: GPUBuffer | null = null;
  private views: Float32Array[] = [];
  private uploaded = 0;

  private hdr!: GPUTexture;
  private pickTexture!: GPUTexture;
  private readonly pickBuffer: GPUBuffer;
  private pending: { x: number; y: number; resolve: (slot: number) => void } | null = null;
  private reading = false;

  private readonly particleUniforms: GPUBuffer;
  private readonly screenUniforms: GPUBuffer;
  private readonly particleBind: GPUBindGroup;
  private screenBind!: GPUBindGroup;

  private readonly particlePipeline: GPURenderPipeline;
  private readonly pickPipeline: GPURenderPipeline;
  private readonly fadePipeline: GPURenderPipeline;
  private readonly compositePipeline: GPURenderPipeline;

  private readonly scratch = new Float32Array(8);

  private constructor(
    private readonly device: GPUDevice,
    private readonly context: GPUCanvasContext,
    private readonly canvas: HTMLCanvasElement,
    private readonly format: GPUTextureFormat,
  ) {
    const particle = device.createShaderModule({ code: PARTICLE });
    const screen = device.createShaderModule({ code: SCREEN });

    const vertexBuffers: GPUVertexBufferLayout[] = [];
    for (let i = 0; i < COLUMNS; i++) {
      vertexBuffers.push({
        arrayStride: 4,
        stepMode: 'instance',
        attributes: [{ shaderLocation: i, offset: 0, format: 'float32' }],
      });
    }

    const particleLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', hasDynamicOffset: true },
        },
      ],
    });
    this.particleUniforms = device.createBuffer({
      size: UNIFORM_STRIDE * 2, // one slot per draw range
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.particleBind = device.createBindGroup({
      layout: particleLayout,
      entries: [{ binding: 0, resource: { buffer: this.particleUniforms, size: UNIFORM_STRIDE } }],
    });

    const vertex: GPUVertexState = { module: particle, entryPoint: 'vs', buffers: vertexBuffers };
    const particlePipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [particleLayout],
    });
    this.particlePipeline = device.createRenderPipeline({
      layout: particlePipelineLayout,
      vertex,
      fragment: {
        module: particle,
        entryPoint: 'fs',
        targets: [
          {
            format: 'rgba16float',
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.pickPipeline = device.createRenderPipeline({
      layout: particlePipelineLayout,
      vertex,
      fragment: { module: particle, entryPoint: 'fs_pick', targets: [{ format: 'r32uint' }] },
      primitive: { topology: 'triangle-list' },
    });

    const screenLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
    this.screenUniforms = device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const screenPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [screenLayout] });
    // The fade pass renders into the trail texture, so it must not bind it.
    this.fadePipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [] }),
      vertex: { module: screen, entryPoint: 'vs' },
      fragment: {
        module: screen,
        entryPoint: 'fs_fade',
        targets: [
          {
            format: 'rgba16float',
            blend: {
              color: { srcFactor: 'zero', dstFactor: 'constant', operation: 'add' },
              alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.compositePipeline = device.createRenderPipeline({
      layout: screenPipelineLayout,
      vertex: { module: screen, entryPoint: 'vs' },
      fragment: { module: screen, entryPoint: 'fs_composite', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    this.screenLayout = screenLayout;

    this.pickBuffer = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    this.resize();
  }

  private readonly screenLayout: GPUBindGroupLayout;

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

  /** Match the canvas to its CSS box; rebuild the offscreen targets. */
  public resize(): boolean {
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * this.dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * this.dpr));
    if (w === this.width && h === this.height && this.hdr !== undefined) {
      return false;
    }
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.hdr?.destroy();
    this.pickTexture?.destroy();
    this.hdr = this.device.createTexture({
      size: [w, h],
      format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.pickTexture = this.device.createTexture({
      size: [w, h],
      format: 'r32uint',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this.screenBind = this.device.createBindGroup({
      layout: this.screenLayout,
      entries: [
        { binding: 0, resource: { buffer: this.screenUniforms } },
        { binding: 1, resource: this.hdr.createView() },
      ],
    });
    return true;
  }

  /** Make room for `slots` instances; existing contents are not preserved. */
  public reserve(slots: number): void {
    if (slots <= this.capacity) {
      return;
    }
    let capacity = Math.max(1 << 16, this.capacity);
    while (capacity < slots) {
      capacity *= 2;
    }
    for (const buffer of this.columns) {
      buffer.destroy();
    }
    for (const buffer of this.staging) {
      buffer.destroy();
    }
    this.columns.length = 0;
    this.staging.length = 0;
    this.active = null;
    for (let i = 0; i < COLUMNS; i++) {
      this.columns.push(
        this.device.createBuffer({
          size: capacity * 4,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        }),
      );
    }
    for (let i = 0; i < STAGING_RING; i++) {
      this.staging.push(
        this.device.createBuffer({
          size: capacity * 4 * COLUMNS,
          usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC,
          mappedAtCreation: true,
        }),
      );
    }
    this.capacity = capacity;
  }

  /** Claim a mapped staging buffer for this frame's columns, if one is ready. */
  public beginUpload(): void {
    this.active = null;
    for (const buffer of this.staging) {
      if (buffer.mapState === 'mapped') {
        this.active = buffer;
        break;
      }
    }
    if (this.active === null) {
      return;
    }
    const stride = this.capacity * 4;
    this.views.length = 0;
    for (let i = 0; i < COLUMNS; i++) {
      this.views.push(new Float32Array(this.active.getMappedRange(i * stride, stride)));
    }
    this.uploaded = 0;
  }

  /** One ECS column page into the matching vertex buffer: a memcpy, no repacking. */
  public writeColumn(column: number, slot: number, page: Float32Array, length: number): void {
    const end = slot + length;
    if (this.active !== null) {
      this.views[column].set(length === page.length ? page : page.subarray(0, length), slot);
      if (end > this.uploaded) {
        this.uploaded = end;
      }
      return;
    }
    // No staging buffer back from the GPU yet: pay the slow path this frame.
    this.device.queue.writeBuffer(this.columns[column], slot * 4, page, 0, length);
  }

  /** Ask which instance sits under a CSS pixel. Resolves to -1 when nothing does. */
  public pick(cssX: number, cssY: number): Promise<number> {
    return new Promise((resolve) => {
      this.pending?.resolve(-1);
      this.pending = { x: Math.floor(cssX * this.dpr), y: Math.floor(cssY * this.dpr), resolve };
    });
  }

  public frame(
    ranges: readonly DrawRange[],
    selection: SelectionMark,
    time: number,
    dt: number,
  ): void {
    const { device, look } = this;
    const halfW = this.width / 2;
    const halfH = this.height / 2;
    const aspect = this.width / this.height;

    const u = this.scratch;
    for (let r = 0; r < ranges.length; r++) {
      const range = ranges[r];
      u[0] = aspect;
      u[1] = halfW;
      u[2] = halfH;
      u[3] = time;
      u[4] = look.radius[range.palette] * this.dpr;
      u[5] = range.palette;
      u[6] = look.gain[range.palette];
      u[7] = range.first;
      device.queue.writeBuffer(this.particleUniforms, r * UNIFORM_STRIDE, u);
    }
    u[0] = look.exposure;
    u[1] = 0;
    u[2] = time;
    u[3] = selection.on ? 1 : 0;
    u[4] = (selection.x / aspect + 1) * halfW;
    u[5] = (1 - selection.y) * halfH;
    u[6] = halfW;
    u[7] = halfH;
    device.queue.writeBuffer(this.screenUniforms, 0, u);

    const encoder = device.createCommandEncoder();

    // Pass 0: the staged columns become the vertex buffers.
    const staged = this.active;
    if (staged !== null) {
      staged.unmap();
      const stride = this.capacity * 4;
      for (let i = 0; i < COLUMNS; i++) {
        encoder.copyBufferToBuffer(staged, i * stride, this.columns[i], 0, this.uploaded * 4);
      }
      this.active = null;
      this.views.length = 0;
    }

    // Pass 1: decay the trail buffer, then add this frame's particles on top.
    const trail = encoder.beginRenderPass({
      colorAttachments: [{ view: this.hdr.createView(), loadOp: 'load', storeOp: 'store' }],
    });
    const fade = Math.pow(look.trail, dt * 60);
    trail.setPipeline(this.fadePipeline);
    trail.setBlendConstant({ r: fade, g: fade, b: fade, a: 1 });
    trail.draw(3);
    trail.setPipeline(this.particlePipeline);
    this.bindColumns(trail);
    for (let r = 0; r < ranges.length; r++) {
      const range = ranges[r];
      if (range.count === 0) {
        continue;
      }
      trail.setBindGroup(0, this.particleBind, [r * UNIFORM_STRIDE]);
      this.drawRange(trail, range);
    }
    trail.end();

    // Pass 2: tonemap to the canvas.
    const composite = encoder.beginRenderPass({
      colorAttachments: [
        { view: this.context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' },
      ],
    });
    composite.setPipeline(this.compositePipeline);
    composite.setBindGroup(0, this.screenBind);
    composite.draw(3);
    composite.end();

    // Pass 3, on demand: instance ids into an integer target, read one texel back.
    const pending = this.pending;
    if (pending !== null && !this.reading) {
      this.pending = null;
      const ids = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: this.pickTexture.createView(),
            loadOp: 'clear',
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            storeOp: 'store',
          },
        ],
      });
      ids.setPipeline(this.pickPipeline);
      this.bindColumns(ids);
      for (let r = 0; r < ranges.length; r++) {
        const range = ranges[r];
        if (range.count === 0) {
          continue;
        }
        ids.setBindGroup(0, this.particleBind, [r * UNIFORM_STRIDE]);
        this.drawRange(ids, range);
      }
      ids.end();
      const x = Math.min(Math.max(pending.x, 0), this.width - 1);
      const y = Math.min(Math.max(pending.y, 0), this.height - 1);
      encoder.copyTextureToBuffer(
        { texture: this.pickTexture, origin: [x, y] },
        { buffer: this.pickBuffer },
        [1, 1],
      );
      this.reading = true;
      device.queue.submit([encoder.finish()]);
      this.rearm(staged);
      this.pickBuffer
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          const id = new Uint32Array(this.pickBuffer.getMappedRange())[0];
          this.pickBuffer.unmap();
          this.reading = false;
          pending.resolve(id === 0 ? -1 : id - 1);
        })
        .catch(() => {
          this.reading = false;
          pending.resolve(-1);
        });
      return;
    }

    device.queue.submit([encoder.finish()]);
    this.rearm(staged);
  }

  private rearm(staged: GPUBuffer | null): void {
    if (staged !== null) {
      staged.mapAsync(GPUMapMode.WRITE).catch(() => {});
    }
  }

  private bindColumns(pass: GPURenderPassEncoder): void {
    for (let i = 0; i < COLUMNS; i++) {
      pass.setVertexBuffer(i, this.columns[i]);
    }
  }

  /** One archetype group, one instanced draw: three vertices per particle. */
  private drawRange(pass: GPURenderPassEncoder, range: DrawRange): void {
    pass.draw(3, range.count, 0, range.first);
  }
}
