/**
 * Temporal accumulation (Milestone 5, static-camera core): while the camera is still, jittered frames
 * are progressively averaged into a persistent history texture — supersampling edges and denoising the
 * per-frame stochastic noise (jittered shadows / AO / ray starts) toward a clean converged image. Any
 * camera or rendering change {@link TemporalAccumulator.reset}s the accumulation, so a moving view shows
 * the live (adaptive-sampled) frame with NO ghosting — the classic TAAU failure mode is sidestepped by
 * not reprojecting. Full motion reprojection (5.1 depth-centroid + 5.2 reproject/variance-clip) is the
 * next increment; this ships the accumulation + jitter foundation behind a default-off toggle.
 *
 * @packageDocumentation
 */

import { ManagedBuffer } from "../resources/buffer.js";
import { PipelineCache } from "../resources/pipeline.js";
import type { RenderGraph, ResourceHandle } from "../graph/render-graph.js";

/** Van der Corput / Halton low-discrepancy sample for sub-pixel jitter. */
export function halton(index: number, base: number): number {
  let f = 1;
  let r = 0;
  let i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

const HDR_FORMAT: GPUTextureFormat = "rgba16float";

const BLEND_WGSL = /* wgsl */ `
struct Params {
  invViewProj: mat4x4<f32>,   // current frame: reconstruct a world ray from a screen uv
  prevViewProj: mat4x4<f32>,  // previous frame: project a world point into history uv
  eyePivot: vec4<f32>,        // xyz = camera eye, w = far plane (denormalizes the per-pixel depth)
  misc: vec4<f32>,            // x = blend weight, y = reproject enable, zw = (1/width, 1/height)
}
@group(0) @binding(0) var curTex: texture_2d<f32>;
@group(0) @binding(1) var histTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var depthTex: texture_2d<f32>; // per-pixel depth centroid / far (Milestone 5.1)

struct VSOut { @builtin(position) clip: vec4<f32>, @location(0) uv: vec2<f32> }

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var out: VSOut;
  out.clip = vec4<f32>(p[vi], 0.0, 1.0);
  out.uv = p[vi] * 0.5 + 0.5;
  return out;
}

// World ray direction through the sampling uv (suv), using this frame's inverse view-projection. suv is
// the texture-sampling uv; ndc = suv*2-1 (the convention the volume shader reconstructs rays with).
fn worldRay(suv: vec2<f32>) -> vec3<f32> {
  let ndc = suv * 2.0 - vec2<f32>(1.0);
  let nh = params.invViewProj * vec4<f32>(ndc, 0.0, 1.0);
  let fh = params.invViewProj * vec4<f32>(ndc, 1.0, 1.0);
  return normalize(fh.xyz / fh.w - nh.xyz / nh.w);
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  let suv = vec2<f32>(in.uv.x, 1.0 - in.uv.y);
  let cur = textureSampleLevel(curTex, samp, suv, 0.0);
  let weight = clamp(params.misc.x, 0.0, 1.0);

  if (params.misc.y < 0.5) {
    // Still camera: straight running average (weight = 1/(n+1)); weight == 1 reseeds history.
    let hist = textureSampleLevel(histTex, samp, suv, 0.0);
    return vec4<f32>(mix(hist.rgb, cur.rgb, weight), 1.0);
  }

  // Moving camera — per-pixel reprojection (Milestone 5.1): reconstruct this pixel's world point from its
  // transmittance-weighted depth centroid, find where it sat in the previous frame, and sample history
  // there. The variance clip below still guards disocclusion / thin edges.
  let rd = worldRay(suv);
  let d01 = textureSampleLevel(depthTex, samp, suv, 0.0).r;
  let worldP = params.eyePivot.xyz + rd * (d01 * params.eyePivot.w);
  let pc = params.prevViewProj * vec4<f32>(worldP, 1.0);
  if (pc.w <= 0.0) { return vec4<f32>(cur.rgb, 1.0); }
  let puv = pc.xy / pc.w * 0.5 + vec2<f32>(0.5);
  if (any(puv < vec2<f32>(0.0)) || any(puv > vec2<f32>(1.0))) {
    return vec4<f32>(cur.rgb, 1.0); // reprojected off-screen (disoccluded) → take the live frame
  }
  let hist = textureSampleLevel(histTex, samp, puv, 0.0).rgb;

  // Neighborhood variance clip: clamp the reprojected history to the 3×3 colour AABB of the current
  // frame. This is what suppresses ghosting when the planar reprojection is wrong (parallax / occlusion)
  // — mismatched history is pulled back to the local colour range instead of smearing.
  let tx = params.misc.z;
  let ty = params.misc.w;
  var cmin = cur.rgb;
  var cmax = cur.rgb;
  for (var dy = -1; dy <= 1; dy = dy + 1) {
    for (var dx = -1; dx <= 1; dx = dx + 1) {
      let s = textureSampleLevel(curTex, samp, suv + vec2<f32>(f32(dx) * tx, f32(dy) * ty), 0.0).rgb;
      cmin = min(cmin, s);
      cmax = max(cmax, s);
    }
  }
  let histClamped = clamp(hist, cmin, cmax);
  return vec4<f32>(mix(histClamped, cur.rgb, weight), 1.0);
}
`;

/** Progressive temporal accumulator with sub-pixel jitter, gated on a still camera. */
export class TemporalAccumulator {
  #enabled = false;
  #w = 0;
  #h = 0;
  #n = 0; // frames accumulated since the last reset (0 = next frame reseeds history)
  #readA = true; // which history texture holds the previous accumulated result
  #historyA: GPUTexture | undefined;
  #historyB: GPUTexture | undefined;
  readonly #sampler: GPUSampler;
  readonly #params: ManagedBuffer;
  readonly #cache: PipelineCache;
  #pipeline: GPURenderPipeline | undefined;
  #layout: GPUBindGroupLayout | undefined;
  // Reprojection state (set per frame by the viewer; used while the camera moves).
  #reproject = false;
  #far = 1;
  #eye: [number, number, number] = [0, 0, 0];
  readonly #curInvVP = new Float32Array(16);
  readonly #curVP = new Float32Array(16);
  readonly #prevVP = new Float32Array(16);
  #hasPrev = false;

  /** Cap on the running average before it becomes exponential (keeps responding to subtle changes). */
  public maxAccum = 64;
  /** History never exceeds this fraction while the camera moves — keeps reprojected motion responsive. */
  public motionWeightFloor = 0.12;

  public constructor(private readonly device: GPUDevice) {
    this.#cache = new PipelineCache(device);
    this.#params = new ManagedBuffer(device, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, 160);
    this.#sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
  }

  /**
   * Per-frame reprojection inputs. `invViewProj` (current) reconstructs world rays; `viewProj` (current)
   * is stored to become next frame's `prevViewProj`. `far` denormalizes the per-pixel depth centroid.
   * `enable` turns on motion reprojection (off = plain still accumulation).
   */
  public setReprojection(
    invViewProj: ArrayLike<number>,
    viewProj: ArrayLike<number>,
    eye: readonly [number, number, number],
    far: number,
    enable: boolean,
  ): void {
    this.#curInvVP.set(invViewProj);
    this.#curVP.set(viewProj);
    this.#eye = [eye[0], eye[1], eye[2]];
    this.#far = far;
    this.#reproject = enable;
  }

  public get enabled(): boolean {
    return this.#enabled;
  }

  public setEnabled(on: boolean): void {
    if (this.#enabled === on) return;
    this.#enabled = on;
    this.reset();
  }

  /** Discard accumulated history (call on any camera / rendering change). */
  public reset(): void {
    this.#n = 0;
  }

  /** Frames converged since the last reset (0 while moving; grows while still). */
  public get sampleCount(): number {
    return this.#n;
  }

  /**
   * Sub-pixel jitter (in pixels, roughly `[-0.5, 0.5]`) for the frame about to be rendered. Zero when
   * disabled. Advances with the accumulation index so each converged frame samples a new offset.
   */
  public jitterPixels(): [number, number] {
    if (!this.#enabled) return [0, 0];
    const k = this.#n + 1;
    return [halton(k, 2) - 0.5, halton(k, 3) - 0.5];
  }

  /**
   * Add the accumulate pass to `graph` and return the handle the post stack should read. `current` is
   * this frame's freshly-rendered (jittered) HDR. Sized to `w × h`; a size change reseeds history.
   */
  public resolve(
    graph: RenderGraph,
    current: ResourceHandle,
    depth: ResourceHandle,
    w: number,
    h: number,
  ): ResourceHandle {
    this.#ensureTextures(w, h);
    this.#ensurePipeline();
    const prev = this.#readA ? this.#historyA! : this.#historyB!;
    const next = this.#readA ? this.#historyB! : this.#historyA!;
    const base = 1 / (this.#n + 1);
    const reproject = this.#reproject && this.#hasPrev;
    const weight = reproject ? Math.max(base, this.motionWeightFloor) : base;

    // Uniform: invViewProj(16) | prevViewProj(16) | eyePivot(4) | misc(4). Use current viewProj as the
    // "prev" on the first frame (identity reprojection) so nothing garbage is sampled.
    const u = new Float32Array(40);
    u.set(this.#curInvVP, 0);
    u.set(reproject ? this.#prevVP : this.#curVP, 16);
    u[32] = this.#eye[0];
    u[33] = this.#eye[1];
    u[34] = this.#eye[2];
    u[35] = this.#far;
    u[36] = weight;
    u[37] = reproject ? 1 : 0;
    u[38] = 1 / Math.max(1, w);
    u[39] = 1 / Math.max(1, h);
    this.#params.write(u);
    this.#prevVP.set(this.#curVP);
    this.#hasPrev = true;

    const curH = current;
    const depthH = depth;
    const prevH = graph.importTexture(prev, "taau-hist-prev", HDR_FORMAT);
    const nextH = graph.importTexture(next, "taau-hist-next", HDR_FORMAT);
    const device = this.device;
    const pipeline = this.#pipeline!;
    const layout = this.#layout!;
    const sampler = this.#sampler;
    const paramsBuf = this.#params.gpu;
    graph.addPass({
      name: "taau-accumulate",
      reads: [curH, prevH, depthH],
      writes: [nextH],
      execute(ctx): void {
        const bg = device.createBindGroup({
          layout,
          entries: [
            { binding: 0, resource: ctx.texture(curH).createView() },
            { binding: 1, resource: ctx.texture(prevH).createView() },
            { binding: 2, resource: sampler },
            { binding: 3, resource: { buffer: paramsBuf } },
            { binding: 4, resource: ctx.texture(depthH).createView() },
          ],
        });
        const pass = ctx.encoder.beginRenderPass({
          label: "taau-accumulate",
          colorAttachments: [
            { view: ctx.texture(nextH).createView(), loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" },
          ],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bg);
        pass.draw(3);
        pass.end();
      },
    });

    this.#n = Math.min(this.#n + 1, this.maxAccum);
    this.#readA = !this.#readA;
    return nextH;
  }

  public dispose(): void {
    this.#historyA?.destroy();
    this.#historyB?.destroy();
    this.#historyA = undefined;
    this.#historyB = undefined;
    this.#params.dispose();
  }

  #ensureTextures(w: number, h: number): void {
    if (this.#w === w && this.#h === h && this.#historyA && this.#historyB) return;
    this.#historyA?.destroy();
    this.#historyB?.destroy();
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    const make = (label: string): GPUTexture =>
      this.device.createTexture({ label, size: [w, h, 1], format: HDR_FORMAT, usage });
    this.#historyA = make("taau-history-a");
    this.#historyB = make("taau-history-b");
    this.#w = w;
    this.#h = h;
    this.#n = 0; // reseed on resize
  }

  #ensurePipeline(): void {
    if (this.#pipeline) return;
    this.#layout = this.device.createBindGroupLayout({
      label: "taau-blend",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      ],
    });
    const mod = this.#cache.getModule("taau-blend", BLEND_WGSL);
    this.#pipeline = this.#cache.getRenderPipeline({
      label: "taau-blend",
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.#layout] }),
      vertex: { module: mod, entryPoint: "vs_main" },
      fragment: { module: mod, entryPoint: "fs_main", targets: [{ format: HDR_FORMAT }] },
      primitive: { topology: "triangle-list" },
    });
  }
}
