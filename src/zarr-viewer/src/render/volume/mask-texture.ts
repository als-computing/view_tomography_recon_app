/**
 * Upload a raw-class-ID mask/annotation volume (item 7 Phase B) into a 3D `r8uint` GPU texture,
 * preserving exact integer values (`0..255`) rather than normalizing by `valueRange` the way
 * {@link "./volume-texture.js".uploadVolume} does for density-like data — a mask's values ARE the
 * class IDs, not a continuous quantity to rescale, and must never be interpolated (an "average" of
 * two class IDs is meaningless), which is why this is `r8uint`/`textureLoad`, not `r8unorm`/sampled.
 *
 * @packageDocumentation
 */

import type { VolumeSource } from "@zarr-viewer/io";
import { ManagedTexture } from "../resources/texture.js";

/** Number of possible class IDs (a `uint8` mask's full range). */
export const MASK_CLASS_COUNT = 256;

/** Options for {@link uploadMaskVolume}. */
export interface UploadMaskVolumeOptions {
  /** Multiscale level to upload (default 0). */
  level?: number;
}

/** Result of {@link uploadMaskVolume}: the GPU texture plus a per-class voxel tally. */
export interface UploadMaskVolumeResult {
  texture: ManagedTexture;
  /** Voxel count per class ID (index = class id) — used to discover which classes are actually
   * present in this specific mask, so the HUD only lists classes that occur rather than all 256. */
  classCounts: Uint32Array;
}

/**
 * Upload a 256-entry `rgba8unorm` mask palette (index = class id, byte layout produced by the
 * viewer's `buildMaskPalette`) as a single-row 2D texture. Callers should dispose the previous
 * palette texture when replacing it (e.g. after a per-class color/opacity/visibility edit) — this
 * always allocates a new one rather than updating in place, matching how `setTransferFunction`
 * rebuilds its LUT texture on every change.
 */
