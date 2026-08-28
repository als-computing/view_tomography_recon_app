/**
 * Density mip pyramid (Milestone 3.2): a `(mean, meanSq)` mip chain over the volume texture, kept as
 * a *separate* `rg32float` 3D texture rather than adding mip levels to the volume texture itself —
 * lower blast radius, `volume-texture.ts`'s upload path stays untouched. `rg32float` (not `rg16float`)
 * because at typical tomography densities `mean²` and `meanSq` are nearly equal, and reconstructing
 * `variance = meanSq - mean²` in half-float precision loses most significant bits — the classic
 * two-pass-variance cancellation problem.
 *
 * Level 0 is built directly from the volume texture (`mean = density`, `meanSq = density²`); each
 * subsequent level box-averages the *previous level's* mean and meanSq **separately** (not squaring
 * the averaged mean — that would silently discard the within-cell variance the pyramid exists to
 * capture). Mirrors {@link OccupancyGrid}'s compute-pass structure (WGSL string → cached module →
 * bind-group layout → cached compute pipeline → per-call bind group → `beginComputePass`).
 *
 * @packageDocumentation
 */

import type { Disposable } from "@zarr-viewer/core";
import { ManagedBuffer } from "../resources/buffer.js";
import { ManagedTexture } from "../resources/texture.js";
import { PipelineCache } from "../resources/pipeline.js";

const BUILD_LEVEL0_WGSL = /* wgsl */ `
struct Params { dims: vec3<u32> }

@group(0) @binding(0) var volumeTex: texture_3d<f32>;
@group(0) @binding(1) var pyramidOut: texture_storage_3d<rg32float, write>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(4, 4, 4)
fn build_level0(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.dims.x || id.y >= params.dims.y || id.z >= params.dims.z) { return; }
  let d = textureLoad(volumeTex, vec3<i32>(id), 0).r;
  textureStore(pyramidOut, vec3<i32>(id), vec4<f32>(d, d * d, 0.0, 0.0));
}
`;

const DOWNSAMPLE_WGSL = /* wgsl */ `
struct Params { dstDims: vec3<u32> }

@group(0) @binding(0) var srcTex: texture_3d<f32>;
@group(0) @binding(1) var dstOut: texture_storage_3d<rg32float, write>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(4, 4, 4)
fn downsample(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.dstDims.x || id.y >= params.dstDims.y || id.z >= params.dstDims.z) { return; }
  let srcDims = vec3<i32>(textureDimensions(srcTex, 0));
  let base = vec3<i32>(id) * 2;
  var meanSum = 0.0;
  var meanSqSum = 0.0;
  var count = 0.0;
  for (var dz = 0; dz < 2; dz++) {
    for (var dy = 0; dy < 2; dy++) {
      for (var dx = 0; dx < 2; dx++) {
        let c = base + vec3<i32>(dx, dy, dz);
        if (any(c >= srcDims)) { continue; }
        let s = textureLoad(srcTex, c, 0);
        meanSum += s.r;
        meanSqSum += s.g;
        count += 1.0;
      }
    }
  }
  let inv = 1.0 / max(count, 1.0);
  textureStore(dstOut, vec3<i32>(id), vec4<f32>(meanSum * inv, meanSqSum * inv, 0.0, 0.0));
}
`;

function u32params(values: readonly number[]): Uint32Array {
  // Uniform buffers need 16-byte (vec4) alignment for a leading vec3; pad to 4 u32s.
  const out = new Uint32Array(4);
  out.set(values.slice(0, 4));
  return out;
}

function levelDims(baseDims: readonly [number, number, number], level: number): [number, number, number] {
  const div = 1 << level;
  return [
    Math.max(1, Math.ceil(baseDims[0] / div)),
    Math.max(1, Math.ceil(baseDims[1] / div)),
    Math.max(1, Math.ceil(baseDims[2] / div)),
  ];
}

/** `(mean, meanSq)` mip pyramid over a volume texture, rebuilt whenever the volume changes. */
export class DensityPyramid implements Disposable {
  public readonly texture: ManagedTexture;
  public readonly levelCount: number;
  private readonly cache: PipelineCache;
  private readonly level0Params: ManagedBuffer;
  private readonly downsampleParams: ManagedBuffer;
  private level0Layout: GPUBindGroupLayout | undefined;
  private level0Pipe: GPUComputePipeline | undefined;
  private downsampleLayout: GPUBindGroupLayout | undefined;
  private downsamplePipe: GPUComputePipeline | undefined;
  private disposed = false;

