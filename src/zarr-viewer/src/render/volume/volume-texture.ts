/**
 * Upload a `@zarr-viewer/io` `VolumeSource` into a GPU 3D texture (`r8unorm`), chunk by chunk. Densities
 * are normalized by the source's `valueRange` into `[0, 1]`. Empty-space bricking is deferred; the
 * vertical slice uploads the full level into one texture.
 *
 * @packageDocumentation
 */

import { dtypeByteSize } from "@zarr-viewer/io";
import type { VolumeSource } from "@zarr-viewer/io";
import { ManagedTexture } from "../resources/texture.js";

/**
 * GPU texture format for the volume — a precision vs VRAM trade-off:
 * - `r8unorm`  — 8-bit (256 levels), 1 byte/voxel. Low memory, visible banding on narrow windows.
 * - `r16float` — 16-bit half (~2048 levels), 2 bytes/voxel. Filterable in core WebGPU. Default.
 * - `r32float` — full float, 4 bytes/voxel. Filterable only with the `float32-filterable` feature.
 */
export type VolumeTextureFormat = "r8unorm" | "r16float" | "r32float";

/** Options for {@link uploadVolume}. */
export interface UploadVolumeOptions {
  /** Multiscale level to upload (default 0). */
  level?: number;
  /** Texture format / precision (default `"r16float"`). */
  format?: VolumeTextureFormat;
  /**
   * ROI voxel offset `(x,y,z)` into the level. With {@link UploadVolumeOptions.size}, uploads only that
   * sub-box (high-res brick streaming) via `source.readRegion` instead of the whole level.
   */
  offset?: readonly [number, number, number];
  /** ROI voxel size `(x,y,z)`. Defaults to the full level (whole-level upload). */
  size?: readonly [number, number, number];
  /** Cancels in-flight region fetches when the ROI is superseded. */
  signal?: AbortSignal;
  /**
   * Progress callback for ROI (brick) uploads, fired as each chunk is written: `loaded` of `total`
   * chunks. Not called for whole-level uploads (they stream level-by-level elsewhere).
   */
  onProgress?: (loaded: number, total: number) => void;
}

/** Number of bins in the intensity histogram returned by {@link uploadVolume}. */
export const HISTOGRAM_BINS = 256;

/** Result of {@link uploadVolume}: the GPU texture plus a normalized intensity histogram. */
export interface UploadVolumeResult {
  texture: ManagedTexture;
  /** `HISTOGRAM_BINS` counts over the normalized `[0,1]` density range (for the TF editor). */
  histogram: Float32Array;
}

/**
 * Stream a {@link VolumeSource} into a 3D `r8unorm` texture.
 *
 * @example
 * ```ts
 * const tex = await uploadVolume(device, source, { level: 0 });
 * ```
 */
