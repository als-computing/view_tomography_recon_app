/**
 * BrickLoader — streams a single high-res ROI sub-volume ("brick") of a fine multiscale level into a
 * GPU texture that fits GPU limits, for compositing over the resident coarse volume when zoomed in.
 *
 * Unlike {@link VolumeLoader} (whole levels, coarse→fine, one resident texture), this loads only the
 * voxel sub-box the user is looking at, at the finest level whose sub-box fits the texture budget — so
 * L0/L1 become reachable below the whole-level MIN_DISPLAY_LEVEL floor. One brick is resident at a
 * time; a superseded request aborts its in-flight fetches and disposes the old texture on swap, and
 * {@link BrickLoader.clear} discards the brick (zoom-out) so the renderer falls back to coarse.
 *
 * @packageDocumentation
 */

import type { VolumeSource } from "@zarr-viewer/io";
import type { ManagedTexture } from "../resources/texture.js";
import { uploadVolume, chooseVolumeFormat } from "./volume-texture.js";

/** A loaded ROI brick: its GPU texture, source level, and the world sub-box it covers. */
export interface BrickResult {
  texture: ManagedTexture;
  level: number;
  /** World-space (sim-unit) min/max the texture's `[0,1]³` maps onto. */
  worldMin: [number, number, number];
  worldMax: [number, number, number];
}

/** A request to stream a brick: the level + voxel box (into that level) + its world sub-box. */
export interface BrickRequest {
  source: VolumeSource;
  level: number;
  voxelMin: [number, number, number];
  voxelMax: [number, number, number];
  worldMin: [number, number, number];
  worldMax: [number, number, number];
}

/** Options for {@link BrickLoader}. */
export interface BrickLoaderOptions {
  supportsFloat32Filtering: boolean;
  /** Max bytes for the brick texture (default 512 MiB — bricks are small sub-boxes). */
  maxUploadBytes?: number;
}

// Smaller than the whole-level budget: keeps the brick texture cache-friendly and the fine voxel
// coarse enough that the (global) brick step doesn't explode the ray-march step count.
const DEFAULT_MAX_BRICK_BYTES = 192 * 1024 * 1024;

export class BrickLoader {
  private token = 0;
  private inflight: AbortController | undefined;
  private current: BrickResult | undefined;
  private onBrickCb: ((b: BrickResult) => void) | undefined;
  private onClearCb: (() => void) | undefined;
  private onProgressCb: ((loaded: number, total: number) => void) | undefined;
  private readonly maxUploadBytes: number;

  public constructor(
    private readonly device: GPUDevice,
    private readonly options: BrickLoaderOptions,
  ) {
    this.maxUploadBytes = options.maxUploadBytes ?? DEFAULT_MAX_BRICK_BYTES;
  }

  public onBrick(cb: (b: BrickResult) => void): void {
    this.onBrickCb = cb;
  }
  public onClear(cb: () => void): void {
    this.onClearCb = cb;
  }
  /** Fires as a brick streams in: `loaded` of `total` chunks uploaded (only for the current request). */
  public onProgress(cb: (loaded: number, total: number) => void): void {
    this.onProgressCb = cb;
  }
  public get currentBrick(): BrickResult | undefined {
    return this.current;
  }

  /**
   * Stream the requested brick; supersedes any in-flight request (aborting its fetches). Returns a
   * promise that settles when the stream finishes (loaded, superseded, or failed) — callers use it to
   * gate a single in-flight request.
   */
  public request(req: BrickRequest): Promise<void> {
    this.token++;
    const myToken = this.token;
    this.inflight?.abort();
    this.inflight = new AbortController();
    return this.stream(req, myToken, this.inflight.signal);
  }

  /** Discard the brick (zoom-out): abort in-flight, dispose the texture, notify the renderer. */
  public clear(): void {
    this.token++;
    this.inflight?.abort();
    this.inflight = undefined;
    if (this.current) {
      this.current.texture.dispose();
      this.current = undefined;
      this.onClearCb?.();
    }
  }

  public dispose(): void {
    this.token++;
    this.inflight?.abort();
    this.inflight = undefined;
    this.current?.texture.dispose();
    this.current = undefined;
    this.onBrickCb = undefined;
    this.onClearCb = undefined;
    this.onProgressCb = undefined;
  }

  private async stream(req: BrickRequest, myToken: number, signal: AbortSignal): Promise<void> {
    const size: [number, number, number] = [
      Math.max(1, req.voxelMax[0] - req.voxelMin[0]),
      Math.max(1, req.voxelMax[1] - req.voxelMin[1]),
      Math.max(1, req.voxelMax[2] - req.voxelMin[2]),
    ];
    const voxels = size[0] * size[1] * size[2];
    const format = chooseVolumeFormat(voxels, {
      supportsFloat32Filtering: this.options.supportsFloat32Filtering,
      budgetBytes: this.maxUploadBytes,
    });
    let texture: ManagedTexture;
    try {
      ({ texture } = await uploadVolume(this.device, req.source, {
        level: req.level,
        offset: req.voxelMin,
        size,
        format,
        signal,
        onProgress: (loaded, total) => {
          // Ignore progress from a request that's already been superseded.
          if (myToken === this.token) this.onProgressCb?.(loaded, total);
        },
      }));
    } catch (err) {
      if (signal.aborted || (err as { name?: string })?.name === "AbortError") return; // superseded
      console.warn(`BrickLoader: brick L${req.level} failed to upload:`, err);
      return;
    }
    if (myToken !== this.token) {
      texture.dispose(); // superseded while uploading
      return;
    }
    const brick: BrickResult = {
      texture,
      level: req.level,
      worldMin: req.worldMin,
      worldMax: req.worldMax,
    };
    this.onBrickCb?.(brick);
    if (this.current) this.current.texture.dispose();
    this.current = brick;
  }
}

/**
 * Pick the finest multiscale level whose voxel sub-box for `[cropMin, cropMax]` (UVW `[0,1]`) fits the
 * GPU per-axis dimension limit and the byte budget (at ≥ r16). Returns the level + voxel box, or null
 * if even the coarsest level's sub-box doesn't fit. Finer levels have more voxels for the same crop
 * fraction, so we scan finest→coarsest and take the first that fits.
 */
export function chooseBrickRegion(
  source: VolumeSource,
  cropMin: readonly [number, number, number],
  cropMax: readonly [number, number, number],
  opts: { maxTextureDimension: number; maxUploadBytes?: number },
): { level: number; voxelMin: [number, number, number]; voxelMax: [number, number, number] } | null {
  const budget = opts.maxUploadBytes ?? DEFAULT_MAX_BRICK_BYTES;
  for (let level = 0; level < source.levelCount; level++) {
    const dims = source.dimensionsAt(level);
    const voxelMin: [number, number, number] = [0, 0, 0];
    const voxelMax: [number, number, number] = [0, 0, 0];
    let fits = true;
    let voxels = 1;
    for (let a = 0; a < 3; a++) {
      const d = dims[a]!;
      const lo = Math.max(0, Math.min(d - 1, Math.floor(cropMin[a]! * d)));
      const hi = Math.max(lo + 1, Math.min(d, Math.ceil(cropMax[a]! * d)));
      voxelMin[a] = lo;
      voxelMax[a] = hi;
      const size = hi - lo;
      if (size > opts.maxTextureDimension) fits = false;
      voxels *= size;
    }
    // Require at least r16 (2 bytes/voxel) to fit the budget.
    if (fits && voxels * 2 <= budget) return { level, voxelMin, voxelMax };
  }
  return null;
}
