/**
 * WebGPU volume rendering for the standalone OME-Zarr viewer.
 *
 * @packageDocumentation
 */

export { createContext } from "./device/context.js";
export type { DeviceOptions, GpuContext } from "./device/context.js";

export { uploadVolume, chooseVolumeFormat, volumeFormatBytes } from "./volume/volume-texture.js";
export type { UploadVolumeOptions, VolumeTextureFormat } from "./volume/volume-texture.js";
export { VolumeLoader } from "./volume/volume-loader.js";
export type { VolumeLevelResult, VolumeLoaderOptions } from "./volume/volume-loader.js";
export { BrickLoader, chooseBrickRegion } from "./volume/brick-loader.js";
export type { BrickResult, BrickRequest, BrickLoaderOptions } from "./volume/brick-loader.js";

export { VolumeRenderer } from "./volume/volume-renderer.js";
export type { VolumeRendererOptions, VolumeBlendMode, VolumeViewMode } from "./volume/volume-renderer.js";
export type {
  LiquidShadingParams,
  MeasurePlaneParams,
  LegacyLightParams,
} from "./volume/volume-shading-params.js";
export type { VolumeLightingParams } from "./volume/volume-lighting.js";

export {
  specializationFor,
  approximateShadingActive,
  approximateShadingLabel,
} from "./accel/shader-config.js";
export type { ShaderConfigName, ShaderSpecialization, ShadowRepresentation } from "./accel/shader-config.js";
export { GpuTimer } from "./accel/gpu-timer.js";
export type { GpuTimerSample } from "./accel/gpu-timer.js";
export {
  stampPngProvenance,
  readPngProvenance,
  stampCanvasPng,
  hashTransferFunction,
  formatProvenance,
} from "./accel/provenance.js";
export type { RenderProvenance } from "./accel/provenance.js";
export {
  VIS_WEIGHT_SCALE,
  visBinIndex,
  visBinUvwBox,
  visPriority,
  requiredLevelFromDistance,
  rankVisibilityBins,
  quantizeVisWeight,
  dequantizeVisWeight,
  VisibilityFeedback,
} from "./accel/visibility.js";
export type { VisibilityBin } from "./accel/visibility.js";
export {
  MACROCELL_VOXELS,
  tfActivePrefix,
  tfRangeActive,
  chebyshevDistanceField,
  majorantStepCap,
  OccupancyGrid,
} from "./accel/occupancy.js";
export { dilateTileFlags, TILE_SIZE, TileCompactor } from "./accel/tiles.js";
export { meanFlip, solidRgba, syntheticVolume32, FLIP_PPD } from "./accel/flip.js";
export type { FlipResult } from "./accel/flip.js";
export { FLIP_CONFIGS, flipConfigToLut } from "./accel/flip-configs.js";
export type { FlipConfig } from "./accel/flip-configs.js";

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

export { RenderGraph } from "./graph/render-graph.js";
export type {
  ResourceHandle,
  RenderGraphTextureDesc,
  PassContext,
  PassDesc,
  CompiledGraph,
} from "./graph/render-graph.js";

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
  keyDirectionalFromLights,
  packLightsStd430,
  lightBufferByteSize,
  LightingEnvironment,
  BRDF_WGSL,
  LIGHT_STRUCT_WGSL,
  LIGHT_EVAL_WGSL,
  LIGHTS_WGSL,
} from "./lighting/index.js";
export type { GpuLight, GpuLightKindCode } from "./lighting/index.js";
