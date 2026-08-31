/**
 * Post-processing driver for the OME-Zarr viewer: renders the volume into a linear-HDR target and
 * runs a {@link PostStack} (bloom → tonemap → FXAA → sharpen → vignette) through a {@link RenderGraph}
 * to the swapchain, in one encoder / one submit.
 *
 * A single graph is reused across frames (via {@link RenderGraph.reset}) so its physical-texture pool
 * persists — the per-frame transient HDR + ping-pong targets are pooled, not reallocated. The
 * {@link PostStack} is rebuilt only when the FX UI changes (each effect caches a `FullscreenPass`);
 * {@link FxPipeline.setStack} disposes the previous stack so those pipelines don't accumulate.
 *
 * @packageDocumentation
 */

import type { GpuContext } from "../device/context.js";
import { RenderGraph, type ResourceHandle } from "../graph/render-graph.js";
import { PostStack, type Effect } from "@zarr-viewer/fx";
import { GpuTimer } from "../accel/gpu-timer.js";
import { PipelineCache } from "../resources/pipeline.js";
import { ManagedBuffer } from "../resources/buffer.js";
import type { TemporalAccumulator } from "../accel/taau.js";
import type { LightingPassGbuffer } from "../accel/lighting-pass.js";
import { VOLUME_DEPTH_FORMAT } from "../volume/volume-renderer.js";

/** RENDER_ATTACHMENT | TEXTURE_BINDING — the HDR target must be both drawn to and sampled. */
const HDR_USAGE = 0x10 | 0x04;
const HDR_FORMAT: GPUTextureFormat = "rgba16float";

/** Milestone 6 (B3) Step 5: routes the half-res `lightAdd` result straight to the swapchain (bilinear
 * upscaled, unflipped-uv corrected the same way TAAU reads the volume pass's targets) instead of the
 * normal post stack, for a quick visual sanity check. Debug-only - removed once B3 ships for real. */
const DEBUG_BLIT_WGSL = /* wgsl */ `
@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;

struct VSOut { @builtin(position) clip: vec4<f32>, @location(0) uv: vec2<f32> }

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var out: VSOut;
  out.clip = vec4<f32>(p[vi], 0.0, 1.0);
  out.uv = p[vi] * 0.5 + 0.5;
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  let suv = vec2<f32>(in.uv.x, 1.0 - in.uv.y);
  let c = textureSampleLevel(srcTex, srcSampler, suv, 0.0);
  return vec4<f32>(c.rgb, 1.0);
}
`;

/**
 * Milestone 6 (B3) Step 6: joint-bilateral upsample of the half-res `lightAdd` (rgb = diffuseSpec) back
 * to full res, guided by the full-res depth centroid + surface normal (edge-stopping so a thin near
 * feature over empty space doesn't bleed), added onto `colorUnlit` (which already carries the per-sample
 * ambient/AO/rim terms - see volume-raymarch.ts's shadeSample). Falls back to a plain bilinear blend
 * when every neighbor's bilateral weight underflows (matches accel/bilateral-upsample.ts's CPU fallback,
 * which this WGSL mirrors but does not share code with - no native WGSL import mechanism exists).
 */
