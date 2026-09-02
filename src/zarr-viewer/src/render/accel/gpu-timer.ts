/**
 * GPU timestamp-query timer for isolating per-pass cost within a frame, and totaling it up.
 *
 * WebGPU records timestamps via `timestampWrites` on a render/compute pass (encoder.writeTimestamp
 * was removed from the spec). No-ops when the device lacks `timestamp-query`. Results resolve
 * asynchronously so this never introduces a CPU-GPU sync stall on the render thread.
 *
 * Supports multiple passes per frame (up to `maxPasses`, default 8): call {@link beginFrame} once at
 * the start of the frame, {@link timestampWrites} once per pass you want timed (each call claims the
 * next query-pair slot), then {@link resolve} once — after every pass for the frame has been recorded
 * on the encoder, before `queue.submit` — and {@link afterSubmit} once submission has happened. This
 * replaced an earlier single-pass-only version: with only the main volume-raymarch pass timed, the
 * displayed "GPU ms" couldn't show whether the half-res deferred-lighting toggle actually helped or
 * hurt, since its own cost (plus the lighting-composite pass) was invisible to it.
 *
 * @packageDocumentation
 */

import type { Disposable } from "@zarr-viewer/core";

/** One resolved pass's GPU time. */
export interface GpuTimerSample {
  /** Pass label given to {@link GpuTimer.timestampWrites}. */
  label: string;
  /** GPU elapsed time in milliseconds. */
  ms: number;
}

/**
 * A query-set covering up to `maxPasses` pass pairs per frame. Install {@link timestampWrites} on
 * each pass's `beginRenderPass`/`beginComputePass` descriptor, then {@link resolve} once after all of
 * that frame's passes have been recorded (before submit), then {@link afterSubmit}.
 */
export class GpuTimer implements Disposable {
  private readonly supported: boolean;
  private readonly maxPasses: number;
  private readonly querySet: GPUQuerySet | undefined;
  private readonly resolveBuffer: GPUBuffer | undefined;
  private readonly readBuffers: GPUBuffer[] = [];
  private readIndex = 0;
  private inFlight = false;
  private pendingRead: { buffer: GPUBuffer; labels: readonly string[] } | undefined;
  private frameLabels: string[] = [];
  /** Most recently resolved per-pass samples, in the order their passes were recorded. */
  public lastSamples: GpuTimerSample[] = [];

  public constructor(
    private readonly device: GPUDevice,
    maxPasses = 8,
    // Phase 4b hardening: callers that already have a `GpuContext` should pass its
    // `supportsTimestampQuery` (computed once at device creation) instead of re-deriving it here;
    // defaults to the old self-derived check so existing/test call sites with a bare device keep working.
    supported = device.features.has("timestamp-query"),
  ) {
    this.maxPasses = maxPasses;
    this.supported = supported;
    if (!this.supported) return;
    this.querySet = device.createQuerySet({ type: "timestamp", count: maxPasses * 2 });
    this.resolveBuffer = device.createBuffer({
      size: maxPasses * 2 * 8,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    for (let i = 0; i < 3; i++) {
      this.readBuffers.push(
        device.createBuffer({
          size: maxPasses * 2 * 8,
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

  /** Sum of {@link lastSamples} — the primary "total GPU frame time" figure. `undefined` until the
   * first successful readback, or when unsupported. Not a full-frame total: passes that don't call
   * {@link timestampWrites} (currently the post-processing effect chain — bloom/tonemap/FXAA/sharpen/
   * vignette, which live in a separate package with a dynamic pass count) aren't included. */
  public get lastTotalMs(): number | undefined {
    if (this.lastSamples.length === 0) return undefined;
    let sum = 0;
    for (const s of this.lastSamples) sum += s.ms;
    return sum;
  }

  /** Call once per frame, before recording any passes. Resets the per-frame pass count/labels. */
  public beginFrame(): void {
    this.frameLabels = [];
  }

  /**
   * Pass-descriptor `timestampWrites` for the next pass slot this frame, or `undefined` when
   * unsupported or this frame's `maxPasses` budget is already used (silently skips timing that pass
   * rather than throwing — a missed timing sample is far less harmful than a crashed frame).
   */
  public timestampWrites(label: string): GPURenderPassTimestampWrites | undefined {
    if (!this.querySet || this.frameLabels.length >= this.maxPasses) return undefined;
    const slot = this.frameLabels.length;
    this.frameLabels.push(label);
    return {
      querySet: this.querySet,
      beginningOfPassWriteIndex: slot * 2,
      endOfPassWriteIndex: slot * 2 + 1,
    };
  }

  /**
   * Copy this frame's query pairs into a readback buffer. Call once, after every pass that might have
   * called {@link timestampWrites} this frame has been recorded on `encoder` — {@link afterSubmit}
   * once the encoder has been submitted (mapping before submit is a WebGPU error).
   */
  public resolve(encoder: GPUCommandEncoder): void {
    const count = this.frameLabels.length;
    if (!this.querySet || !this.resolveBuffer || count === 0 || this.inFlight || this.pendingRead) return;
    encoder.resolveQuerySet(this.querySet, 0, count * 2, this.resolveBuffer, 0);
    const slot = this.readBuffers[this.readIndex]!;
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, slot, 0, count * 2 * 8);
    this.pendingRead = { buffer: slot, labels: [...this.frameLabels] };
    this.readIndex = (this.readIndex + 1) % this.readBuffers.length;
  }

  /** Map the pending readback. Must run after `queue.submit`, never during encoding. */
  public afterSubmit(): void {
    const pending = this.pendingRead;
    if (!pending) return;
    this.pendingRead = undefined;
    this.inFlight = true;
    const period =
      typeof (this.device.queue as GPUQueue & { getTimestampPeriod?: () => number })
        .getTimestampPeriod === "function"
        ? (this.device.queue as GPUQueue & { getTimestampPeriod: () => number }).getTimestampPeriod()
        : 1;
    void pending.buffer
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        const byteLength = pending.labels.length * 2 * 8;
        const data = new BigUint64Array(pending.buffer.getMappedRange(0, byteLength).slice(0));
        pending.buffer.unmap();
        const samples: GpuTimerSample[] = pending.labels.map((label, i) => {
          const dtNs = Number(data[i * 2 + 1]! - data[i * 2]!) * period;
          return { label, ms: dtNs / 1e6 };
        });
        this.lastSamples = samples;
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
