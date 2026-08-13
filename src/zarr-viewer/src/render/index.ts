/**
 * WebGPU volume rendering for the standalone OME-Zarr viewer.
 *
 * @packageDocumentation
 */

export { createContext } from "./device/context.js";
export type { DeviceOptions, GpuContext } from "./device/context.js";

export { uploadVolume } from "./volume/volume-texture.js";
export type { UploadVolumeOptions } from "./volume/volume-texture.js";

export { VolumeRenderer } from "./volume/volume-renderer.js";
export type {
  VolumeRendererOptions,
  VolumeBlendMode,
  VolumeViewMode,
  LiquidShadingParams,
} from "./volume/volume-renderer.js";

export { TransferFunction } from "./volume/transfer-function.js";
export type { TransferStop } from "./volume/transfer-function.js";

export {
  composeTransferFunction,
  sampleOpacity,
  DEFAULT_OPACITY_POINTS,
} from "./volume/opacity-curve.js";
export type { OpacityPoint, ComposeTransferFunctionOptions } from "./volume/opacity-curve.js";

export { OpacityCurveEditor } from "./volume/opacity-curve-editor.js";
export type { OpacityCurveEditorOptions } from "./volume/opacity-curve-editor.js";

export { sampleColorMap, colorMapNames } from "./volume/colormaps.js";
export type { ColorMapName } from "./volume/colormaps.js";
