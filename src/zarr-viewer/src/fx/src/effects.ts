/**
 * Built-in post-processing effects. Each factory returns an {@link Effect} for the {@link PostStack}.
 *
 * `tonemap`, `fxaa`, and `bloom` are implemented; `taa`, `ssao`, `depthOfField`, and `outline` need
 * history/depth/normal inputs the graph does not yet route and remain honest stubs. The GPU passes
 * are validated in the browser playground; the tone-map math ({@link "./tonemap-ops"}) and the stack
 * wiring are unit-tested headlessly.
 *
 * @packageDocumentation
 */

import { NotImplementedError } from "@zarr-viewer/core";
import type { RenderGraph, ResourceHandle } from "@zarr-viewer/render";
import type { Effect, PostStackTarget } from "./stack.js";
import { FullscreenPass } from "./fullscreen.js";
import { TONEMAP_WGSL, type ToneMapOperator } from "./tonemap-ops.js";

const OP_INDEX: Record<ToneMapOperator, number> = { aces: 0, reinhard: 1, "reinhard-extended": 2 };

/**
 * HDR→LDR tone mapping with exposure. Replaces the ACES curve that was previously duplicated inline
 * across the forward/gem/volume shaders with a single shared operator.
 */
export function tonemap(
  operator: ToneMapOperator = "aces",
  options: { exposureStops?: number; whitePoint?: number } = {},
): Effect {
  const exposure = options.exposureStops ?? 0;
  const white = options.whitePoint ?? 4;
  let pass: FullscreenPass | undefined;
  return {
    name: "tonemap",
    addPass(graph: RenderGraph, input: ResourceHandle, output: ResourceHandle): void {
      graph.addPass({
        name: "tonemap",
        reads: [input],
        writes: [output],
        execute(ctx): void {
          pass ??= new FullscreenPass(graph.device, {
            label: "fx.tonemap",
            paramsStruct: "exposure: f32, op: f32, white: f32, _pad: f32,",
            extra: TONEMAP_WGSL,
            fragment: `
  let hdr = textureSample(tex, samp, uv).rgb;
  let exposed = hdr * exp2(params.exposure);
  var mapped: vec3f;
  if (params.op < 0.5) { mapped = tm_aces(exposed); }
  else if (params.op < 1.5) { mapped = tm_reinhard(exposed); }
  else { mapped = tm_reinhard_extended(exposed, params.white); }
  return vec4f(tm_linear_to_srgb(mapped), 1.0);`,
          });
          pass.setParams(new Float32Array([exposure, OP_INDEX[operator], white, 0]));
          pass.run(
            ctx.encoder,
            ctx.texture(input).createView(),
            ctx.texture(output).createView(),
            ctx.format(output),
          );
        },
      });
    },
    dispose(): void {
      pass?.dispose();
      pass = undefined;
    },
  };
}

/** Fast approximate anti-aliasing (luma-based edge blend). A cheap alternative to MSAA/TAA. */
export function fxaa(): Effect {
  let pass: FullscreenPass | undefined;
  return {
    name: "fxaa",
    addPass(graph: RenderGraph, input: ResourceHandle, output: ResourceHandle): void {
      graph.addPass({
        name: "fxaa",
        reads: [input],
        writes: [output],
        execute(ctx): void {
          pass ??= new FullscreenPass(graph.device, {
            label: "fx.fxaa",
            paramsStruct: "invRes: vec2f, _pad: vec2f,",
            extra: `fn lum(c: vec3f) -> f32 { return dot(c, vec3f(0.299, 0.587, 0.114)); }`,
            fragment: `
  let inv = params.invRes;
  let rgbM = textureSample(tex, samp, uv).rgb;
  let lM = lum(rgbM);
  let lNW = lum(textureSample(tex, samp, uv + vec2f(-inv.x, -inv.y)).rgb);
  let lNE = lum(textureSample(tex, samp, uv + vec2f( inv.x, -inv.y)).rgb);
  let lSW = lum(textureSample(tex, samp, uv + vec2f(-inv.x,  inv.y)).rgb);
  let lSE = lum(textureSample(tex, samp, uv + vec2f( inv.x,  inv.y)).rgb);
  let lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  let lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  var dir = vec2f(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
  let reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
  let rcpDir = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcpDir, vec2f(-8.0), vec2f(8.0)) * inv;
  let rgbA = 0.5 * (textureSample(tex, samp, uv + dir * (1.0 / 3.0 - 0.5)).rgb
                  + textureSample(tex, samp, uv + dir * (2.0 / 3.0 - 0.5)).rgb);
  let rgbB = rgbA * 0.5 + 0.25 * (textureSample(tex, samp, uv - dir * 0.5).rgb
                                + textureSample(tex, samp, uv + dir * 0.5).rgb);
  let lB = lum(rgbB);
  let result = select(rgbA, rgbB, lB >= lMin && lB <= lMax);
  return vec4f(result, 1.0);`,
          });
          const tex = ctx.texture(input);
          pass.setParams(new Float32Array([1 / tex.width, 1 / tex.height, 0, 0]));
          pass.run(
            ctx.encoder,
            tex.createView(),
            ctx.texture(output).createView(),
            ctx.format(output),
          );
        },
      });
    },
    dispose(): void {
      pass?.dispose();
      pass = undefined;
    },
  };
}

