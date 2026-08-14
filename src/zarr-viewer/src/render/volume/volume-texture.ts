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
  const [dx, dy, dz] = source.dimensionsAt(level);
  const width = dx;
  const height = dy;
  const depth = dz;
  const maxDim = device.limits.maxTextureDimension3D;
  if (width > maxDim || height > maxDim || depth > maxDim) {
    throw new Error(
      `uploadVolume: ${width}×${height}×${depth} exceeds maxTextureDimension3D (${maxDim}); pick a coarser level`,
    );
  }

  const dens = new Float32Array(width * height * depth);
  dens.fill(0);

  const [vmin, vmax] = source.valueRange;
  const span = vmax - vmin || 1;

  for await (const chunk of source.chunks(level)) {
    const [ox, oy, oz] = chunk.origin;
    const [cx, cy, cz] = chunk.shape;
    const values = asFloatSamples(chunk.data, source.dtype);
    for (let z = 0; z < cz; z++) {
      for (let y = 0; y < cy; y++) {
        for (let x = 0; x < cx; x++) {
          const src = x + y * cx + z * cx * cy;
          const gx = ox + x;
          const gy = oy + y;
          const gz = oz + z;
          if (gx >= width || gy >= height || gz >= depth) continue;
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

  const format: VolumeTextureFormat = options.format ?? "r16float";
  const bytesPerElem = format === "r8unorm" ? 1 : format === "r16float" ? 2 : 4;
  // WebGPU requires bytesPerRow to be a multiple of 256 for writeTexture.
  const bytesPerRow = Math.ceil((width * bytesPerElem) / 256) * 256;
  const packed = new Uint8Array(bytesPerRow * height * depth);
  const view = new DataView(packed.buffer);
  for (let z = 0; z < depth; z++) {
    for (let y = 0; y < height; y++) {
      const row = z * height * bytesPerRow + y * bytesPerRow;
      for (let x = 0; x < width; x++) {
        const v = clamp01(dens[x + y * width + z * width * height]!);
        const off = row + x * bytesPerElem;
        if (format === "r8unorm") view.setUint8(off, Math.round(v * 255));
        else if (format === "r16float") view.setUint16(off, floatToHalf(v), true);
        else view.setFloat32(off, v, true);
      }
    }
  }

  const texture = new ManagedTexture(device, {
    size: [width, height, depth],
    format,
    dimension: "3d",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });

  device.queue.writeTexture(
    { texture: texture.gpu },
    packed,
    { bytesPerRow, rowsPerImage: height },
    { width, height, depthOrArrayLayers: depth },
  );

  return { texture, histogram };
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
function floatToHalf(value: number): number {
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
