/**
 * Light-space opacity shadow map (Milestone 7.1). A compute pass marches the volume along the light
 * axis and stores the accumulated optical depth τ (from the light to each point) into a 3D light-space
 * texture. The ray-march then replaces its per-sample brute shadow march (up to ~24 taps per shaded
 * sample) with one trilinear lookup — much cheaper, and smooth instead of dithered.
 *
 * This is the plan's "light-axis τ-sweep" representation: softer / lower depth-resolution than AVSM,
 * but robust and cheap. τ depends on the transfer function, density scale, and light direction, so the
 * map is rebuilt on demand when any of those change (never per idle frame — see render-on-demand).
 *
 * @packageDocumentation
 */

import type { Disposable } from "@zarr-viewer/core";
import { ManagedBuffer } from "../resources/buffer.js";
import { ManagedTexture } from "../resources/texture.js";
import { PipelineCache } from "../resources/pipeline.js";

/** Default light-space texture size: good lateral resolution, coarser depth (τ is smooth in depth). */
export const SHADOW_DIMS: readonly [number, number, number] = [128, 128, 64];

/**
 * Orthonormal light basis + the box's projected half-extents on it, plus the `worldToLightUvw` matrix
 * the ray-march samples with. `fwd` points from the light into the volume (the shadow march direction).
 */
export interface ShadowTransform {
  right: [number, number, number];
  up: [number, number, number];
  fwd: [number, number, number];
  projRight: number;
  projUp: number;
  projFwd: number;
  /** Column-major mat4 mapping a world point to `[0,1]³` light-space UVW (for the frame uniform). */
  worldToLightUvw: Float32Array;
}

/**
 * Build the light basis for `lightDir` (a unit vector *toward* the light) over an origin-centered AABB
 * with half-extents `boxHalf`, and the world→light-UVW matrix. Pure; unit-tested.
 */
