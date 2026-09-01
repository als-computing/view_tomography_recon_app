/**
 * Volume / OME-Zarr I/O for the standalone viewer.
 *
 * @packageDocumentation
 */

export { dtypeByteSize } from "./volume/volume-source.js";
export type { VolumeSource, VolumeChunk, VolumeDType } from "./volume/volume-source.js";

export {
  physicalSizeQuantities,
  physicalSizeSim,
  volumeMaxExtentMeters,
  listUploadableLevels,
  finestTargetLevel,
} from "./volume/volume-geom.js";
export type { UploadableLevelOptions } from "./volume/volume-geom.js";

export {
  pickConnectedFeature,
  loadDensityField,
  measureThresholdVolume,
  extractIsosurface,
} from "./volume/analysis.js";
export type {
  DensityField,
  PickedFeature,
  LoadDensityFieldOptions,
  MeasureThresholdOptions,
  ThresholdVolumeResult,
  ExtractIsosurfaceOptions,
} from "./volume/analysis.js";

export type { Codec, BloscCompressorConfig } from "./volume/zarr/codecs.js";
export { httpStore, memoryStore, fileSystemStore, normalizeStoreKey } from "./volume/zarr/store.js";
export type { Store } from "./volume/zarr/store.js";
export { readArrayMeta, readGroupAttrs, parseNumpyDtype } from "./volume/zarr/metadata.js";
export type { ZarrArrayMeta, ParsedDType, ZarrCompressor } from "./volume/zarr/metadata.js";
export { openZarrArray, estimateValueRange } from "./volume/zarr/array.js";
export type { OpenZarrArrayOptions } from "./volume/zarr/array.js";
export { openOmeZarr } from "./volume/ome-zarr.js";
export type { OpenOmeZarrOptions } from "./volume/ome-zarr.js";
