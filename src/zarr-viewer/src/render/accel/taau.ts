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
struct Params { weight: f32 }
@group(0) @binding(0) var curTex: texture_2d<f32>;
@group(0) @binding(1) var histTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> params: Params;

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
  let uv = vec2<f32>(in.uv.x, 1.0 - in.uv.y);
  let cur = textureSampleLevel(curTex, samp, uv, 0.0);
  let hist = textureSampleLevel(histTex, samp, uv, 0.0);
  // weight = 1/(n+1): a running average up to the cap, then an exponential tail. weight == 1 on the
  // reset frame ⇒ output is the live frame and history is (re)seeded, so stale history never leaks in.
  return mix(hist, cur, clamp(params.weight, 0.0, 1.0));
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

  /** Cap on the running average before it becomes exponential (keeps responding to subtle changes). */
  public maxAccum = 64;

  public constructor(private readonly device: GPUDevice) {
    this.#cache = new PipelineCache(device);
    this.#params = new ManagedBuffer(device, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, 16);
    this.#sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
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
  public resolve(graph: RenderGraph, current: ResourceHandle, w: number, h: number): ResourceHandle {
    this.#ensureTextures(w, h);
    this.#ensurePipeline();
    const prev = this.#readA ? this.#historyA! : this.#historyB!;
    const next = this.#readA ? this.#historyB! : this.#historyA!;
    const weight = 1 / (this.#n + 1);
    this.#params.write(new Float32Array([weight, 0, 0, 0]));

    const curH = current;
    const prevH = graph.importTexture(prev, "taau-hist-prev", HDR_FORMAT);
    const nextH = graph.importTexture(next, "taau-hist-next", HDR_FORMAT);
    const device = this.device;
    const pipeline = this.#pipeline!;
    const layout = this.#layout!;
    const sampler = this.#sampler;
    const paramsBuf = this.#params.gpu;
    graph.addPass({
      name: "taau-accumulate",
      reads: [curH, prevH],
      writes: [nextH],
      execute(ctx): void {
        const bg = device.createBindGroup({
          layout,
          entries: [
            { binding: 0, resource: ctx.texture(curH).createView() },
            { binding: 1, resource: ctx.texture(prevH).createView() },
            { binding: 2, resource: sampler },
            { binding: 3, resource: { buffer: paramsBuf } },
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
