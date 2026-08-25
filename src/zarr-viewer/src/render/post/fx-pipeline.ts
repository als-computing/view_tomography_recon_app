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
import { RenderGraph } from "../graph/render-graph.js";
import { PostStack, type Effect } from "@prism/fx";
import { GpuTimer } from "../accel/gpu-timer.js";
import type { TemporalAccumulator } from "../accel/taau.js";
import { VOLUME_DEPTH_FORMAT } from "../volume/volume-renderer.js";

/** RENDER_ATTACHMENT | TEXTURE_BINDING — the HDR target must be both drawn to and sampled. */
const HDR_USAGE = 0x10 | 0x04;
const HDR_FORMAT: GPUTextureFormat = "rgba16float";

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
    graph.addPass({
      name: "volume",
      writes: [hdr, depth],
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
          ],
          timestampWrites: timer.timestampWrites("volume"),
        });
        recordVolume(pass);
        pass.end();
        timer.resolve(ctx.encoder);
      },
    });

    // Milestone 5: temporally accumulate the jittered volume frame into persistent history before the
    // post stack, reprojecting the previous frame via the per-pixel depth. Disabled → raw frame to post.
    const sceneColor = taau && taau.enabled ? taau.resolve(graph, hdr, depth, rw, rh) : hdr;

    const out = graph.importTexture(canvasContext.getCurrentTexture(), "swap", format);
    this.#stack.build(graph, sceneColor, { size: [rw, rh, 1], format: HDR_FORMAT, output: out });
    graph.execute();
    timer.afterSubmit();
  }

  /** Release the post stack's cached passes and the graph's pooled textures. */
  public dispose(): void {
    this.#stack.dispose();
    this.#graph.dispose();
    this.#timer.dispose();
  }
}
