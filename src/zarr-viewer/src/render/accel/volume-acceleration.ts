/**
 * Aggregates `VolumeRenderer`'s acceleration-structure GPU resources — occupancy grid, tile
 * compactor, visibility feedback, opacity shadow map, and the multi-light storage buffer — plus
 * their rebuild bookkeeping (dirty flags, resize policy). `VolumeRenderer` owns shading state
 * (crop, TF, camera, blend mode, …) and drives this aggregate through {@link notifyVolumeChanged}
 * and {@link runPrePasses}; this module owns nothing about *how* the volume is shaded, only the
 * structures that make marching it fast.
 *
 * @packageDocumentation
 */

import type { Disposable } from "@zarr-viewer/core";
import type { Mat4 } from "@zarr-viewer/math";
import { ManagedBuffer } from "../resources/buffer.js";
import { ManagedTexture } from "../resources/texture.js";
import { LightingEnvironment, type GpuLight } from "../lighting/index.js";
import type { ShaderSpecialization } from "./shader-config.js";
import { VisibilityFeedback, VIS_GRID_DEFAULT } from "./visibility.js";
import { OccupancyGrid } from "./occupancy.js";
import { TileCompactor, TILE_SIZE } from "./tiles.js";
import { ShadowMap } from "./shadow-map.js";
import { DensityPyramid } from "./density-pyramid.js";
import { aabbScreenBbox } from "../volume/volume-math.js";

/** Per-frame inputs {@link VolumeAcceleration.runPrePasses} needs but doesn't own. */
export interface VolumeAccelerationFrameCtx {
  viewProj: Mat4;
  spec: ShaderSpecialization;
  volumeTex: ManagedTexture | undefined;
  lastLut: Uint8Array | undefined;
  lastLutSize: number;
  frameUniformGpu: GPUBuffer | undefined;
  internalWidth: number;
  internalHeight: number;
  boxHalf: readonly [number, number, number];
  tfTex: ManagedTexture | undefined;
  tfSampler: GPUSampler | undefined;
  shadowEnable: boolean;
  densityScale: number;
  cropMin: readonly [number, number, number];
  cropMax: readonly [number, number, number];
}

/** GPU buffers `VolumeRenderer`'s bind group needs, resolved against the active shader spec. */
export interface VolumeAccelerationBuffers {
  occBuf: GPUBuffer;
  prefixBuf: GPUBuffer;
  tileBuf: GPUBuffer;
}

export class VolumeAcceleration implements Disposable {
  private occupancy: OccupancyGrid | undefined;
  private readonly dummyOcc: ManagedBuffer;
  private readonly dummyPrefix: ManagedBuffer;
  private readonly vis: VisibilityFeedback;
  private readonly tiles: TileCompactor;
  private readonly dummyTiles: ManagedBuffer;
  private readonly shadowMap: ShadowMap;
  private readonly lightEnv: LightingEnvironment;
  private densityPyramid: DensityPyramid | undefined;
  // Phase 1d hardening: the pyramid's full mip chain is `rg32float` (8 bytes/voxel) - level 0 alone is
  // exactly the base volume's voxel count × 8 bytes (~1.0 GiB at 512³, ~8.0 GiB at 1024³), ~1.14×/9.14×
  // that once the rest of the chain is included. Allocating it unconditionally for every volume load
  // regardless of whether the active shader config even uses it (only "quality" does, via
  // spec.preIntegrate) risked silently blowing the GPU memory budget the viewer's own level-2
  // streaming cap was designed to respect. `pendingVolumeSize` remembers what to allocate *if and when*
  // a preIntegrate-enabled config is actually selected (see `runPrePasses`) — `notifyVolumeChanged`
  // itself no longer allocates.
  private pendingVolumeSize: readonly [number, number, number] | undefined;
  private readonly dummyDensityPyramid: ManagedTexture;
  private disposed = false;

