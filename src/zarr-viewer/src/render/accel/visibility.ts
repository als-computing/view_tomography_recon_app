/**
 * Ray-guided remote-data streaming: a coarse UVW bin grid that accumulates transmittance-weighted
 * hit counts during the existing ray march (no occupancy grid required).
 *
 * WGSL has no float atomics, so the GPU stores fixed-point `u32` (`weight * {@link VIS_WEIGHT_SCALE}`)
 * via saturating `atomicAdd`. JS divides the scale back out on readback.
 *
 * Priority is `visibilityWeight × max(0, residentLevel − requiredLevel)` in this codebase's LOD
 * convention (0 = finest): a heavily-traversed bin that's already resident at an adequate level is
 * deprioritized; a moderately-traversed bin covered only by a coarse level is the one to fetch.
 *
 * @packageDocumentation
 */

import type { Disposable } from "@zarr-viewer/core";

/**
 * Fixed-point scale for vis-bin weights. Sized so a full-HD frame of concurrent contributions to
 * one bin cannot overflow u32 even with many samples per ray (and we saturate defensively anyway).
 * The plan's example of 2^16 overflows; 128 does not at 1080p.
 */
export const VIS_WEIGHT_SCALE = 128;

/** Default UVW bin grid along each axis when no occupancy grid is sharing the layout. */
export const VIS_GRID_DEFAULT = 32;

/** Readback cadence in frames (buffered; never per-frame-synchronous). */
export const VIS_READBACK_CADENCE = 16;

/** A decoded visibility bin: UVW cell + weight + derived fetch priority. */
export interface VisibilityBin {
  x: number;
  y: number;
  z: number;
  /** Transmittance-weighted hit count (scale divided back out). */
  weight: number;
  /** `weight × LOD deficit`; 0 means nothing to fetch. */
  priority: number;
  /** Finest level the ray footprint wants (0 = finest). */
  requiredLevel: number;
}

/**
 * Quantize a float weight in `[0, 1]` (or a small multiple) to the u32 the shader atomicAdds.
 * Saturates rather than wrapping.
 */
export function quantizeVisWeight(weight: number, scale = VIS_WEIGHT_SCALE): number {
  if (!(weight > 0)) return 0;
  return Math.min(0xffffffff, Math.round(weight * scale));
}

/** Inverse of {@link quantizeVisWeight}. */
export function dequantizeVisWeight(q: number, scale = VIS_WEIGHT_SCALE): number {
  return q / scale;
}

/** Linear index of a UVW coordinate in a `nx×ny×nz` grid. */
export function visBinIndex(
  uvw: readonly [number, number, number],
  grid: readonly [number, number, number],
): number {
  const x = Math.min(grid[0] - 1, Math.max(0, Math.floor(uvw[0] * grid[0])));
  const y = Math.min(grid[1] - 1, Math.max(0, Math.floor(uvw[1] * grid[1])));
  const z = Math.min(grid[2] - 1, Math.max(0, Math.floor(uvw[2] * grid[2])));
  return x + y * grid[0] + z * grid[0] * grid[1];
}

/** UVW AABB of bin `(x,y,z)`. */
export function visBinUvwBox(
  x: number,
  y: number,
  z: number,
  grid: readonly [number, number, number],
): { min: [number, number, number]; max: [number, number, number] } {
  return {
    min: [x / grid[0], y / grid[1], z / grid[2]],
    max: [(x + 1) / grid[0], (y + 1) / grid[1], (z + 1) / grid[2]],
  };
}

/**
 * Distance-based required LOD until Milestone 3.2's mip-selection machinery exists.
 * 0 = finest. Closer to the eye → finer level.
 *
 * @param eyeToBin Distance from the camera to the bin center, in the same units as `boxExtent`.
 * @param boxExtent Longest AABB half-extent (or full diagonal — consistent with the caller).
 * @param levelCount Number of multiscale levels (0 .. levelCount-1).
 */
export function requiredLevelFromDistance(
  eyeToBin: number,
  boxExtent: number,
  levelCount: number,
): number {
  if (levelCount <= 1) return 0;
  const t = Math.min(1, Math.max(0, eyeToBin / Math.max(boxExtent * 3, 1e-6)));
  return Math.round(t * (levelCount - 1));
}

/**
 * Visualization-driven-virtual-memory priority. `residentLevel` / `requiredLevel` use this viewer's
 * convention (0 = finest, larger = coarser), so the deficit is `resident − required`, not the
 * literature's `required − resident`.
 */
export function visPriority(
  visibilityWeight: number,
  requiredLevel: number,
  residentLevel: number,
): number {
  const deficit = Math.max(0, residentLevel - requiredLevel);
  return visibilityWeight * deficit;
}

/**
 * Rank bins by fetch priority. `residentLevelOf` returns the coarsest resident level covering that
 * bin (whole-volume display level, or a finer brick if one covers it).
 */
