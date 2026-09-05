/**
 * Non-blocking GPU -> CPU. Two staging buffers so a frame never waits on the
 * one the driver is still mapping; the CPU therefore reads state that is one
 * or two frames old, which is invisible for buoyancy and for a bobbing crate.
 */
export class Readback {
  public readonly data: Float32Array;
  readonly #ints: Int32Array;
  readonly #slots: { buffer: GPUBuffer; busy: boolean }[];
  readonly #pending: { buffer: GPUBuffer; busy: boolean }[] = [];
  #arrived = false;

  public constructor(buffers: GPUBuffer[], bytes: number) {
    this.data = new Float32Array(bytes / 4);
    this.#ints = new Int32Array(this.data.buffer);
    this.#slots = buffers.map((buffer) => ({ buffer, busy: false }));
  }

  /** True once at least one transfer has landed. */
  public get ready(): boolean {
    return this.#arrived;
  }

  public request(encoder: GPUCommandEncoder, src: GPUBuffer, bytes: number): void {
    const slot = this.#slots.find((s) => !s.busy);
    if (slot === undefined) {
      return;
    }
    slot.busy = true;
    encoder.copyBufferToBuffer(src, 0, slot.buffer, 0, bytes);
    this.#pending.push(slot);
  }

  /** Call after `queue.submit`; the map cannot be requested before then. */
  public poll(): void {
    for (let i = 0; i < this.#pending.length; i++) {
      const slot = this.#pending[i];
      void slot.buffer.mapAsync(GPUMapMode.READ).then(
        () => {
          this.data.set(new Float32Array(slot.buffer.getMappedRange()));
          slot.buffer.unmap();
          slot.busy = false;
          this.#arrived = true;
        },
        () => {
          slot.busy = false;
        },
      );
    }
    this.#pending.length = 0;
  }

  /** The same bytes read as i32, for the fixed-point feedback accumulator. */
  public int(i: number): number {
    return this.#ints[i];
  }
}
