/**
 * Synthetic test volumes for the Playwright/WebGPU browser harness. Pure generators — no zarr/network
 * involvement — wrapped in a minimal `VolumeSource` and uploaded via the real production `uploadVolume`
 * path (same packing/format code every real dataset goes through), rather than reinventing texture
 * packing in test code.
 *
 * @packageDocumentation
 */

import { NotImplementedError } from "@zarr-viewer/core";
import type { VolumeChunk, VolumeSource } from "@zarr-viewer/io";
import { uploadVolume, type ManagedTexture } from "@zarr-viewer/render";

/** A small cubic synthetic volume: `size`³ voxels of density in `[0,1]`. */
export interface SyntheticVolume {
  size: number;
  /** Row-major (x fastest, then y, then z), length `size³`. */
  data: Float32Array;
}

/** Uniform density everywhere — the simplest possible sanity baseline: a perfectly flat volume must
 * render as a spatially uniform image; any directional variation is a real bug (an asymmetric
 * gradient/lighting computation, a coordinate-convention mistake, etc.), not a property of the data. */
export function constantVolume(size = 32, value = 0.6): SyntheticVolume {
  return { size, data: new Float32Array(size * size * size).fill(value) };
}

/** A solid sphere (density 1 inside, smoothstep falloff to 0 over `edge` fraction of the volume size,
 * then 0 outside) centered in the volume. Analytically symmetric under any axis mirror — a real
 * gradient-direction bug (e.g. an unnormalized-by-spacing or wrong-sign finite-difference step) breaks
 * that symmetry in a way flat/directional test data can't reveal. */
export function sphereVolume(size = 32, radiusFraction = 0.22, edge = 0.08): SyntheticVolume {
  const data = new Float32Array(size * size * size);
  const c = (size - 1) / 2;
  const r = radiusFraction * size;
  const edgeR = Math.max(1e-3, edge * size);
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - c;
        const dy = y - c;
        const dz = z - c;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const t = Math.min(1, Math.max(0, (dist - r) / edgeR)); // smoothstep(r, r+edgeR, dist)
        const smooth = t * t * (3 - 2 * t);
        data[x + y * size + z * size * size] = 1 - smooth;
      }
    }
  }
  return { size, data };
}

/** Wraps a {@link SyntheticVolume} as a single-level, single-chunk `VolumeSource` — enough for
 * `uploadVolume`'s whole-level path (`chunks()`), which is all this harness needs. The ROI-brick-only
 * methods (`readChunk`/`readRegion`/`regionChunkCount`) are never called on a whole-level upload;
 * they throw if they ever are, rather than silently returning wrong data. */
function syntheticSource(volume: SyntheticVolume): VolumeSource {
  const { size, data } = volume;
  const dims: readonly [number, number, number] = [size, size, size];
  const spacing: readonly [number, number, number] = [1e-6, 1e-6, 1e-6]; // 1 µm/voxel, arbitrary
  return {
    dimensions: dims,
    spacing,
    dtype: "float32",
    valueRange: [0, 1],
    levelCount: 1,
    dimensionsAt: () => dims,
    spacingAt: () => spacing,
    readChunk(): Promise<VolumeChunk> {
      throw new NotImplementedError("syntheticSource.readChunk: not used by a whole-level upload");
    },
    async *chunks(level: number): AsyncIterable<VolumeChunk> {
      if (level !== 0) throw new Error(`syntheticSource: only level 0 exists, got ${level}`);
      yield { origin: [0, 0, 0], shape: dims, data };
    },
    readRegion(): AsyncIterable<VolumeChunk> {
      throw new NotImplementedError("syntheticSource.readRegion: not used by a whole-level upload");
    },
    regionChunkCount(): number {
      throw new NotImplementedError("syntheticSource.regionChunkCount: not used by a whole-level upload");
    },
  };
}

/** Upload a {@link SyntheticVolume} into a fresh GPU texture via the real production upload path. */
export async function uploadSyntheticVolume(
  device: GPUDevice,
  volume: SyntheticVolume,
): Promise<ManagedTexture> {
  const { texture } = await uploadVolume(device, syntheticSource(volume), { level: 0 });
  return texture;
}