/**
 * Bloom: extract highlights above `threshold`, blur them (separable Gaussian at half resolution),
 * and add back at `intensity` for a physically-plausible glow around bright emitters.
 */
export function bloom(options: { threshold?: number; intensity?: number } = {}): Effect {
  const threshold = options.threshold ?? 1;
  const intensity = options.intensity ?? 0.6;
  let extract: FullscreenPass | undefined;
  let blur: FullscreenPass | undefined;
  let composite: FullscreenPass | undefined;
  return {
    name: "bloom",
    addPass(
      graph: RenderGraph,
      input: ResourceHandle,
      output: ResourceHandle,
      target: PostStackTarget,
    ): void {
      const half: readonly [number, number, number] = [
        Math.max(1, target.size[0] >> 1),
        Math.max(1, target.size[1] >> 1),
        1,
      ];
      const usage = 0x10 | 0x04; // RENDER_ATTACHMENT | TEXTURE_BINDING
      // Distinct textures per pass (single-assignment) so the graph orders/aliases them correctly;
      // ping-ponging into one handle would create a write-after-write cycle.
      const bright = graph.createTexture({ size: half, format: target.format, usage });
      const ping = graph.createTexture({ size: half, format: target.format, usage });
      const blurred = graph.createTexture({ size: half, format: target.format, usage });

      // 1) Bright-pass extraction (downsampled).
      graph.addPass({
        name: "bloom.extract",
        reads: [input],
        writes: [bright],
        execute(ctx): void {
          extract ??= new FullscreenPass(graph.device, {
            label: "fx.bloom.extract",
            // 4 scalars = 16 bytes; `vec3f` would force 16-byte alignment → a 32-byte struct that
            // mismatches the 16-byte uniform buffer and fails bind-group validation.
            paramsStruct: "threshold: f32, pad0: f32, pad1: f32, pad2: f32,",
            fragment: `
  let c = textureSample(tex, samp, uv).rgb;
  let l = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  let contrib = max(l - params.threshold, 0.0) / max(l, 1e-4);
  return vec4f(c * contrib, 1.0);`,
          });
          extract.setParams(new Float32Array([threshold, 0, 0, 0]));
          extract.run(
            ctx.encoder,
            ctx.texture(input).createView(),
            ctx.texture(bright).createView(),
            ctx.format(bright),
          );
        },
      });

      // 2) Separable Gaussian blur: bright → ping (horizontal) → bright (vertical).
      const blurStep = (
        from: ResourceHandle,
        to: ResourceHandle,
        dir: readonly [number, number],
      ): void => {
        graph.addPass({
          name: "bloom.blur",
          reads: [from],
          writes: [to],
          execute(ctx): void {
            blur ??= new FullscreenPass(graph.device, {
              label: "fx.bloom.blur",
              paramsStruct: "dir: vec2f, _pad: vec2f,",
              fragment: `
  var w = array<f32, 5>(0.227027, 0.194595, 0.121622, 0.054054, 0.016216);
  var acc = textureSample(tex, samp, uv).rgb * w[0];
  for (var i = 1; i < 5; i++) {
    let o = params.dir * f32(i);
    acc += textureSample(tex, samp, uv + o).rgb * w[i];
    acc += textureSample(tex, samp, uv - o).rgb * w[i];
  }
  return vec4f(acc, 1.0);`,
            });
            const t = ctx.texture(from);
            blur.setParams(new Float32Array([dir[0] / t.width, dir[1] / t.height, 0, 0]));
            blur.run(ctx.encoder, t.createView(), ctx.texture(to).createView(), ctx.format(to));
          },
        });
      };
      blurStep(bright, ping, [1, 0]); // horizontal
      blurStep(ping, blurred, [0, 1]); // vertical

      // 3) Composite the blurred highlights back onto the original.
      graph.addPass({
        name: "bloom.composite",
        reads: [input, blurred],
        writes: [output],
        execute(ctx): void {
          composite ??= new FullscreenPass(graph.device, {
            label: "fx.bloom.composite",
            paramsStruct: "intensity: f32, pad0: f32, pad1: f32, pad2: f32,",
            extra: `@group(0) @binding(3) var bloomTex: texture_2d<f32>;`,
            fragment: `
  let base = textureSample(tex, samp, uv).rgb;
  let glow = textureSample(bloomTex, samp, uv).rgb;
  return vec4f(base + glow * params.intensity, 1.0);`,
          });
          composite.setParams(new Float32Array([intensity, 0, 0, 0]));
          composite.runWithExtra(
            ctx.encoder,
            ctx.texture(input).createView(),
            ctx.texture(output).createView(),
            ctx.format(output),
            [{ binding: 3, resource: ctx.texture(blurred).createView() }],
          );
        },
      });
    },
    dispose(): void {
      extract?.dispose();
      blur?.dispose();
      composite?.dispose();
      extract = undefined;
      blur = undefined;
      composite = undefined;
    },
  };
}

