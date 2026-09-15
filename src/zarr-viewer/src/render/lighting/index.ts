/**
 * Unified lighting library: GPU light list + shared WGSL + {@link LightingEnvironment}. Copied from
 * prism's `@zarr-viewer/render` lighting submodule; the scene-extraction path is omitted (this viewer
 * builds its light set procedurally from the camera).
 *
 * @packageDocumentation
 */

export {
  MAX_LIGHTS,
  GPU_LIGHT_STRIDE_BYTES,
  GpuLightKind,
  DEFAULT_POINT_RANGE,
  DEFAULT_SPOT_INNER,
  DEFAULT_SPOT_OUTER,
  makeDirectionalLight,
  makePointLight,
  makeSpotLight,
  makeRectLight,
  distanceAttenuation,
  spotAttenuation,
} from "./types.js";
export type { GpuLight, GpuLightKindCode } from "./types.js";

export { keyDirectionalFromLights } from "./extract.js";

export {
  packLightsStd430,
  lightBufferByteSize,
  LightingEnvironment,
} from "./light-buffer.js";

export {
  BRDF_WGSL,
  LIGHT_STRUCT_WGSL,
  LIGHT_EVAL_WGSL,
  LIGHTS_WGSL,
} from "../shaders/lights.js";