  public constructor(
    private readonly device: GPUDevice,
    public readonly baseDims: readonly [number, number, number],
  ) {
    // One level per halving down to a 1-voxel edge, capped at 8 (a deeper chain buys nothing once
    // cells are a handful of voxels across relative to typical tomography volume sizes).
    this.levelCount = Math.min(
      8,
      1 + Math.floor(Math.log2(Math.max(baseDims[0], baseDims[1], baseDims[2], 1))),
    );
    this.texture = new ManagedTexture(device, {
      size: baseDims,
      format: "rg32float",
      dimension: "3d",
      mipLevelCount: this.levelCount,
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.cache = new PipelineCache(device);
    this.level0Params = new ManagedBuffer(device, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, 16);
    this.downsampleParams = new ManagedBuffer(
      device,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      16,
    );
  }

  private ensurePipes(): void {
    if (this.level0Pipe && this.downsamplePipe) return;
    this.level0Layout = this.device.createBindGroupLayout({
      label: "density-pyramid-level0",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float", viewDimension: "3d" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rg32float", viewDimension: "3d" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      ],
    });
    this.downsampleLayout = this.device.createBindGroupLayout({
      label: "density-pyramid-downsample",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float", viewDimension: "3d" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rg32float", viewDimension: "3d" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      ],
    });
    const level0Mod = this.cache.getModule("density-pyramid-level0", BUILD_LEVEL0_WGSL);
    const downsampleMod = this.cache.getModule("density-pyramid-downsample", DOWNSAMPLE_WGSL);
    this.level0Pipe = this.cache.getComputePipeline({
      label: "density-pyramid-level0",
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.level0Layout] }),
      compute: { module: level0Mod, entryPoint: "build_level0" },
    });
    this.downsamplePipe = this.cache.getComputePipeline({
      label: "density-pyramid-downsample",
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.downsampleLayout] }),
      compute: { module: downsampleMod, entryPoint: "downsample" },
    });
  }

  /** Rebuild every mip level from `volume`. Call once per volume load (not per transfer-function change). */
  public rebuildFromVolume(encoder: GPUCommandEncoder, volume: ManagedTexture): void {
    this.ensurePipes();
    const dims0 = levelDims(this.baseDims, 0);
    this.level0Params.write(u32params(dims0));
    const level0Bg = this.device.createBindGroup({
      layout: this.level0Layout!,
      entries: [
        { binding: 0, resource: volume.createView({ dimension: "3d" }) },
        {
          binding: 1,
          resource: this.texture.createView({ dimension: "3d", baseMipLevel: 0, mipLevelCount: 1 }),
        },
        { binding: 2, resource: { buffer: this.level0Params.gpu } },
      ],
    });
    const pass = encoder.beginComputePass({ label: "density-pyramid-build" });
    pass.setPipeline(this.level0Pipe!);
    pass.setBindGroup(0, level0Bg);
    pass.dispatchWorkgroups(Math.ceil(dims0[0] / 4), Math.ceil(dims0[1] / 4), Math.ceil(dims0[2] / 4));

    for (let level = 1; level < this.levelCount; level++) {
      const dstDims = levelDims(this.baseDims, level);
      this.downsampleParams.write(u32params(dstDims));
      const bg = this.device.createBindGroup({
        layout: this.downsampleLayout!,
        entries: [
          {
            binding: 0,
            resource: this.texture.createView({
              dimension: "3d",
              baseMipLevel: level - 1,
              mipLevelCount: 1,
            }),
          },
          {
            binding: 1,
            resource: this.texture.createView({
              dimension: "3d",
              baseMipLevel: level,
              mipLevelCount: 1,
            }),
          },
          { binding: 2, resource: { buffer: this.downsampleParams.gpu } },
        ],
      });
      pass.setPipeline(this.downsamplePipe!);
      pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(Math.ceil(dstDims[0] / 4), Math.ceil(dstDims[1] / 4), Math.ceil(dstDims[2] / 4));
    }
    pass.end();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.texture.dispose();
    this.level0Params.dispose();
    this.downsampleParams.dispose();
  }
}
