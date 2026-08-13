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

/** Options for {@link uploadVolume}. */
export interface UploadVolumeOptions {
  /** Multiscale level to upload (default 0). */
  level?: number;
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
): Promise<ManagedTexture> {
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

  // WebGPU requires bytesPerRow to be a multiple of 256 for writeTexture.
  const bytesPerRow = Math.ceil(width / 256) * 256;
  const packed = new Uint8Array(bytesPerRow * height * depth);
  for (let z = 0; z < depth; z++) {
    for (let y = 0; y < height; y++) {
      const row = z * height * bytesPerRow + y * bytesPerRow;
      for (let x = 0; x < width; x++) {
        const v = dens[x + y * width + z * width * height]!;
        packed[row + x] = Math.round(clamp01(v) * 255);
      }
    }
  }

  const texture = new ManagedTexture(device, {
    size: [width, height, depth],
    format: "r8unorm",
    dimension: "3d",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });

  device.queue.writeTexture(
    { texture: texture.gpu },
    packed,
    { bytesPerRow, rowsPerImage: height },
    { width, height, depthOrArrayLayers: depth },
  );

  return texture;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
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