const LIGHTING_COMPOSITE_WGSL = /* wgsl */ `
struct Params {
  sigmaDepth: f32,
  sigmaNormal: f32,
  halfW: f32,
  halfH: f32,
}
@group(0) @binding(0) var colorUnlitTex: texture_2d<f32>;
@group(0) @binding(1) var depthTex: texture_2d<f32>;
@group(0) @binding(2) var normalTex: texture_2d<f32>;
@group(0) @binding(3) var lightAddTex: texture_2d<f32>;
@group(0) @binding(4) var samp: sampler;
@group(0) @binding(5) var<uniform> params: Params;

struct VSOut { @builtin(position) clip: vec4<f32>, @location(0) uv: vec2<f32> }

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var out: VSOut;
  out.clip = vec4<f32>(p[vi], 0.0, 1.0);
  out.uv = p[vi] * 0.5 + 0.5;
  return out;
}

fn bilateralWeight(dA: f32, dB: f32, nA: vec3<f32>, nB: vec3<f32>, sigmaDepth: f32, sigmaNormal: f32) -> f32 {
  let dd = dA - dB;
  let wd = exp(-(dd * dd) / max(2.0 * sigmaDepth * sigmaDepth, 1e-6));
  let cosAngle = clamp(dot(nA, nB), -1.0, 1.0);
  let angle = acos(cosAngle);
  let wn = exp(-(angle * angle) / max(2.0 * sigmaNormal * sigmaNormal, 1e-6));
  return wd * wn;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  let suv = vec2<f32>(in.uv.x, 1.0 - in.uv.y);
  let unlit = textureSampleLevel(colorUnlitTex, samp, suv, 0.0);
  let fullDepth = textureSampleLevel(depthTex, samp, suv, 0.0).r;
  let fullNormal = textureSampleLevel(normalTex, samp, suv, 0.0).xyz;

  let halfSize = vec2<f32>(params.halfW, params.halfH);
  let hpos = suv * halfSize - vec2<f32>(0.5);
  let base = floor(hpos);
  let fracPos = hpos - base;

  var sumColor = vec3<f32>(0.0);
  var sumW = 0.0;
  var sumColorLin = vec3<f32>(0.0);
  var sumWLin = 0.0;
  for (var dy = 0; dy < 2; dy = dy + 1) {
    for (var dx = 0; dx < 2; dx = dx + 1) {
      let texel = clamp(base + vec2<f32>(f32(dx), f32(dy)), vec2<f32>(0.0), halfSize - vec2<f32>(1.0));
      let bw = select(fracPos.x, 1.0 - fracPos.x, dx == 0) * select(fracPos.y, 1.0 - fracPos.y, dy == 0);
      let neighborUv = (texel + vec2<f32>(0.5)) / halfSize;
      let nD = textureSampleLevel(depthTex, samp, neighborUv, 0.0).r;
      let nN = textureSampleLevel(normalTex, samp, neighborUv, 0.0).xyz;
      let c = textureLoad(lightAddTex, vec2<i32>(texel), 0).rgb;
      let w = bilateralWeight(fullDepth, nD, fullNormal, nN, params.sigmaDepth, params.sigmaNormal) * bw;
      sumColor += c * w;
      sumW += w;
      sumColorLin += c * bw;
      sumWLin += bw;
    }
  }
  var lightAdd = vec3<f32>(0.0);
  if (sumW > 1e-5) {
    lightAdd = sumColor / sumW;
  } else if (sumWLin > 1e-5) {
    lightAdd = sumColorLin / sumWLin;
  }
  return vec4<f32>(unlit.rgb + lightAdd, unlit.a);
}
`;

/** Owns the reusable render graph + post stack that turn the volume draw into the presented image. */
export class FxPipeline {
  readonly #ctx: GpuContext;
  readonly #graph: RenderGraph;
  #stack: PostStack;
  /**
   * Fraction of the swapchain resolution the volume + post chain runs at (1 = full). Lower values
   * (e.g. 0.5) quarter the per-pixel shadow/AO marching cost; the final post pass bilinearly
   * upscales the result to the full-res swapchain.
   */
  #renderScale = 1;
  readonly #timer: GpuTimer;
  readonly #debugCache: PipelineCache;
  #debugPipeline: GPURenderPipeline | undefined;
  #debugLayout: GPUBindGroupLayout | undefined;
  #debugSampler: GPUSampler | undefined;
  readonly #compositeCache: PipelineCache;
  #compositePipeline: GPURenderPipeline | undefined;
  #compositeLayout: GPUBindGroupLayout | undefined;
  #compositeSampler: GPUSampler | undefined;
  #compositeParams: ManagedBuffer | undefined;

  /**
   * Fraction of the swapchain resolution the volume + post chain runs at (1 = full).
   */
  public get renderScale(): number {
    return this.#renderScale;
  }

  /** Last resolved GPU time for the volume pass, if timestamp-query is available. */
  public get lastGpuMs(): number | undefined {
    return this.#timer.lastSample?.ms;
  }

  public constructor(ctx: GpuContext) {
    this.#ctx = ctx;
    this.#graph = new RenderGraph(ctx.device);
    this.#stack = new PostStack([]);
    this.#timer = new GpuTimer(ctx.device);
    this.#debugCache = new PipelineCache(ctx.device);
    this.#compositeCache = new PipelineCache(ctx.device);
  }

  /** Set the internal render resolution as a fraction (0, 1] of the swapchain size. */
  public setRenderScale(scale: number): void {
    this.#renderScale = Math.min(1, Math.max(0.1, scale));
  }

  /**
   * Replace the effect chain. Disposes the previous stack's cached passes first (the FX UI calls this
   * on any toggle/param change, never per frame). `tonemap` should always be present so the chain
   * ends by writing the swapchain.
   */
  public setStack(effects: readonly Effect[]): void {
    this.#stack.dispose();
    this.#stack = new PostStack(effects);
  }

