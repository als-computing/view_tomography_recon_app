/**
 * GPU timestamp-query timer for isolating volume-pass cost from CPU submit / post-FX.
 *
 * WebGPU records timestamps via `timestampWrites` on a render/compute pass (encoder.writeTimestamp
 * was removed from the spec). No-ops when the device lacks `timestamp-query`. Results resolve
 * asynchronously so this never introduces a CPU-GPU sync stall on the render thread.
 *
 * @packageDocumentation
 */

import type { Disposable } from "@zarr-viewer/core";

/** Last resolved interval, in milliseconds of GPU time. */
export interface GpuTimerSample {
  /** Pass label given when the writes were installed. */
  label: string;
  /** GPU elapsed time in milliseconds. */
  ms: number;
}

/**
 * A query-set pair covering one pass. Install {@link timestampWrites} on `beginRenderPass` /
 * `beginComputePass`, then {@link resolve} before `queue.submit`.
 */
export class GpuTimer implements Disposable {
  private readonly supported: boolean;
  private readonly querySet: GPUQuerySet | undefined;
  private readonly resolveBuffer: GPUBuffer | undefined;
  private readonly readBuffers: GPUBuffer[] = [];
  private readIndex = 0;
  private inFlight = false;
  private pendingRead: GPUBuffer | undefined;
  private currentLabel = "volume";
  /** Most recently resolved sample, or `undefined` until the first successful readback. */
  public lastSample: GpuTimerSample | undefined;

  public constructor(private readonly device: GPUDevice) {
    this.supported = device.features.has("timestamp-query");
    if (!this.supported) return;
    this.querySet = device.createQuerySet({ type: "timestamp", count: 2 });
    this.resolveBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    for (let i = 0; i < 3; i++) {
      this.readBuffers.push(
        device.createBuffer({
          size: 16,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
          label: `gpu-timer-read-${i}`,
        }),
      );
    }
  }

  /** Whether the device actually records timestamps. */
  public get enabled(): boolean {
    return this.supported;
  }

  /**
   * Pass-descriptor `timestampWrites` covering the whole pass, or `undefined` when unsupported.
   * Only one pass per frame should consume this (a single query pair).
   */
  public timestampWrites(label = "volume"): GPURenderPassTimestampWrites | undefined {
    if (!this.querySet) return undefined;
    this.currentLabel = label;
    return {
      querySet: this.querySet,
      beginningOfPassWriteIndex: 0,
      endOfPassWriteIndex: 1,
    };
  }

  /**
   * Copy the query pair into a readback buffer. Call {@link afterSubmit} once the encoder has been
   * submitted — mapping before submit is a WebGPU error (`used in submit while mapped`).
   */
  public resolve(encoder: GPUCommandEncoder): void {
    if (!this.querySet || !this.resolveBuffer || this.inFlight || this.pendingRead) return;
    encoder.resolveQuerySet(this.querySet, 0, 2, this.resolveBuffer, 0);
    const slot = this.readBuffers[this.readIndex]!;
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, slot, 0, 16);
    this.pendingRead = slot;
    this.readIndex = (this.readIndex + 1) % this.readBuffers.length;
  }

  /** Map the pending readback. Must run after `queue.submit`, never during encoding. */
  public afterSubmit(): void {
    const buf = this.pendingRead;
    if (!buf) return;
    this.pendingRead = undefined;
    this.inFlight = true;
    const label = this.currentLabel;
    const period =
      typeof (this.device.queue as GPUQueue & { getTimestampPeriod?: () => number })
        .getTimestampPeriod === "function"
        ? (this.device.queue as GPUQueue & { getTimestampPeriod: () => number }).getTimestampPeriod()
        : 1;
    void buf
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        const data = new BigUint64Array(buf.getMappedRange().slice(0));
        buf.unmap();
        const dtNs = Number(data[1]! - data[0]!) * period;
        this.lastSample = { label, ms: dtNs / 1e6 };
        this.inFlight = false;
      })
      .catch(() => {
        this.inFlight = false;
      });
  }

  public dispose(): void {
    this.querySet?.destroy();
    this.resolveBuffer?.destroy();
    for (const b of this.readBuffers) b.destroy();
  }
}
