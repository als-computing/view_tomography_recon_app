/**
 * `@prism/fx` — post-processing effects and the stack that composes them into the render graph.
 *
 * @packageDocumentation
 */

export { PostStack } from "./stack.js";
export type { Effect, PostStackTarget } from "./stack.js";
export {
  bloom,
  tonemap,
  fxaa,
  vignette,
  sharpen,
  taa,
  ssao,
  depthOfField,
  outline,
} from "./effects.js";
export { FullscreenPass } from "./fullscreen.js";
export type { FullscreenPassConfig } from "./fullscreen.js";
export {
  luminance,
  applyExposure,
  reinhard,
  reinhardExtended,
  acesFilmic,
  linearToSrgb,
  srgbToLinear,
  TONEMAP_WGSL,
} from "./tonemap-ops.js";
export type { ToneMapOperator } from "./tonemap-ops.js";