  /**
   * Render one frame: optional compute prepare (occupancy / tiles / vis copy), draw the volume into
   * a linear-HDR transient, then run the post stack to the swapchain.
   */
  public render(
    clearValue: GPUColor,
    recordVolume: (pass: GPURenderPassEncoder) => void,
    prepare?: (encoder: GPUCommandEncoder) => void,
    taau?: TemporalAccumulator,
    /**
     * Milestone 6 (B3), opt-in: when supplied, the half-res G-buffer lighting pass is added to the
     * graph via `recordLighting`. `mode: "debug"` (Step 5) blits the raw `lightAdd` straight to the
     * swapchain, bypassing TAAU/the post stack, for a quick visual sanity check. `mode: "composite"`
     * (Step 6) bilateral-upsamples `lightAdd` and adds it onto `colorUnlit`, replacing the normal
     * per-sample-lit `hdr` as the scene color TAAU/the post stack then run on as usual.
     */
    lighting?: {
      recordLighting: (graph: RenderGraph, gbuffer: LightingPassGbuffer, w: number, h: number) => ResourceHandle | undefined;
      mode: "debug" | "composite";
      sigmaDepth?: number;
      sigmaNormal?: number;
    },
  ): void {
    const { canvasContext, canvas, format } = this.#ctx;
    const w = Math.max(1, canvas.width);
    const h = Math.max(1, canvas.height);
    const rw = Math.max(1, Math.round(w * this.#renderScale));
    const rh = Math.max(1, Math.round(h * this.#renderScale));
    const graph = this.#graph.reset();
    const timer = this.#timer;

    const hdr = graph.createTexture({ size: [rw, rh, 1], format: HDR_FORMAT, usage: HDR_USAGE });
    // Milestone 5.1: second render target = the per-pixel depth centroid (for TAAU reprojection).
    const depth = graph.createTexture({ size: [rw, rh, 1], format: VOLUME_DEPTH_FORMAT, usage: HDR_USAGE });
    // Milestone 6 (B3) G-buffer targets, see volume-raymarch.ts's FragOut - populated for real,
    // not yet consumed by anything downstream.
    const colorUnlit = graph.createTexture({ size: [rw, rh, 1], format: HDR_FORMAT, usage: HDR_USAGE });
    const surfacePos = graph.createTexture({ size: [rw, rh, 1], format: HDR_FORMAT, usage: HDR_USAGE });
    const surfaceNormal = graph.createTexture({ size: [rw, rh, 1], format: HDR_FORMAT, usage: HDR_USAGE });
    const surfaceAlbedo = graph.createTexture({ size: [rw, rh, 1], format: HDR_FORMAT, usage: HDR_USAGE });
    graph.addPass({
      name: "volume",
      writes: [hdr, depth, colorUnlit, surfacePos, surfaceNormal, surfaceAlbedo],
      execute(ctx): void {
        prepare?.(ctx.encoder);
        const pass = ctx.encoder.beginRenderPass({
          label: "volume-raymarch",
          colorAttachments: [
            {
              view: ctx.texture(hdr).createView(),
              clearValue,
              loadOp: "clear",
              storeOp: "store",
            },
            {
              view: ctx.texture(depth).createView(),
              clearValue: { r: 1, g: 0, b: 0, a: 0 }, // far
              loadOp: "clear",
              storeOp: "store",
            },
            {
              view: ctx.texture(colorUnlit).createView(),
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: "clear",
              storeOp: "store",
            },
            {
              view: ctx.texture(surfacePos).createView(),
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: "clear",
              storeOp: "store",
            },
            {
              view: ctx.texture(surfaceNormal).createView(),
              clearValue: { r: 0, g: 1, b: 0, a: 0 },
              loadOp: "clear",
              storeOp: "store",
            },
            {
              view: ctx.texture(surfaceAlbedo).createView(),
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: "clear",
              storeOp: "store",
            },
          ],
          timestampWrites: timer.timestampWrites("volume"),
        });
        recordVolume(pass);
        pass.end();
        timer.resolve(ctx.encoder);
      },
    });

    const out = graph.importTexture(canvasContext.getCurrentTexture(), "swap", format);

    const lightAdd = lighting?.recordLighting(graph, { surfacePos, surfaceNormal, surfaceAlbedo }, rw, rh);
    if (lightAdd && lighting?.mode === "debug") {
      this.#ensureDebugPipeline();
      const pipeline = this.#debugPipeline!;
      const layout = this.#debugLayout!;
      const sampler = this.#debugSampler!;
      const device = this.#ctx.device;
      graph.addPass({
        name: "light-add-debug-blit",
        reads: [lightAdd],
        writes: [out],
        execute(ctx): void {
          const bg = device.createBindGroup({
            layout,
            entries: [
              { binding: 0, resource: ctx.texture(lightAdd).createView() },
              { binding: 1, resource: sampler },
            ],
          });
          const pass = ctx.encoder.beginRenderPass({
            label: "light-add-debug-blit",
            colorAttachments: [
              { view: ctx.texture(out).createView(), loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: "store" },
            ],
          });
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, bg);
          pass.draw(3);
          pass.end();
        },
      });
      graph.execute();
      timer.afterSubmit();
      return;
    }

    // Milestone 6 (B3) Step 6: bilateral-upsample lightAdd onto colorUnlit into a new full-res texture,
    // which then replaces the normal per-sample-lit hdr as the scene color for TAAU/the post stack.
    let sceneSource = hdr;
    if (lightAdd && lighting?.mode === "composite") {
      this.#ensureCompositePipeline();
      const pipeline = this.#compositePipeline!;
      const layout = this.#compositeLayout!;
      const sampler = this.#compositeSampler!;
      const paramsBuf = this.#compositeParams!;
      const device = this.#ctx.device;
      // lightAdd is half the volume pass's resolution (LightingPass.resolve rounds fullWidth/2), not rw/rh.
      const hw = Math.max(1, Math.round(rw / 2));
      const hh = Math.max(1, Math.round(rh / 2));
      paramsBuf.write(new Float32Array([lighting.sigmaDepth ?? 0.02, lighting.sigmaNormal ?? 0.35, hw, hh]));
      const hdrLit = graph.createTexture({ size: [rw, rh, 1], format: HDR_FORMAT, usage: HDR_USAGE });
      graph.addPass({
        name: "lighting-composite",
        reads: [colorUnlit, depth, surfaceNormal, lightAdd],
        writes: [hdrLit],
        execute(ctx): void {
          const bg = device.createBindGroup({
            layout,
            entries: [
              { binding: 0, resource: ctx.texture(colorUnlit).createView() },
              { binding: 1, resource: ctx.texture(depth).createView() },
              { binding: 2, resource: ctx.texture(surfaceNormal).createView() },
              { binding: 3, resource: ctx.texture(lightAdd).createView() },
              { binding: 4, resource: sampler },
              { binding: 5, resource: { buffer: paramsBuf.gpu } },
            ],
          });
          const pass = ctx.encoder.beginRenderPass({
            label: "lighting-composite",
            colorAttachments: [
              { view: ctx.texture(hdrLit).createView(), loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" },
            ],
          });
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, bg);
          pass.draw(3);
          pass.end();
        },
      });
      sceneSource = hdrLit;
    }

    // Milestone 5: temporally accumulate the jittered volume frame into persistent history before the
    // post stack, reprojecting the previous frame via the per-pixel depth. Disabled → raw frame to post.
    const sceneColor = taau && taau.enabled ? taau.resolve(graph, sceneSource, depth, rw, rh) : sceneSource;

    this.#stack.build(graph, sceneColor, { size: [rw, rh, 1], format: HDR_FORMAT, output: out });
    graph.execute();
    timer.afterSubmit();
  }

  #ensureDebugPipeline(): void {
    if (this.#debugPipeline) return;
    this.#debugLayout = this.#ctx.device.createBindGroupLayout({
      label: "light-add-debug-blit",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      ],
    });
    this.#debugSampler = this.#ctx.device.createSampler({ magFilter: "linear", minFilter: "linear" });
    const mod = this.#debugCache.getModule("light-add-debug-blit", DEBUG_BLIT_WGSL);
    this.#debugPipeline = this.#debugCache.getRenderPipeline({
      label: "light-add-debug-blit",
      layout: this.#ctx.device.createPipelineLayout({ bindGroupLayouts: [this.#debugLayout] }),
      vertex: { module: mod, entryPoint: "vs_main" },
      fragment: { module: mod, entryPoint: "fs_main", targets: [{ format: this.#ctx.format }] },
      primitive: { topology: "triangle-list" },
    });
  }

  #ensureCompositePipeline(): void {
    if (this.#compositePipeline) return;
    this.#compositeLayout = this.#ctx.device.createBindGroupLayout({
      label: "lighting-composite",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    });
    this.#compositeSampler = this.#ctx.device.createSampler({ magFilter: "linear", minFilter: "linear" });
    this.#compositeParams = new ManagedBuffer(this.#ctx.device, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, 16);
    const mod = this.#compositeCache.getModule("lighting-composite", LIGHTING_COMPOSITE_WGSL);
    this.#compositePipeline = this.#compositeCache.getRenderPipeline({
      label: "lighting-composite",
      layout: this.#ctx.device.createPipelineLayout({ bindGroupLayouts: [this.#compositeLayout] }),
      vertex: { module: mod, entryPoint: "vs_main" },
      fragment: { module: mod, entryPoint: "fs_main", targets: [{ format: HDR_FORMAT }] },
      primitive: { topology: "triangle-list" },
    });
  }

  /** Release the post stack's cached passes and the graph's pooled textures. */
  public dispose(): void {
    this.#stack.dispose();
    this.#graph.dispose();
    this.#timer.dispose();
    this.#compositeParams?.dispose();
  }
}
