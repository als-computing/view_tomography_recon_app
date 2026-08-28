/**
 * Compile-time GPU state for the volume ray-march pass: bind-group layout, pipeline layout, the
 * main and background render pipelines (recompiled only when the shader config changes), and the
 * samplers/uniform buffer whose lifetime matches the pipeline rather than any single frame. Split
 * out of `VolumeRenderer` so `recordInto` can call `ensure()` immediately before use instead of
 * relying on `!` assertions against fields set up earlier in a different method.
 *
 * @packageDocumentation
 */

import type { Disposable } from "@zarr-viewer/core";
import type { GpuContext } from "../device/context.js";
import { ManagedBuffer } from "../resources/buffer.js";
import { PipelineCache } from "../resources/pipeline.js";
import {
  VOLUME_FRAME_UNIFORM_SIZE,
  VOLUME_BACKGROUND_WGSL,
  volumeRaymarchWgsl,
} from "../shaders/volume-raymarch.js";
import { type ShaderConfigName, specializationFor } from "../accel/shader-config.js";

/**
 * Second render target of the volume pass (Milestone 5.1): the transmittance-weighted depth centroid,
 * normalized by the far plane. Consumed by TAAU reprojection; a single filterable channel is enough.
 */
export const VOLUME_DEPTH_FORMAT: GPUTextureFormat = "r16float";

/** The background pipeline + its bind group, once both exist (bound together, always paired). */
export interface VolumeBackgroundPipeline {
  pipeline: GPURenderPipeline;
  bindGroup: GPUBindGroup;
}

/**
 * Owns the volume ray-march pipeline's compile-time GPU state. Call {@link ensure} once per frame
 * before use (a no-op after the first call for a given shader config); every other accessor throws
 * if read before `ensure()` has run at least once.
 */
export class VolumePipeline implements Disposable {
  private readonly cache: PipelineCache;
  private bindGroupLayout: GPUBindGroupLayout | undefined;
  private pipelineLayout: GPUPipelineLayout | undefined;
  private pipeline: GPURenderPipeline | undefined;
  private bgPipeline: GPURenderPipeline | undefined;
  private bgBindGroup: GPUBindGroup | undefined;
  private volumeSampler: GPUSampler | undefined;
  private tfSampler: GPUSampler | undefined;
  private frameUniform: ManagedBuffer | undefined;
  private disposed = false;

  public constructor(private readonly ctx: GpuContext) {
    this.cache = new PipelineCache(ctx.device);
  }

  public get layout(): GPUBindGroupLayout {
    return this.bindGroupLayout!;
  }

  public get renderPipeline(): GPURenderPipeline {
    return this.pipeline!;
  }

  /** `undefined` until the tile-compaction background pipeline has been built. */
  public get background(): VolumeBackgroundPipeline | undefined {
    return this.bgPipeline && this.bgBindGroup
      ? { pipeline: this.bgPipeline, bindGroup: this.bgBindGroup }
      : undefined;
  }

  public get uniformBuffer(): ManagedBuffer {
    return this.frameUniform!;
  }

  public get sampler(): GPUSampler {
    return this.volumeSampler!;
  }

  public get tfSamplerHandle(): GPUSampler {
    return this.tfSampler!;
  }

  /** Invalidate the main render pipeline (e.g. on a shader-config switch). */
  public invalidatePipeline(): void {
    this.pipeline = undefined;
  }