  private dirtyOccMinMax = true;
  private dirtyOccTf = true;
  private dirtyShadow = true;
  private dirtyDensityPyramid = true;
  private shadowMapEnabled = false;
  private shadowMapBuilt = false;
  private shadowLightDir: [number, number, number] = [0.45, 0.85, 0.35];
  private readonly worldToLightBuf = new Float32Array(16);

  public constructor(private readonly device: GPUDevice) {
    // Storage buffer of packed lights (bound at binding 5). Small capacity: this viewer uses at
    // most ~6 procedural lights (1 global + 1 flashlight + 4 stage).
    this.lightEnv = new LightingEnvironment(device, 16);
    this.vis = new VisibilityFeedback(device, [
      VIS_GRID_DEFAULT,
      VIS_GRID_DEFAULT,
      VIS_GRID_DEFAULT,
    ]);
    this.tiles = new TileCompactor(device);
    this.dummyOcc = OccupancyGrid.dummy(device);
    this.dummyPrefix = OccupancyGrid.dummyPrefix(device);
    this.dummyTiles = TileCompactor.dummyTiles(device);
    this.shadowMap = new ShadowMap(device);
    this.dummyDensityPyramid = new ManagedTexture(device, {
      size: [1, 1, 1],
      format: "rg32float",
      dimension: "3d",
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
  }

  /** The visibility-feedback bin accumulator (public: the viewer reads back `lastWeights`). */
  public get visibilityFeedback(): VisibilityFeedback {
    return this.vis;
  }

  public setVisibilityEnabled(enabled: boolean): void {
    this.vis.enabled = enabled;
  }

  public get visGrid(): readonly [number, number, number] {
    return this.vis.grid;
  }

  public get visWriteBuffer(): GPUBuffer {
    return this.vis.writeBuffer;
  }

  public get occupancyGrid(): readonly [number, number, number] {
    return this.occupancy?.grid ?? [1, 1, 1];
  }

  public get lightBuffer(): GPUBuffer {
    return this.lightEnv.gpu;
  }

  public get lightCount(): number {
    return this.lightEnv.lightCount;
  }

  public get keyLightDirection(): readonly [number, number, number] {
    return this.lightEnv.keyLightDirection;
  }

  public get keyLightRadiance(): readonly [number, number, number] {
    return this.lightEnv.keyLightRadiance;
  }

  public setLights(lights: readonly GpuLight[]): void {
    this.lightEnv.setLights(lights);
  }

  /** `worldToLight` mat4 (Milestone 7.1), read into the frame uniform each frame. */
  public get worldToLight(): Float32Array {
    return this.worldToLightBuf;
  }

  /** Whether the shadow map is both enabled and has a built representation to sample. */
  public get shadowActive(): boolean {
    return this.shadowMapEnabled && this.shadowMapBuilt;
  }

  public get shadowMapTexture(): ManagedTexture {
    return this.shadowMap.texture;
  }

  /** The density mip pyramid's `(mean, meanSq)` texture, or a 1x1x1 dummy before the first volume load. */
  public get densityPyramidTexture(): ManagedTexture {
    return this.densityPyramid?.texture ?? this.dummyDensityPyramid;
  }

  /** Estimated GPU bytes held by the real density pyramid, or 0 when none is allocated (lazy — see
   * `pendingVolumeSize`'s doc comment) — unlike {@link densityPyramidTexture}, does NOT count the 1x1x1
   * dummy. Phase 4c hardening: feeds `getMemoryStats()`'s `densityPyramidBytes`. */
  public get densityPyramidBytes(): number {
    return this.densityPyramid?.texture.sizeBytes ?? 0;
  }

  /**
   * Enable/point the opacity shadow map (Milestone 7.1). A meaningful change of direction (or the
   * enable) marks the map dirty so it rebuilds on the next pre-pass; unchanged inputs cost nothing.
   */
  public setShadowMap(enabled: boolean, lightDir: readonly [number, number, number]): void {
    const dot =
      lightDir[0] * this.shadowLightDir[0] +
      lightDir[1] * this.shadowLightDir[1] +
      lightDir[2] * this.shadowLightDir[2];
    if (enabled !== this.shadowMapEnabled || dot < 0.9995) this.dirtyShadow = true;
    this.shadowMapEnabled = enabled;
    this.shadowLightDir = [lightDir[0], lightDir[1], lightDir[2]];
  }

  /** Mark the shadow map dirty (crop / density / TF changed) without touching enable/direction. */
  public markShadowDirty(): void {
    this.dirtyShadow = true;
  }

  /** Mark the TF-dependent occupancy activity dirty (called from `setTransferFunction`). */
  public markOccupancyTfDirty(): void {
    this.dirtyOccTf = true;
  }

  /**
   * Resize (or keep) the occupancy grid for a new volume texture, and mark every acceleration
   * structure dirty. Called from `VolumeRenderer.setVolume`.
   */
  public notifyVolumeChanged(size: readonly [number, number, number]): void {
    const same =
      this.occupancy &&
      this.occupancy.grid[0] === Math.max(1, Math.ceil(size[0] / this.occupancy.cellSize)) &&
      this.occupancy.grid[1] === Math.max(1, Math.ceil(size[1] / this.occupancy.cellSize)) &&
      this.occupancy.grid[2] === Math.max(1, Math.ceil(size[2] / this.occupancy.cellSize));
    if (!same) {
      this.occupancy?.dispose();
      this.occupancy = new OccupancyGrid(this.device, size);
    }
    const pyramidSizeMatches =
      this.densityPyramid &&
      this.densityPyramid.baseDims[0] === size[0] &&
      this.densityPyramid.baseDims[1] === size[1] &&
      this.densityPyramid.baseDims[2] === size[2];
    if (!pyramidSizeMatches) {
      // Dispose a stale-size pyramid immediately (can't leave a mismatched-size texture bound), but
      // don't reallocate here — `runPrePasses` does that lazily, only if a preIntegrate config needs it.
      this.densityPyramid?.dispose();
      this.densityPyramid = undefined;
    }
    this.pendingVolumeSize = size;
    this.dirtyOccMinMax = true;
    this.dirtyOccTf = true;
    this.dirtyShadow = true;
    this.dirtyDensityPyramid = true;
  }

  /** Resolve the bind-group buffers for the active shader spec (dummy fallback when a feature is off). */
  public bindBuffers(spec: ShaderSpecialization): VolumeAccelerationBuffers {
    return {
      occBuf: spec.occupancy && this.occupancy ? this.occupancy.cellsGpu : this.dummyOcc.gpu,
      prefixBuf:
        spec.occupancy && this.occupancy?.prefixGpu ? this.occupancy.prefixGpu : this.dummyPrefix.gpu,
      tileBuf: spec.tiles ? this.tiles.compactedBuffer : this.dummyTiles.gpu,
    };
  }

  public get tileDrawIndirectBuffer(): GPUBuffer {
    return this.tiles.drawIndirectBuffer;
  }

  /**
   * Occupancy rebuild + tile classify + vis-bin copy + on-demand shadow-map rebuild. Call on the
   * same encoder, before the volume render pass. Returns `true` when a rebuild happened that
   * invalidates the caller's bind group (occupancy TF activity or tile buffer resized).
   */
  public runPrePasses(encoder: GPUCommandEncoder, ctx: VolumeAccelerationFrameCtx): boolean {
    let bindGroupDirty = false;
    const { spec } = ctx;
    // Milestone 3.2: the density mip pyramid feeds the Gaussian-extended pre-integration table's
    // sigma lookup, so it's only needed for shader configs that compile PRE_INTEGRATE in — rebuilt
    // once per volume load, not per frame (`dirtyDensityPyramid` only flips true from
    // `notifyVolumeChanged`). Bound at binding 13 and sampled by `sampleVariance()` in the raymarch
    // shader whenever PRE_INTEGRATE is compiled in.
    if (spec.preIntegrate && ctx.volumeTex) {
      // Phase 1d hardening: allocate lazily, right here, only once a preIntegrate config is actually
      // selected — not on every volume load regardless of shader config (see the field's own doc).
      // Allocating/disposing changes which GPU texture is bound at binding 13, so — unlike the
      // occupancy/tile rebuilds below, which reuse their existing buffer — this must mark the bind
      // group dirty too, or the renderer keeps sampling whatever was bound before (the dummy, or a
      // stale pyramid) until something unrelated happens to invalidate it.
      if (!this.densityPyramid && this.pendingVolumeSize) {
        this.densityPyramid = new DensityPyramid(this.device, this.pendingVolumeSize);
        this.dirtyDensityPyramid = true;
        bindGroupDirty = true;
      }
      if (this.densityPyramid && this.dirtyDensityPyramid) {
        this.densityPyramid.rebuildFromVolume(encoder, ctx.volumeTex);
        this.dirtyDensityPyramid = false;
      }
    } else if (this.densityPyramid) {
      // The active config no longer uses preintegration - free the (potentially multi-GiB) pyramid
      // rather than hold it for an inactive feature. A shader-config switch is a deliberate HUD action,
      // not a per-frame event, so freeing eagerly here doesn't thrash the way e.g. camera settle/
      // unsettle would; flipping back to a preIntegrate config just reallocates+rebuilds above.
      this.densityPyramid.dispose();
      this.densityPyramid = undefined;
      bindGroupDirty = true;
    }
    if (spec.occupancy && this.occupancy && ctx.volumeTex) {
      if (this.dirtyOccMinMax) {
        this.occupancy.rebuildMinMax(encoder, ctx.volumeTex);
        this.dirtyOccMinMax = false;
        this.dirtyOccTf = true;
      }
      if (this.dirtyOccTf && ctx.lastLut) {
        this.occupancy.rebuildForTransferFunction(encoder, ctx.lastLut, ctx.lastLutSize);
        this.dirtyOccTf = false;
        bindGroupDirty = true;
      }
    }
    if (spec.tiles && ctx.frameUniformGpu) {
      const bbox = aabbScreenBbox(
        ctx.viewProj,
        ctx.internalWidth,
        ctx.internalHeight,
        ctx.boxHalf,
        TILE_SIZE,
      );
      const rebuilt = this.tiles.record(
        encoder,
        ctx.frameUniformGpu,
        spec.occupancy ? this.occupancy : undefined,
        this.dummyOcc.gpu,
        ctx.internalWidth,
        ctx.internalHeight,
        bbox,
      );
      if (rebuilt) bindGroupDirty = true;
    }
    // Milestone 7.1: rebuild the opacity shadow map only when dirty (TF / density / light dir
    // changed) and shadows are on. Render-on-demand keeps this off the idle path.
    if (
      this.shadowMapEnabled &&
      ctx.shadowEnable &&
      this.dirtyShadow &&
      ctx.volumeTex &&
      ctx.tfTex &&
      ctx.tfSampler
    ) {
      const t = this.shadowMap.rebuild(encoder, ctx.volumeTex, ctx.tfTex, ctx.tfSampler, {
        lightDir: this.shadowLightDir,
        boxHalf: ctx.boxHalf,
        densityScale: ctx.densityScale,
        sigmaMul: 12,
        cropMin: ctx.cropMin,
        cropMax: ctx.cropMax,
      });
      this.worldToLightBuf.set(t.worldToLightUvw);
      this.shadowMapBuilt = true;
      this.dirtyShadow = false;
    }
    this.vis.recordCopy(encoder);
    return bindGroupDirty;
  }

  /** Map pending vis-bin readback. Must run after the encoder that copied it has been submitted. */
  public afterSubmit(): void {
    this.vis.afterSubmit();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lightEnv.dispose();
    this.occupancy?.dispose();
    this.vis.dispose();
    this.tiles.dispose();
    this.dummyOcc.dispose();
    this.dummyPrefix.dispose();
    this.dummyTiles.dispose();
    this.shadowMap.dispose();
    this.densityPyramid?.dispose();
    this.dummyDensityPyramid.dispose();
    this.occupancy = undefined;
    this.densityPyramid = undefined;
  }
}
