/**
 * A post-processing stack: an ordered chain of full-screen effects plugged into the render graph,
 * consuming an HDR color target and producing the final image. Each effect reads the previous
 * effect's output and writes a fresh transient target; the graph then aliases those transients and
 * culls any effect whose result is unused.
 *
 * @packageDocumentation
 */

import type { RenderGraph, ResourceHandle } from "@zarr-viewer/render";

/** A single post-processing effect. */
export interface Effect {
  readonly name: string;
  /**
   * Add this effect's pass(es) to the graph, reading `input` and writing `output`. `target` describes
   * the chain's working size/format so multi-pass effects (e.g. bloom) can size their own
   * intermediate resources.
   */
  addPass(
    graph: RenderGraph,
    input: ResourceHandle,
    output: ResourceHandle,
    target: PostStackTarget,
  ): void;
  /**
   * Release any GPU resources cached across frames (e.g. the effect's {@link FullscreenPass}
   * pipelines/uniforms). Called when the {@link PostStack} is rebuilt or disposed. Optional so
   * effects that cache nothing need not implement it.
   */
  dispose?(): void;
}

/** Where a {@link PostStack} allocates its intermediate targets and (optionally) its final output. */
export interface PostStackTarget {
  /** Size of the intermediate ping-pong targets `[w, h, 1]`. */
  size: readonly [number, number, number];
  /** Format of the intermediate targets (e.g. `"rgba16float"` to keep HDR through the chain). */
  format: GPUTextureFormat;
  /**
   * Optional final destination (e.g. an imported swapchain texture). When given, the last effect
   * writes here instead of a transient, so the chain ends in the presentable image.
   */
  output?: ResourceHandle;
}

// RENDER_ATTACHMENT | TEXTURE_BINDING — literals so the class is usable in headless tests where the
// `GPUTextureUsage` global is absent.
const POST_USAGE = 0x10 | 0x04;

/**
 * An ordered post-processing chain.
 *
 * @example
 * ```ts
 * const stack = new PostStack([bloom(), tonemap("aces")]);
 * const final = stack.build(graph, hdrColor, { size: [w, h, 1], format: "rgba16float", output: swap });
 * ```
 */
export class PostStack {
  public constructor(public readonly effects: readonly Effect[]) {}

  /**
   * Chain all effects, ping-ponging transient targets, and return the handle of the final image. If
   * the stack is empty, returns `target.output ?? hdrColor` unchanged.
   */
  public build(
    graph: RenderGraph,
    hdrColor: ResourceHandle,
    target: PostStackTarget,
  ): ResourceHandle {
    if (this.effects.length === 0) return target.output ?? hdrColor;
    let input = hdrColor;
    for (let i = 0; i < this.effects.length; i++) {
      const isLast = i === this.effects.length - 1;
      const output =
        isLast && target.output !== undefined
          ? target.output
          : graph.createTexture({ size: target.size, format: target.format, usage: POST_USAGE });
      this.effects[i]!.addPass(graph, input, output, target);
      input = output;
    }
    return input;
  }

  /**
   * Release every effect's cached GPU resources. Call before discarding a stack (e.g. when the FX
   * UI toggles an effect and a fresh `PostStack` replaces this one), otherwise the cached
   * {@link FullscreenPass} pipelines accumulate on the device.
   */
  public dispose(): void {
    for (const effect of this.effects) effect.dispose?.();
  }
}