export function shadowTransform(
  lightDir: readonly [number, number, number],
  boxHalf: readonly [number, number, number],
): ShadowTransform {
  const norm = (v: [number, number, number]): [number, number, number] => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const cross = (
    a: readonly [number, number, number],
    b: readonly [number, number, number],
  ): [number, number, number] => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  // March from the light into the volume: fwd = -lightDir.
  const fwd = norm([-lightDir[0], -lightDir[1], -lightDir[2]]);
  const upHint: [number, number, number] = Math.abs(fwd[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
  const right = norm(cross(upHint, fwd));
  const up = norm(cross(fwd, right));
  // Half-extent of the origin-centered box projected onto each light axis (support of the AABB).
  const proj = (ax: [number, number, number]): number =>
    boxHalf[0] * Math.abs(ax[0]) + boxHalf[1] * Math.abs(ax[1]) + boxHalf[2] * Math.abs(ax[2]);
  const pr = Math.max(1e-6, proj(right));
  const pu = Math.max(1e-6, proj(up));
  const pf = Math.max(1e-6, proj(fwd));
  // lc = dot(axis, P)/(2·proj) + 0.5. Column-major so that (M * vec4(P,1)).xyz == lc.
  const m = new Float32Array(16);
  m[0] = right[0] / (2 * pr); m[4] = right[1] / (2 * pr); m[8] = right[2] / (2 * pr); m[12] = 0.5;
  m[1] = up[0] / (2 * pu);    m[5] = up[1] / (2 * pu);    m[9] = up[2] / (2 * pu);    m[13] = 0.5;
  m[2] = fwd[0] / (2 * pf);   m[6] = fwd[1] / (2 * pf);   m[10] = fwd[2] / (2 * pf);  m[14] = 0.5;
  m[3] = 0; m[7] = 0; m[11] = 0; m[15] = 1;
  return { right, up, fwd, projRight: pr, projUp: pu, projFwd: pf, worldToLightUvw: m };
}

const BUILD_WGSL = /* wgsl */ `
struct Params {
  right: vec4<f32>,   // xyz basis, w = projRight
  up: vec4<f32>,      // xyz basis, w = projUp
  fwd: vec4<f32>,     // xyz basis (light → volume), w = projFwd
  boxHalf: vec4<f32>, // xyz volume half-extents
  dims: vec4<u32>,    // xyz = light-texture dims
  cfg: vec4<f32>,     // x = densityScale, y = sigmaMul
}

@group(0) @binding(0) var volumeTex: texture_3d<f32>;
@group(0) @binding(1) var volSamp: sampler;
@group(0) @binding(2) var tfTex: texture_2d<f32>;
@group(0) @binding(3) var tfSamp: sampler;
@group(0) @binding(4) var shadowOut: texture_storage_3d<rgba16float, write>;
@group(0) @binding(5) var<uniform> p: Params;

@compute @workgroup_size(8, 8, 1)
fn build(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.dims.x || id.y >= p.dims.y) { return; }
  let sw = f32(p.dims.x);
  let sh = f32(p.dims.y);
  let sd = i32(p.dims.z);
  let li = (f32(id.x) + 0.5) / sw;
  let lj = (f32(id.y) + 0.5) / sh;
  let projR = p.right.w;
  let projU = p.up.w;
  let projF = p.fwd.w;
  let stepF = (2.0 * projF) / f32(sd);
  let r = li * 2.0 * projR - projR;
  let u = lj * 2.0 * projU - projU;
  var tau = 0.0;
  for (var k = 0; k < sd; k = k + 1) {
    // Store τ from the light to the NEAR side of this slice, so a sample here is shadowed by everything
    // between it and the light (self-shadow correct; the +0.5 texel offset gives a small bias).
    textureStore(shadowOut, vec3<i32>(i32(id.x), i32(id.y), k), vec4<f32>(tau, 0.0, 0.0, 0.0));
    let f = ((f32(k) + 0.5) / f32(sd)) * 2.0 * projF - projF;
    let worldP = p.right.xyz * r + p.up.xyz * u + p.fwd.xyz * f;
    let uvw = (worldP + p.boxHalf.xyz) / (2.0 * p.boxHalf.xyz);
    if (all(uvw >= vec3<f32>(0.0)) && all(uvw <= vec3<f32>(1.0))) {
      let d = textureSampleLevel(volumeTex, volSamp, uvw, 0.0).r;
      let a = textureSampleLevel(tfTex, tfSamp, vec2<f32>(d, 0.5), 0.0).a;
      tau = tau + max(a, 0.0) * p.cfg.x * p.cfg.y * stepF;
    }
  }
}
`;

/** GPU light-space opacity shadow map. Rebuild via {@link ShadowMap.rebuild} when inputs change. */
export class ShadowMap implements Disposable {
  readonly dims: [number, number, number];
  private readonly tex: ManagedTexture;
  private readonly params: ManagedBuffer;
  private readonly sampler: GPUSampler;
  private readonly cache: PipelineCache;
  private pipeline: GPUComputePipeline | undefined;
  private layout: GPUBindGroupLayout | undefined;

  public constructor(
    private readonly device: GPUDevice,
    dims: readonly [number, number, number] = SHADOW_DIMS,
  ) {
    this.dims = [dims[0], dims[1], dims[2]];
    this.tex = new ManagedTexture(device, {
      size: this.dims,
      format: "rgba16float",
      dimension: "3d",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.params = new ManagedBuffer(device, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, 96);
    this.sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
      addressModeW: "clamp-to-edge",
    });
    this.cache = new PipelineCache(device);
  }

  /** The light-space τ texture, sampled by the ray-march (bound as a 3D float texture). */
  public get texture(): ManagedTexture {
    return this.tex;
  }

  /**
   * Recompute the τ field for `lightDir` (unit, toward the light), the origin-centered volume AABB, and
   * the current TF. Returns the {@link ShadowTransform} whose `worldToLightUvw` the caller uploads.
   */
  public rebuild(
    encoder: GPUCommandEncoder,
    volume: ManagedTexture,
    tf: ManagedTexture,
    tfSampler: GPUSampler,
    opts: {
      lightDir: readonly [number, number, number];
      boxHalf: readonly [number, number, number];
      densityScale: number;
      sigmaMul: number;
    },
  ): ShadowTransform {
    this.ensurePipeline();
    const t = shadowTransform(opts.lightDir, opts.boxHalf);
    const raw = new ArrayBuffer(96);
    const f = new Float32Array(raw);
    const u = new Uint32Array(raw);
    f[0] = t.right[0]; f[1] = t.right[1]; f[2] = t.right[2]; f[3] = t.projRight;
    f[4] = t.up[0]; f[5] = t.up[1]; f[6] = t.up[2]; f[7] = t.projUp;
    f[8] = t.fwd[0]; f[9] = t.fwd[1]; f[10] = t.fwd[2]; f[11] = t.projFwd;
    f[12] = opts.boxHalf[0]; f[13] = opts.boxHalf[1]; f[14] = opts.boxHalf[2]; f[15] = 0;
    u[16] = this.dims[0]; u[17] = this.dims[1]; u[18] = this.dims[2]; u[19] = 0;
    f[20] = opts.densityScale; f[21] = opts.sigmaMul; f[22] = 0; f[23] = 0;
    this.params.write(new Uint8Array(raw));

    const bg = this.device.createBindGroup({
      layout: this.layout!,
      entries: [
        { binding: 0, resource: volume.createView({ dimension: "3d" }) },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: tf.createView({ dimension: "2d" }) },
        { binding: 3, resource: tfSampler },
        { binding: 4, resource: this.tex.createView({ dimension: "3d" }) },
        { binding: 5, resource: { buffer: this.params.gpu } },
      ],
    });
    const pass = encoder.beginComputePass({ label: "shadow-map-build" });
    pass.setPipeline(this.pipeline!);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(this.dims[0] / 8), Math.ceil(this.dims[1] / 8));
    pass.end();
    return t;
  }

  public dispose(): void {
    this.tex.dispose();
    this.params.dispose();
  }

  private ensurePipeline(): void {
    if (this.pipeline) return;
    this.layout = this.device.createBindGroupLayout({
      label: "shadow-map",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float", viewDimension: "3d" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float", viewDimension: "2d" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
        {
          binding: 4,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: "write-only", format: "rgba16float", viewDimension: "3d" },
        },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      ],
    });
    const mod = this.cache.getModule("shadow-map-build", BUILD_WGSL);
    this.pipeline = this.cache.getComputePipeline({
      label: "shadow-map-build",
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module: mod, entryPoint: "build" },
    });
  }
}