export function rankVisibilityBins(
  quantized: Uint32Array,
  grid: readonly [number, number, number],
  opts: {
    levelCount: number;
    boxExtent: number;
    eye: readonly [number, number, number];
    /** World-space half-extents of the volume AABB (box centered at origin). */
    boxHalf: readonly [number, number, number];
    residentLevelOf: (x: number, y: number, z: number) => number;
  },
): VisibilityBin[] {
  const [nx, ny, nz] = grid;
  const out: VisibilityBin[] = [];
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const q = quantized[x + y * nx + z * nx * ny] ?? 0;
        if (q === 0) continue;
        const weight = dequantizeVisWeight(q);
        const box = visBinUvwBox(x, y, z, grid);
        const cx = (box.min[0] + box.max[0]) * 0.5;
        const cy = (box.min[1] + box.max[1]) * 0.5;
        const cz = (box.min[2] + box.max[2]) * 0.5;
        const wx = cx * 2 * opts.boxHalf[0] - opts.boxHalf[0];
        const wy = cy * 2 * opts.boxHalf[1] - opts.boxHalf[1];
        const wz = cz * 2 * opts.boxHalf[2] - opts.boxHalf[2];
        const dist = Math.hypot(wx - opts.eye[0], wy - opts.eye[1], wz - opts.eye[2]);
        const requiredLevel = requiredLevelFromDistance(dist, opts.boxExtent, opts.levelCount);
        const residentLevel = opts.residentLevelOf(x, y, z);
        const priority = visPriority(weight, requiredLevel, residentLevel);
        if (priority <= 0) continue;
        out.push({ x, y, z, weight, priority, requiredLevel });
      }
    }
  }
  out.sort((a, b) => b.priority - a.priority);
  return out;
}

/**
 * Triple-buffered GPU vis-bin accumulation. The fragment shader atomicAdds into the current write
 * buffer; every {@link VIS_READBACK_CADENCE} frames we copy to a MAP_READ buffer and switch slots so
 * the copy never stalls the next frame.
 */
export class VisibilityFeedback implements Disposable {
  readonly grid: [number, number, number];
  readonly binCount: number;
  readonly byteSize: number;
  private readonly gpu: GPUBuffer;
  private readonly read: GPUBuffer[] = [];
  private readSlot = 0;
  private frames = 0;
  private readonly pending = new Set<number>();
  private pendingMapSlot: number | undefined;
  /** Latest decoded weights (scale divided out). Zeroed until the first successful readback. */
  public lastWeights: Float32Array;
  public lastQuantized: Uint32Array;
  public enabled = false;

  public constructor(
    private readonly device: GPUDevice,
    grid: readonly [number, number, number] = [VIS_GRID_DEFAULT, VIS_GRID_DEFAULT, VIS_GRID_DEFAULT],
  ) {
    this.grid = [grid[0], grid[1], grid[2]];
    this.binCount = this.grid[0] * this.grid[1] * this.grid[2];
    this.byteSize = this.binCount * 4;
    this.lastWeights = new Float32Array(this.binCount);
    this.lastQuantized = new Uint32Array(this.binCount);
    this.gpu = device.createBuffer({
      size: this.byteSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      label: "vis-bins-gpu",
    });
    for (let i = 0; i < 3; i++) {
      this.read.push(
        device.createBuffer({
          size: this.byteSize,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
          label: `vis-bins-read-${i}`,
        }),
      );
    }
  }

  /** Storage buffer the fragment shader writes. Stable across frames (readback is triple-buffered). */
  public get writeBuffer(): GPUBuffer {
    return this.gpu;
  }

  /**
   * Every {@link VIS_READBACK_CADENCE} frames, copy the write buffer for async map and clear it
   * so weights don't grow unbounded. Never waits on the map.
   */
  public recordCopy(encoder: GPUCommandEncoder): void {
    if (!this.enabled) return;
    this.frames++;
    if (this.frames % VIS_READBACK_CADENCE !== 0) return;
    const slot = this.readSlot;
    if (this.pending.has(slot)) return;
    encoder.copyBufferToBuffer(this.gpu, 0, this.read[slot]!, 0, this.byteSize);
    encoder.clearBuffer(this.gpu);
    this.pending.add(slot);
    this.pendingMapSlot = slot;
    this.readSlot = (this.readSlot + 1) % this.read.length;
  }

  /** Map the pending readback. Must run after `queue.submit`, never during encoding. */
  public afterSubmit(): void {
    const slot = this.pendingMapSlot;
    if (slot === undefined) return;
    this.pendingMapSlot = undefined;
    const buf = this.read[slot]!;
    void buf
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        const src = new Uint32Array(buf.getMappedRange().slice(0));
        buf.unmap();
        this.lastQuantized.set(src);
        for (let i = 0; i < src.length; i++) {
          this.lastWeights[i] = dequantizeVisWeight(src[i]!);
        }
        this.pending.delete(slot);
      })
      .catch(() => {
        this.pending.delete(slot);
      });
  }

  public dispose(): void {
    this.gpu.destroy();
    for (const b of this.read) b.destroy();
  }
}
