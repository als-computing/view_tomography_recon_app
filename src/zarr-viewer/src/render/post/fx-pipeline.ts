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

  public constructor(ctx: GpuContext) {
    this.#ctx = ctx;
    this.#graph = new RenderGraph(ctx.device);
    this.#stack = new PostStack([]);
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
   * Render one frame: draw the volume into a linear-HDR transient (via `recordVolume`, which should
   * call `VolumeRenderer.recordInto` on the passed render pass), then run the post stack to the
   * swapchain.
   */
  public render(
    clearValue: GPUColor,
    recordVolume: (pass: GPURenderPassEncoder) => void,
  ): void {
    const { canvasContext, canvas, format } = this.#ctx;
    const w = Math.max(1, canvas.width);
    const h = Math.max(1, canvas.height);
    // Internal render size (volume + post chain). The final post pass upscales to the full swapchain.
    const rw = Math.max(1, Math.round(w * this.#renderScale));
    const rh = Math.max(1, Math.round(h * this.#renderScale));
    const graph = this.#graph.reset();

    const hdr = graph.createTexture({ size: [rw, rh, 1], format: HDR_FORMAT, usage: HDR_USAGE });
    graph.addPass({
      name: "volume",
      writes: [hdr],
      execute(ctx): void {
        const pass = ctx.encoder.beginRenderPass({
          label: "volume-raymarch",
          colorAttachments: [
            {
              view: ctx.texture(hdr).createView(),
              clearValue,
              loadOp: "clear",
              storeOp: "store",
            },
          ],
        });
        recordVolume(pass);
        pass.end();
      },
    });

    const out = graph.importTexture(canvasContext.getCurrentTexture(), "swap", format);
    this.#stack.build(graph, hdr, { size: [rw, rh, 1], format: HDR_FORMAT, output: out });
    graph.execute();
  }

  /** Release the post stack's cached passes and the graph's pooled textures. */
  public dispose(): void {
    this.#stack.dispose();
    this.#graph.dispose();
  }
}