export async function uploadVolume(
  device: GPUDevice,
  source: VolumeSource,
  options: UploadVolumeOptions = {},
): Promise<UploadVolumeResult> {
  const level = options.level ?? 0;
  const [ldx, ldy, ldz] = source.dimensionsAt(level);
  // ROI window into the level; defaults to the whole level (offset 0, size = level dims).
  const roi = options.offset !== undefined || options.size !== undefined;
  const ox0 = options.offset?.[0] ?? 0;
  const oy0 = options.offset?.[1] ?? 0;
  const oz0 = options.offset?.[2] ?? 0;
  const width = options.size?.[0] ?? ldx;
  const height = options.size?.[1] ?? ldy;
  const depth = options.size?.[2] ?? ldz;
  const maxDim = device.limits.maxTextureDimension3D;
  if (width > maxDim || height > maxDim || depth > maxDim) {
    throw new Error(
      `uploadVolume: ${width}×${height}×${depth} exceeds maxTextureDimension3D (${maxDim}); pick a coarser level`,
    );
  }

  const [vmin, vmax] = source.valueRange;
  const span = vmax - vmin || 1;
  const format: VolumeTextureFormat = options.format ?? "r16float";
  const bytesPerElem = volumeFormatBytes(format);

  // Allocate the destination texture up front (size is known) so both paths write into it directly —
  // the ROI path fills it chunk-by-chunk as fetches land, avoiding a full-volume scratch buffer.
  const texture = new ManagedTexture(device, {
    size: [width, height, depth],
    format,
    dimension: "3d",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });

  if (roi) {
    // High-res brick: stream only the overlapping chunks (bounded-concurrency fetch inside readRegion)
    // and pack each into ONE brick-sized buffer as it lands — no giant float scratch, no histogram (the
    // base level feeds the TF editor). We do a single writeTexture at the end (never bind a partially
    // uploaded texture): the renderer only sees the brick once every chunk is in. Progress per chunk.
    const roiBox: RoiBox = { ox0, oy0, oz0, width, height, depth };
    const total = source.regionChunkCount(level, [ox0, oy0, oz0], [ox0 + width, oy0 + height, oz0 + depth]);
    const bytesPerRow = Math.ceil((width * bytesPerElem) / 256) * 256;
    const packed = new Uint8Array(bytesPerRow * height * depth);
    const view = new DataView(packed.buffer);
    let loaded = 0;
    options.onProgress?.(0, total);
    try {
      for await (const chunk of source.readRegion(
        level,
        [ox0, oy0, oz0],
        [ox0 + width, oy0 + height, oz0 + depth],
        options.signal,
      )) {
        packChunkInto(view, bytesPerRow, chunk, roiBox, source.dtype, format, bytesPerElem, vmin, span);
        loaded++;
        options.onProgress?.(loaded, total);
      }
    } catch (err) {
      texture.dispose(); // don't leak the texture on abort/error
      throw err;
    }
    device.queue.writeTexture(
      { texture: texture.gpu },
      packed,
      { bytesPerRow, rowsPerImage: height },
      { width, height, depthOrArrayLayers: depth },
    );
    return { texture, histogram: new Float32Array(HISTOGRAM_BINS) };
  }

  // Whole-level upload: scatter every chunk into one buffer, build the intensity histogram (for the TF
  // editor), then upload in a single writeTexture.
  const dens = new Float32Array(width * height * depth);
  dens.fill(0);
  for await (const chunk of source.chunks(level)) {
    const [ox, oy, oz] = chunk.origin;
    const [cx, cy, cz] = chunk.shape;
    const values = asFloatSamples(chunk.data, source.dtype);
    for (let z = 0; z < cz; z++) {
      for (let y = 0; y < cy; y++) {
        for (let x = 0; x < cx; x++) {
          const src = x + y * cx + z * cx * cy;
          const gx = ox + x - ox0;
          const gy = oy + y - oy0;
          const gz = oz + z - oz0;
          if (gx < 0 || gy < 0 || gz < 0 || gx >= width || gy >= height || gz >= depth) continue;
          const dst = gx + gy * width + gz * width * height;
          dens[dst] = (values[src]! - vmin) / span;
        }
      }
    }
  }

  // Intensity histogram over the normalized [0,1] densities (for the TF editor). Subsampled so huge
  // volumes stay fast — this runs once per level load, off the render loop.
  const histogram = new Float32Array(HISTOGRAM_BINS);
  const totalVoxels = dens.length;
  const stride = Math.max(1, Math.floor(totalVoxels / 2_000_000));
  for (let i = 0; i < totalVoxels; i += stride) {
    let b = (dens[i]! * HISTOGRAM_BINS) | 0;
    if (b < 0) b = 0;
    else if (b >= HISTOGRAM_BINS) b = HISTOGRAM_BINS - 1;
    histogram[b]++;
  }

  // WebGPU requires bytesPerRow to be a multiple of 256 for writeTexture.
  const bytesPerRow = Math.ceil((width * bytesPerElem) / 256) * 256;
  const packed = new Uint8Array(bytesPerRow * height * depth);
  const view = new DataView(packed.buffer);
  for (let z = 0; z < depth; z++) {
    for (let y = 0; y < height; y++) {
      const row = z * height * bytesPerRow + y * bytesPerRow;
      for (let x = 0; x < width; x++) {
        const v = clamp01(dens[x + y * width + z * width * height]!);
        encodeVoxel(view, row + x * bytesPerElem, v, format);
      }
    }
  }

  device.queue.writeTexture(
    { texture: texture.gpu },
    packed,
    { bytesPerRow, rowsPerImage: height },
    { width, height, depthOrArrayLayers: depth },
  );

  return { texture, histogram };
}

/** ROI window (voxel offset + size) a brick upload fills. */
interface RoiBox {
  ox0: number;
  oy0: number;
  oz0: number;
  width: number;
  height: number;
  depth: number;
}

/** Encode a normalized `[0,1]` density into the packed buffer at `off` for `format`. */
function encodeVoxel(view: DataView, off: number, v01: number, format: VolumeTextureFormat): void {
  if (format === "r8unorm") view.setUint8(off, Math.round(v01 * 255));
  else if (format === "r16float") view.setUint16(off, floatToHalf(v01), true);
  else view.setFloat32(off, v01, true);
}

/**
 * Pack the overlap of one chunk with the ROI box directly into the brick's single packed buffer at the
 * chunk's offset (`bytesPerRow`/`height` are the whole brick's). Chunks may straddle the ROI edges, so
 * we clip to the intersection. The buffer is uploaded once (a single writeTexture) after every chunk is
 * packed, so the renderer never binds a partially-filled texture.
 */
