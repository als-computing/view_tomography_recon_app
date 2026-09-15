/**
 * The `VolumeSource` abstraction: a uniform, chunked, possibly-multiscale view over 3D scalar data,
 * regardless of on-disk format (Zarr, OME-Zarr, TIFF stacks, raw). The renderer uploads chunks to a
 * 3D texture; physics can sample it as an attenuation/density field.
 *
 * Voxel {@link VolumeSource.spacing} is always in **SI meters**.
 *
 * @packageDocumentation
 */

import { NotImplementedError } from "@zarr-viewer/core";

/** Supported voxel scalar types. */
export type VolumeDType =
  | "uint8"
  | "int8"
  | "uint16"
  | "int16"
  | "uint32"
  | "int32"
  | "float32"
  | "float64";

/** A decoded chunk of voxels plus its origin within the volume. */
export interface VolumeChunk {
  /** Chunk origin in voxels (x, y, z). */
  origin: readonly [number, number, number];
  /** Chunk shape in voxels (x, y, z). */
  shape: readonly [number, number, number];
  /** Row-major voxel data of length `shape.x * shape.y * shape.z` (x fastest). */
  data: ArrayBufferView;
}

/**
 * A format-agnostic 3D volume. Implementations stream chunks lazily so multi-gigabyte tomography
 * datasets never need to be fully resident.
 *
 * @example
 * ```ts
 * const src: VolumeSource = await openOmeZarr(store);
 * for await (const chunk of src.chunks(src.levelCount - 1)) uploadToTexture(chunk);
 * ```
 */
export interface VolumeSource {
  /** Volume dimensions in voxels at level 0 (x, y, z). */
  readonly dimensions: readonly [number, number, number];
  /** Physical voxel spacing at level 0 (x, y, z) in **meters**. */
  readonly spacing: readonly [number, number, number];
  /** Scalar data type. */
  readonly dtype: VolumeDType;
  /** Observed or declared `[min, max]` value range (for transfer-function scaling). */
  readonly valueRange: readonly [number, number];
  /** Number of resolution levels (1 if not multiscale). */
  readonly levelCount: number;
  /** Optional display name of the spacing unit from metadata (e.g. `"micrometer"`). */
  readonly spacingUnitName?: string;

  /** Dimensions at a resolution `level` (x, y, z). */
  dimensionsAt(level: number): readonly [number, number, number];

  /** Voxel spacing at a resolution `level` in meters (x, y, z). */
  spacingAt(level: number): readonly [number, number, number];

  /** Read a single chunk containing voxel `(x, y, z)` at a resolution `level`. */
  readChunk(level: number, x: number, y: number, z: number): Promise<VolumeChunk>;

  /** Async-iterate all chunks at a resolution `level`. */
  chunks(level: number): AsyncIterable<VolumeChunk>;

  /**
   * Async-iterate only the chunks overlapping the half-open voxel box `[voxelMin, voxelMax)` at a
   * resolution `level` — the ROI read for high-res brick streaming. Only the intersecting chunks are
   * fetched (unlike {@link chunks}, which reads the whole level). Pass a `signal` to cancel in-flight
   * fetches when the region is superseded. Yielded chunks carry their true full-chunk `origin`/`shape`
   * (the caller clips/offsets into its ROI texture).
   */
  readRegion(
    level: number,
    voxelMin: readonly [number, number, number],
    voxelMax: readonly [number, number, number],
    signal?: AbortSignal,
  ): AsyncIterable<VolumeChunk>;

  /**
   * Number of chunks that {@link readRegion} will stream for the half-open voxel box `[voxelMin,
   * voxelMax)` at a resolution `level`. Pure integer math over the chunk grid (no I/O) — used to size a
   * progress bar and to know up front how many writes a brick upload will take.
   */
  regionChunkCount(
    level: number,
    voxelMin: readonly [number, number, number],
    voxelMax: readonly [number, number, number],
  ): number;
}

/** Bytes per element for a {@link VolumeDType}. */
export function dtypeByteSize(dtype: VolumeDType): number {
  switch (dtype) {
    case "uint8":
    case "int8":
      return 1;
    case "uint16":
    case "int16":
      return 2;
    case "uint32":
    case "int32":
    case "float32":
      return 4;
    case "float64":
      return 8;
    default:
      throw new NotImplementedError(`dtypeByteSize(${String(dtype)})`);
  }
}