export function uploadMaskPalette(device: GPUDevice, paletteRgba: Uint8Array): ManagedTexture {
  const texture = new ManagedTexture(device, {
    size: [MASK_CLASS_COUNT, 1, 1],
    format: "rgba8unorm",
    dimension: "2d",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  // Re-wrap into a freshly-constructed Uint8Array (a plain `Uint8Array` parameter type doesn't narrow
  // to the `ArrayBuffer`-backed form `writeTexture` wants) — same workaround used elsewhere in this
  // codebase (e.g. `setTransferFunction`'s LUT) for a caller-supplied typed array.
  device.queue.writeTexture(
    { texture: texture.gpu },
    new Uint8Array(paletteRgba),
    { bytesPerRow: MASK_CLASS_COUNT * 4 }, // 1024, already a multiple of 256 - no padding needed
    { width: MASK_CLASS_COUNT, height: 1, depthOrArrayLayers: 1 },
  );
  return texture;
}

/**
 * Stream a {@link VolumeSource} into a 3D `r8uint` texture. No progressive/ROI streaming for v1
 * (masks are typically smaller than the primary scan) — "simplest correct thing first," per the plan.
 */
export async function uploadMaskVolume(
  device: GPUDevice,
  source: VolumeSource,
  options: UploadMaskVolumeOptions = {},
): Promise<UploadMaskVolumeResult> {
  const level = options.level ?? 0;
  const [width, height, depth] = source.dimensionsAt(level);
  const maxDim = device.limits.maxTextureDimension3D;
  if (width > maxDim || height > maxDim || depth > maxDim) {
    throw new Error(
      `uploadMaskVolume: ${width}×${height}×${depth} exceeds maxTextureDimension3D (${maxDim}); pick a coarser level`,
    );
  }

  const texture = new ManagedTexture(device, {
    size: [width, height, depth],
    format: "r8uint",
    dimension: "3d",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });

  // WebGPU's writeTexture wants bytesPerRow padded to a 256-byte multiple, same as uploadVolume.
  const bytesPerRow = Math.ceil(width / 256) * 256;
  const packed = new Uint8Array(bytesPerRow * height * depth);
  const classCounts = new Uint32Array(MASK_CLASS_COUNT);

  for await (const chunk of source.chunks(level)) {
    const [ox, oy, oz] = chunk.origin;
    const [cx, cy, cz] = chunk.shape;
    const values = asClassIdSamples(chunk.data, source.dtype);
    for (let z = 0; z < cz; z++) {
      const gz = oz + z;
      if (gz >= depth) continue;
      for (let y = 0; y < cy; y++) {
        const gy = oy + y;
        if (gy >= height) continue;
        const rowBase = (gz * height + gy) * bytesPerRow;
        const srcRowBase = y * cx + z * cx * cy;
        for (let x = 0; x < cx; x++) {
          const gx = ox + x;
          if (gx >= width) continue;
          const classId = values[srcRowBase + x]!;
          packed[rowBase + gx] = classId;
          classCounts[classId]!++;
        }
      }
    }
  }

  device.queue.writeTexture(
    { texture: texture.gpu },
    packed,
    { bytesPerRow, rowsPerImage: height },
    { width, height, depthOrArrayLayers: depth },
  );

  return { texture, classCounts };
}

/** Result of {@link uploadMaskArray}: the GPU texture plus a per-class voxel tally. */
export interface UploadMaskArrayResult {
  texture: ManagedTexture;
  classCounts: Uint32Array;
}

/**
 * Upload an already-dense, caller-supplied class-id array directly — no `VolumeSource`/chunk
 * iteration, no level/pyramid logic, and (unlike {@link uploadMaskVolume}) no network access at all.
 * For a host app that has its own client-side rasterizer and just wants to hand this viewer a finished
 * array (e.g. a live interactive-classifier result) at whatever resolution it chooses. `data` must be
 * exactly `dims[0]*dims[1]*dims[2]` bytes, row-major x-fastest (matching `VolumeSource.chunks()`'s own
 * voxel layout), one byte per class id.
 */
export function uploadMaskArray(
  device: GPUDevice,
  data: Uint8Array,
  dims: readonly [number, number, number],
): UploadMaskArrayResult {
  const [width, height, depth] = dims;
  const maxDim = device.limits.maxTextureDimension3D;
  if (width > maxDim || height > maxDim || depth > maxDim) {
    throw new Error(
      `uploadMaskArray: ${width}×${height}×${depth} exceeds maxTextureDimension3D (${maxDim})`,
    );
  }
  const expected = width * height * depth;
  if (data.length !== expected) {
    throw new Error(
      `uploadMaskArray: data.length (${data.length}) doesn't match dims ${width}×${height}×${depth} (expected ${expected})`,
    );
  }

  const texture = new ManagedTexture(device, {
    size: [width, height, depth],
    format: "r8uint",
    dimension: "3d",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });

  const classCounts = new Uint32Array(MASK_CLASS_COUNT);
  const bytesPerRow = Math.ceil(width / 256) * 256;
  let packed: Uint8Array<ArrayBuffer>;
  if (bytesPerRow === width) {
    // No row padding needed - tally in place and re-wrap for writeTexture's ArrayBuffer-narrowing
    // workaround (see uploadMaskPalette's own comment on this).
    for (let i = 0; i < data.length; i++) classCounts[data[i]!]++;
    packed = new Uint8Array(data);
  } else {
    packed = new Uint8Array(bytesPerRow * height * depth);
    for (let z = 0; z < depth; z++) {
      for (let y = 0; y < height; y++) {
        const srcRow = (z * height + y) * width;
        const dstRow = (z * height + y) * bytesPerRow;
        for (let x = 0; x < width; x++) {
          const v = data[srcRow + x]!;
          packed[dstRow + x] = v;
          classCounts[v]!++;
        }
      }
    }
  }

  device.queue.writeTexture(
    { texture: texture.gpu },
    packed,
    { bytesPerRow, rowsPerImage: height },
    { width, height, depthOrArrayLayers: depth },
  );

  return { texture, classCounts };
}

/** Read a chunk's voxel data as exact class IDs, clamped into `[0,255]` for any dtype other than the
 * expected `uint8` (masks are expected to be uint8; this is a defensive fallback, not a real format).
 * Exported (pure, no GPU dependency) so its dtype/clamping behavior is directly unit-testable. */
export function asClassIdSamples(data: ArrayBufferView, dtype: VolumeSource["dtype"]): Uint8Array {
  if (dtype === "uint8") {
    return data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  const numeric = readNumeric(data, dtype);
  const out = new Uint8Array(numeric.length);
  for (let i = 0; i < numeric.length; i++) {
    out[i] = Math.max(0, Math.min(255, Math.round(numeric[i]!)));
  }
  return out;
}

function readNumeric(data: ArrayBufferView, dtype: VolumeSource["dtype"]): ArrayLike<number> {
  switch (dtype) {
    case "int8":
      return data instanceof Int8Array ? data : new Int8Array(data.buffer, data.byteOffset, data.byteLength);
    case "uint16":
      return data instanceof Uint16Array
        ? data
        : new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2);
    case "int16":
      return data instanceof Int16Array
        ? data
        : new Int16Array(data.buffer, data.byteOffset, data.byteLength / 2);
    case "uint32":
      return data instanceof Uint32Array
        ? data
        : new Uint32Array(data.buffer, data.byteOffset, data.byteLength / 4);
    case "int32":
      return data instanceof Int32Array
        ? data
        : new Int32Array(data.buffer, data.byteOffset, data.byteLength / 4);
    case "float32":
      return data instanceof Float32Array
        ? data
        : new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
    case "float64":
      return data instanceof Float64Array
        ? data
        : new Float64Array(data.buffer, data.byteOffset, data.byteLength / 8);
    default:
      return data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
}
