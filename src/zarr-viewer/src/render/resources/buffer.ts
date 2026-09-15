/**
 * Typed GPU buffer helpers: uniform, storage, vertex/index buffers, and per-frame uploads. Works
 * with `@zarr-viewer/math`'s std140/std430 packing.
 *
 * @packageDocumentation
 */

import { PrismError } from "@zarr-viewer/core";
import type { Disposable } from "@zarr-viewer/core";

/**
 * A managed GPU buffer. Allocates on construction (rounding up to a multiple of 4 bytes as WebGPU
 * requires) and uploads via the device queue.
 *
 * @example
 * ```ts
 * const ubo = new ManagedBuffer(device, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, 256);
 * ubo.write(new Float32Array(mvp.elements));
 * ```
 */
export class ManagedBuffer implements Disposable {
  private buffer: GPUBuffer | undefined;

  public constructor(
    public readonly device: GPUDevice,
    public readonly usage: GPUBufferUsageFlags,
    public readonly byteLength: number,
  ) {
    this.buffer = device.createBuffer({
      size: Math.ceil(byteLength / 4) * 4,
      usage,
    });
  }

  /** Create a vertex/storage buffer initialized from `data`. */
  public static fromData(
    device: GPUDevice,
    usage: GPUBufferUsageFlags,
    data: ArrayBufferView,
  ): ManagedBuffer {
    const mb = new ManagedBuffer(device, usage | GPUBufferUsage.COPY_DST, data.byteLength);
    mb.write(data);
    return mb;
  }

  /** The underlying GPU buffer. */
  public get gpu(): GPUBuffer {
    if (!this.buffer) throw new PrismError("gpu_error", "ManagedBuffer has been disposed");
    return this.buffer;
  }

  /** Upload `data` to the buffer at `offset` bytes. */
  public write(data: ArrayBufferView, offset = 0): void {
    // Cast through ArrayBuffer: TypedArray.buffer is ArrayBufferLike under TS 5.x DOM libs.
    this.device.queue.writeBuffer(
      this.gpu,
      offset,
      data.buffer as ArrayBuffer,
      data.byteOffset,
      data.byteLength,
    );
  }

  public dispose(): void {
    this.buffer?.destroy();
    this.buffer = undefined;
  }
}
