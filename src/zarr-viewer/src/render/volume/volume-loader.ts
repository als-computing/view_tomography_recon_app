/**
 * VolumeLoader — progressive coarse→fine level manager for the WebGPU volume renderer.
 *
 * Loads the coarsest multiscale level first (fast first paint), then streams progressively finer
 * levels toward a target, emitting each texture as it becomes ready. Resolution is **monotonic**: for
 * a given dataset the displayed level only ever gets finer, so zooming out never snaps the view back
 * to a blurry level.
 *
 * Because loading is monotonic (a finer full level fully supersedes the coarser one), only the
 * currently-displayed texture is kept resident — the previous level is disposed on swap. Uploads are
 * also capped by a byte budget so an over-large level can't exhaust GPU memory; if a level fails to
 * allocate, streaming stops gracefully at the last good level instead of crashing.
 *
 * Level indices follow the OME-Zarr convention: 0 = finest (largest), levelCount-1 = coarsest.
 *
 * @packageDocumentation
 */

import type { VolumeSource } from "@zarr-viewer/io";
import type { ManagedTexture } from "../resources/texture.js";
import { uploadVolume, chooseVolumeFormat } from "./volume-texture.js";

/** A level that finished uploading: its GPU texture + intensity histogram. */
export interface VolumeLevelResult {
  level: number;
  texture: ManagedTexture;
  histogram: Float32Array;
}

/** Options for {@link VolumeLoader}. */
export interface VolumeLoaderOptions {
  /** Whether the device can linearly filter r32float (drives the precision choice). */
  supportsFloat32Filtering: boolean;
  /**
   * Max bytes for a single level's GPU texture. Levels whose smallest-format size exceeds this are
   * skipped, and the per-level format is downgraded (r32→r16→r8) to fit. Defaults to 2 GiB — a
   * backstop against pathological levels, not the primary cap (the viewer caps the finest streamed
   * level at 2, which is the real memory guard). Bumped high so we push the GPU rather than
   * needlessly downgrading precision on capable machines.
   */
  maxUploadBytes?: number;
}

const DEFAULT_MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

export class VolumeLoader {
  private source: VolumeSource | undefined;
  /** Uploadable+affordable level indices for the current source, ascending (0 finest … coarsest). */
  private uploadable: number[] = [];
  /** The single resident (displayed) level; the previous one is disposed on swap. */
  private current: VolumeLevelResult | undefined;
  /** Finest level emitted so far (lower = finer); Infinity before anything is shown. */
  private displayedLevel = Infinity;
  /** Level the user/camera wants (everything coarser is streamed on the way there). */
  private targetLevel = 0;
  /** Invalidation token: bumped on open()/dispose() so in-flight streams for an old dataset stop. */
  private token = 0;
  private streaming = false;
  private onLevelCb: ((r: VolumeLevelResult) => void) | undefined;
  private readonly maxUploadBytes: number;

  public constructor(
    private readonly device: GPUDevice,
    private readonly options: VolumeLoaderOptions,
  ) {
    this.maxUploadBytes = options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  }

  /** Subscribe to "a (finer) level is ready" — fires once per level as streaming progresses. */
  public onLevel(cb: (r: VolumeLevelResult) => void): void {
    this.onLevelCb = cb;
  }

  /** The level currently on screen (finest emitted), or undefined before first paint. */
  public get currentLevel(): number | undefined {
    return this.displayedLevel === Infinity ? undefined : this.displayedLevel;
  }

  /**
   * Begin (or restart for a new dataset) progressive loading. Emits the coarsest affordable level
   * first, then streams finer levels down to `targetLevel`.
   */
  public open(source: VolumeSource, uploadableLevels: number[], targetLevel: number): void {
    this.token++;
    this.disposeCurrent();
    this.source = source;
    // Keep only levels whose texture fits the byte budget even at the smallest (1 byte/voxel) format;
    // the coarsest level is tiny, so at least one always survives.
    this.uploadable = [...uploadableLevels]
      .filter((lv) => this.levelVoxels(source, lv) <= this.maxUploadBytes)
      .sort((a, b) => a - b);
    if (this.uploadable.length === 0) {
      // Everything is over budget — fall back to the single coarsest level so something renders.
      const coarsest = [...uploadableLevels].sort((a, b) => a - b).pop();
      if (coarsest !== undefined) this.uploadable = [coarsest];
    }
    this.displayedLevel = Infinity;
    this.targetLevel = this.clampTarget(targetLevel);
    void this.stream(this.token);
  }

  /** Aim for a (usually finer) level; ignored if it wouldn't improve on what's shown (no downgrade). */
  public setTargetLevel(level: number): void {
    if (!this.source) return;
    this.targetLevel = this.clampTarget(level);
    void this.stream(this.token);
  }

  /** Free the resident texture and cancel any in-flight streaming. */
  public dispose(): void {
    this.token++;
    this.disposeCurrent();
    this.source = undefined;
    this.onLevelCb = undefined;
  }

  private levelVoxels(source: VolumeSource, level: number): number {
    const [dx, dy, dz] = source.dimensionsAt(level);
    return dx * dy * dz;
  }

  private clampTarget(level: number): number {
    if (this.uploadable.length === 0) return level;
    const finest = this.uploadable[0]!;
    const coarsest = this.uploadable[this.uploadable.length - 1]!;
    return Math.min(coarsest, Math.max(finest, level));
  }

  /** Coarsest uploadable level not yet shown that is still finer than displayed and ≥ target. */
  private nextLevel(): number | undefined {
    let best: number | undefined;
    for (const lv of this.uploadable) {
      if (lv >= this.targetLevel && lv < this.displayedLevel) {
        if (best === undefined || lv > best) best = lv;
      }
    }
    return best;
  }

  private async stream(myToken: number): Promise<void> {
    if (this.streaming) return; // an active loop re-reads targetLevel each step and will cover it
    this.streaming = true;
    try {
      while (myToken === this.token) {
        const next = this.nextLevel();
        if (next === undefined) break;
        let result: VolumeLevelResult;
        try {
          result = await this.upload(next);
        } catch (err) {
          // Out of memory / allocation failure — keep the last good level and stop climbing rather
          // than crashing the renderer.
          console.warn(`VolumeLoader: level ${next} failed to upload; staying at last good level:`, err);
          break;
        }
        if (myToken !== this.token) {
          result.texture.dispose(); // dataset changed mid-upload → discard
          return;
        }
        this.displayedLevel = next;
        this.onLevelCb?.(result);
        // Monotonic loading never revisits the coarser level → free it now that a finer one is shown.
        if (this.current && this.current !== result) this.current.texture.dispose();
        this.current = result;
      }
    } finally {
      this.streaming = false;
    }
  }

  private async upload(level: number): Promise<VolumeLevelResult> {
    const src = this.source!;
    const voxels = this.levelVoxels(src, level);
    const format = chooseVolumeFormat(voxels, {
      supportsFloat32Filtering: this.options.supportsFloat32Filtering,
      budgetBytes: this.maxUploadBytes,
    });
    const { texture, histogram } = await uploadVolume(this.device, src, { level, format });
    return { level, texture, histogram };
  }

  private disposeCurrent(): void {
    this.current?.texture.dispose();
    this.current = undefined;
  }
}