  /** Build (or reuse) every piece of compile-time state for `shaderConfig`/`colorFormat`. */
  public ensure(shaderConfig: ShaderConfigName, colorFormat: GPUTextureFormat): void {
    if (!this.bindGroupLayout) {
      const visFrag = GPUShaderStage.FRAGMENT;
      const visVert = GPUShaderStage.VERTEX;
      this.bindGroupLayout = this.ctx.device.createBindGroupLayout({
        label: "volume-raymarch",
        entries: [
          { binding: 0, visibility: visVert | visFrag, buffer: { type: "uniform" } },
          { binding: 1, visibility: visFrag, texture: { sampleType: "float", viewDimension: "3d" } },
          { binding: 2, visibility: visFrag, sampler: { type: "filtering" } },
          { binding: 3, visibility: visFrag, texture: { sampleType: "float", viewDimension: "2d" } },
          { binding: 4, visibility: visFrag, sampler: { type: "filtering" } },
          { binding: 5, visibility: visFrag, buffer: { type: "read-only-storage" } },
          { binding: 6, visibility: visFrag, texture: { sampleType: "float", viewDimension: "3d" } },
          { binding: 7, visibility: visFrag, buffer: { type: "storage" } },
          { binding: 8, visibility: visVert | visFrag, buffer: { type: "read-only-storage" } },
          { binding: 9, visibility: visFrag, buffer: { type: "read-only-storage" } },
          { binding: 10, visibility: visVert | visFrag, buffer: { type: "read-only-storage" } },
          { binding: 11, visibility: visFrag, texture: { sampleType: "float", viewDimension: "2d" } },
          { binding: 12, visibility: visFrag, texture: { sampleType: "float", viewDimension: "3d" } },
          { binding: 13, visibility: visFrag, texture: { sampleType: "unfilterable-float", viewDimension: "3d" } },
        ],
      });
      this.pipelineLayout = this.ctx.device.createPipelineLayout({
        bindGroupLayouts: [this.bindGroupLayout],
      });
    }
    if (!this.frameUniform) {
      this.frameUniform = new ManagedBuffer(
        this.ctx.device,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        VOLUME_FRAME_UNIFORM_SIZE,
      );
    }
    if (!this.volumeSampler) {
      this.volumeSampler = this.ctx.device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
        addressModeW: "clamp-to-edge",
      });
    }
    if (!this.tfSampler) {
      this.tfSampler = this.ctx.device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
      });
    }
    if (!this.bgPipeline) {
      const bgLayout = this.ctx.device.createBindGroupLayout({
        label: "volume-bg",
        entries: [
          { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        ],
      });
      const bgMod = this.cache.getModule("volume-background", VOLUME_BACKGROUND_WGSL);
      this.bgPipeline = this.cache.getRenderPipeline({
        label: "volume-background",
        layout: this.ctx.device.createPipelineLayout({ bindGroupLayouts: [bgLayout] }),
        vertex: { module: bgMod, entryPoint: "vs_main" },
        fragment: {
          module: bgMod,
          entryPoint: "fs_main",
          targets: [{ format: colorFormat }, { format: VOLUME_DEPTH_FORMAT }],
        },
        primitive: { topology: "triangle-list" },
      });
      this.bgBindGroup = this.ctx.device.createBindGroup({
        layout: bgLayout,
        entries: [{ binding: 0, resource: { buffer: this.frameUniform.gpu } }],
      });
    }
    if (this.pipeline) return;
    const spec = specializationFor(shaderConfig);
    const key = `volume-raymarch-${shaderConfig}`;
    const wgsl = volumeRaymarchWgsl(spec);
    const module = this.cache.getModule(key, wgsl);
    const blend = {
      color: {
        srcFactor: "src-alpha" as GPUBlendFactor,
        dstFactor: "one-minus-src-alpha" as GPUBlendFactor,
        operation: "add" as GPUBlendOperation,
      },
      alpha: {
        srcFactor: "one" as GPUBlendFactor,
        dstFactor: "one-minus-src-alpha" as GPUBlendFactor,
        operation: "add" as GPUBlendOperation,
      },
    };
    this.pipeline = this.cache.getRenderPipeline({
      label: key,
      layout: this.pipelineLayout!,
      vertex: { module, entryPoint: "vs_main" },
      fragment: {
        module,
        entryPoint: "fs_main",
        targets: [{ format: colorFormat, blend }, { format: VOLUME_DEPTH_FORMAT }],
      },
      primitive: { topology: "triangle-list" },
    });
    // Warm the other named configs asynchronously so a mid-session switch doesn't hitch.
    for (const name of ["fast", "quality"] as const) {
      if (name === shaderConfig) continue;
      const nSpec = specializationFor(name);
      const nKey = `volume-raymarch-${name}`;
      const nWgsl = volumeRaymarchWgsl(nSpec);
      const nMod = this.cache.getModule(nKey, nWgsl);
      void this.ctx.device.createRenderPipelineAsync({
        label: nKey,
        layout: this.pipelineLayout!,
        vertex: { module: nMod, entryPoint: "vs_main" },
        fragment: {
          module: nMod,
          entryPoint: "fs_main",
          targets: [{ format: colorFormat, blend }, { format: VOLUME_DEPTH_FORMAT }],
        },
        primitive: { topology: "triangle-list" },
      }).catch(() => {
        /* warm compile is best-effort */
      });
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.frameUniform?.dispose();
    this.frameUniform = undefined;
  }
}