function packChunkInto(
  view: DataView,
  bytesPerRow: number,
  chunk: { origin: readonly [number, number, number]; shape: readonly [number, number, number]; data: ArrayBufferView },
  roi: RoiBox,
  dtype: VolumeSource["dtype"],
  format: VolumeTextureFormat,
  bytesPerElem: number,
  vmin: number,
  span: number,
): void {
  const [ox, oy, oz] = chunk.origin;
  const [cx, cy, cz] = chunk.shape;
  const gx0 = Math.max(ox, roi.ox0);
  const gy0 = Math.max(oy, roi.oy0);
  const gz0 = Math.max(oz, roi.oz0);
  const gx1 = Math.min(ox + cx, roi.ox0 + roi.width);
  const gy1 = Math.min(oy + cy, roi.oy0 + roi.height);
  const gz1 = Math.min(oz + cz, roi.oz0 + roi.depth);
  const ow = gx1 - gx0;
  const oh = gy1 - gy0;
  const od = gz1 - gz0;
  if (ow <= 0 || oh <= 0 || od <= 0) return; // no overlap (shouldn't happen — readRegion clips already)

  const values = asFloatSamples(chunk.data, dtype);
  const rowsPerImage = roi.height;
  for (let z = 0; z < od; z++) {
    const sz = gz0 - oz + z;
    const dz = gz0 - roi.oz0 + z;
    for (let y = 0; y < oh; y++) {
      const sy = gy0 - oy + y;
      const dy = gy0 - roi.oy0 + y;
      const rowBase = (dz * rowsPerImage + dy) * bytesPerRow;
      for (let x = 0; x < ow; x++) {
        const sx = gx0 - ox + x;
        const dx = gx0 - roi.ox0 + x;
        const v = clamp01((values[sx + sy * cx + sz * cx * cy]! - vmin) / span);
        encodeVoxel(view, rowBase + dx * bytesPerElem, v, format);
      }
    }
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Bytes per voxel for a volume texture format. */
export function volumeFormatBytes(format: VolumeTextureFormat): number {
  return format === "r8unorm" ? 1 : format === "r16float" ? 2 : 4;
}

/**
 * Pick the highest precision that fits a per-texture VRAM budget: `r32float` when the device can
 * linearly filter it and it fits, else `r16float`, else `r8unorm` under memory pressure.
 */
export function chooseVolumeFormat(
  voxelCount: number,
  opts: { supportsFloat32Filtering: boolean; budgetBytes?: number },
): VolumeTextureFormat {
  const budget = opts.budgetBytes ?? 512 * 1024 * 1024;
  if (opts.supportsFloat32Filtering && voxelCount * 4 <= budget) return "r32float";
  if (voxelCount * 2 <= budget) return "r16float";
  return "r8unorm";
}

// Scratch views for reinterpreting a float32's bits (for the half-float encoder).
const f32Scratch = new Float32Array(1);
const i32Scratch = new Int32Array(f32Scratch.buffer);

/**
 * Encode a JS number as an IEEE-754 half-float (16-bit) bit pattern (little-endian consumer writes it).
 * Our inputs are clamped to [0,1] so only the normal/subnormal-to-zero paths are exercised, but the
 * full range is handled for safety.
 */
export function floatToHalf(value: number): number {
  f32Scratch[0] = value;
  const x = i32Scratch[0]!;
  const sign = (x >> 16) & 0x8000;
  const exp = ((x >> 23) & 0xff) - 127 + 15;
  const mantissa = x & 0x7fffff;
  if (exp <= 0) {
    if (exp < -10) return sign; // too small → signed zero
    const m = (mantissa | 0x800000) >> (1 - exp);
    return sign | (m >> 13);
  }
  if (exp >= 0x1f) return sign | 0x7c00 | (mantissa ? 0x200 : 0); // overflow → inf / NaN
  return sign | (exp << 10) | (mantissa >> 13);
}

/** Interpret a chunk's typed array as float samples (one per voxel). */
function asFloatSamples(data: ArrayBufferView, dtype: VolumeSource["dtype"]): Float32Array {
  switch (dtype) {
    case "float32":
      return data instanceof Float32Array
        ? data
        : new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
    case "uint8": {
      const u8 =
        data instanceof Uint8Array
          ? data
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const out = new Float32Array(u8.length);
      for (let i = 0; i < u8.length; i++) out[i] = u8[i]!;
      return out;
    }
    case "uint16": {
      const u16 =
        data instanceof Uint16Array
          ? data
          : new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2);
      const out = new Float32Array(u16.length);
      for (let i = 0; i < u16.length; i++) out[i] = u16[i]!;
      return out;
    }
    case "float64": {
      const f64 =
        data instanceof Float64Array
          ? data
          : new Float64Array(data.buffer, data.byteOffset, data.byteLength / 8);
      return Float32Array.from(f64);
    }
    default: {
      // Best-effort: treat as opaque bytes → uint8.
      void dtypeByteSize(dtype);
      const u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const out = new Float32Array(u8.length);
      for (let i = 0; i < u8.length; i++) out[i] = u8[i]!;
      return out;
    }
  }
}