/**
 * Vignette: gently darken toward the frame edges to focus the eye on the center. A single
 * full-screen pass with no extra inputs; runs after tone mapping on the LDR image.
 */
export function vignette(options: { amount?: number; radius?: number } = {}): Effect {
  const amount = options.amount ?? 0.4;
  const radius = options.radius ?? 0.85;
  let pass: FullscreenPass | undefined;
  return {
    name: "vignette",
    addPass(graph: RenderGraph, input: ResourceHandle, output: ResourceHandle): void {
      graph.addPass({
        name: "vignette",
        reads: [input],
        writes: [output],
        execute(ctx): void {
          pass ??= new FullscreenPass(graph.device, {
            label: "fx.vignette",
            paramsStruct: "amount: f32, radius: f32, pad0: f32, pad1: f32,",
            fragment: `
  let c = textureSample(tex, samp, uv).rgb;
  // Normalized radial distance from center: 0 at center, ~1 at the corners.
  let d = distance(uv, vec2f(0.5, 0.5)) * 1.4142135;
  let t = smoothstep(params.radius * 0.5, params.radius, d);
  let factor = mix(1.0, 1.0 - params.amount, t);
  return vec4f(c * factor, 1.0);`,
          });
          pass.setParams(new Float32Array([amount, radius, 0, 0]));
          pass.run(
            ctx.encoder,
            ctx.texture(input).createView(),
            ctx.texture(output).createView(),
            ctx.format(output),
          );
        },
      });
    },
    dispose(): void {
      pass?.dispose();
      pass = undefined;
    },
  };
}

/**
 * Sharpen: a 4-tap unsharp mask that boosts local contrast. A single full-screen pass; runs on the
 * LDR image (typically last, after anti-aliasing).
 */
export function sharpen(options: { amount?: number } = {}): Effect {
  const amount = options.amount ?? 0.5;
  let pass: FullscreenPass | undefined;
  return {
    name: "sharpen",
    addPass(graph: RenderGraph, input: ResourceHandle, output: ResourceHandle): void {
      graph.addPass({
        name: "sharpen",
        reads: [input],
        writes: [output],
        execute(ctx): void {
          pass ??= new FullscreenPass(graph.device, {
            label: "fx.sharpen",
            paramsStruct: "invRes: vec2f, amount: f32, _pad: f32,",
            fragment: `
  let inv = params.invRes;
  let c = textureSample(tex, samp, uv).rgb;
  let n = textureSample(tex, samp, uv + vec2f(0.0, -inv.y)).rgb
        + textureSample(tex, samp, uv + vec2f(0.0,  inv.y)).rgb
        + textureSample(tex, samp, uv + vec2f(-inv.x, 0.0)).rgb
        + textureSample(tex, samp, uv + vec2f( inv.x, 0.0)).rgb;
  let sharp = c + (c * 4.0 - n) * params.amount;
  return vec4f(max(sharp, vec3f(0.0)), 1.0);`,
          });
          const tex = ctx.texture(input);
          pass.setParams(new Float32Array([1 / tex.width, 1 / tex.height, amount, 0]));
          pass.run(
            ctx.encoder,
            tex.createView(),
            ctx.texture(output).createView(),
            ctx.format(output),
          );
        },
      });
    },
    dispose(): void {
      pass?.dispose();
      pass = undefined;
    },
  };
}

/** Temporal anti-aliasing (reprojection + history blend). */
export function taa(): Effect {
  throw new NotImplementedError("taa");
}

/** Screen-space ambient occlusion. */
export function ssao(_options?: { radius?: number; intensity?: number }): Effect {
  throw new NotImplementedError("ssao");
}

/** Depth of field (bokeh) based on a lens focus distance. */
export function depthOfField(_options?: { focusDistance?: number; aperture?: number }): Effect {
  throw new NotImplementedError("depthOfField");
}

/** Feature outline pass (useful for highlighting selected scientific structures). */
export function outline(_options?: { color?: readonly [number, number, number] }): Effect {
  throw new NotImplementedError("outline");
}
