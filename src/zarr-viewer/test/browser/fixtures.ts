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
export type { VolumeSource } from "@zarr-viewer/io";

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

/** A non-cubic (anisotropic) synthetic volume: independent per-axis voxel counts. Everything else in
 * this file (`SyntheticVolume`, `multiRegionVolume`, etc.) is cubic-only, which is exactly why no
 * existing browser fixture could ever catch an anisotropy-specific bug (occupancy-grid macrocell
 * alignment, the tile-culling screen bbox's near-camera handling, direction-dependent ray-step sizing —
 * three real bugs found live this session, none of which any prior fixture could reproduce). */
export interface AnisotropicVolume {
  dims: readonly [number, number, number];
  /** Row-major (x fastest, then y, then z), length `dims[0]*dims[1]*dims[2]`. */
  data: Float32Array;
}

/** An elongated volume: `baseline` density everywhere except small marker regions (reusing
 * {@link HotspotRegion}, whose voxel-space `center`/`halfSize` already work fine for a non-cubic
 * volume). Deliberately sized so at least one axis is NOT an exact multiple of the occupancy grid's
 * own macrocell size (`MACROCELL_VOXELS = 8` — see `occupancy.ts`), so a real dataset-shaped alignment
 * bug between the occupancy grid's construction and the raymarch shader's own cell lookup has somewhere
 * to actually manifest, unlike every cubic/isotropic fixture in this file. */
export function elongatedMarkerVolume(
  dims: readonly [number, number, number],
  baseline: number,
  markers: readonly HotspotRegion[],
): AnisotropicVolume {
  const [sx, sy, sz] = dims;
  const data = new Float32Array(sx * sy * sz).fill(baseline);
  for (const r of markers) {
    const [cx, cy, cz] = r.center;
    const x0 = Math.max(0, cx - r.halfSize);
    const x1 = Math.min(sx, cx + r.halfSize);
    const y0 = Math.max(0, cy - r.halfSize);
    const y1 = Math.min(sy, cy + r.halfSize);
    const z0 = Math.max(0, cz - r.halfSize);
    const z1 = Math.min(sz, cz + r.halfSize);
    for (let z = z0; z < z1; z++) {
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          data[x + y * sx + z * sx * sy] = r.value;
        }
      }
    }
  }
  return { dims, data };
}

/** Wraps an {@link AnisotropicVolume} as a single-level, single-chunk `VolumeSource` (same shape as
 * {@link syntheticSource}, just with independent per-axis dimensions instead of a cube). */
function anisotropicSource(volume: AnisotropicVolume): VolumeSource {
  const { dims, data } = volume;
  const spacing: readonly [number, number, number] = [1e-6, 1e-6, 1e-6];
  return {
    dimensions: dims,
    spacing,
    dtype: "float32",
    valueRange: [0, 1],
    levelCount: 1,
    dimensionsAt: () => dims,
    spacingAt: () => spacing,
    readChunk(): Promise<VolumeChunk> {
      throw new NotImplementedError("anisotropicSource.readChunk: not used by a whole-level upload");
    },
    async *chunks(level: number): AsyncIterable<VolumeChunk> {
      if (level !== 0) throw new Error(`anisotropicSource: only level 0 exists, got ${level}`);
      yield { origin: [0, 0, 0], shape: dims, data };
    },
    readRegion(): AsyncIterable<VolumeChunk> {
      throw new NotImplementedError("anisotropicSource.readRegion: not used by a whole-level upload");
    },
    regionChunkCount(): number {
      throw new NotImplementedError("anisotropicSource.regionChunkCount: not used by a whole-level upload");
    },
  };
}

/** Upload an {@link AnisotropicVolume} into a fresh GPU texture via the real production upload path. */
export async function uploadAnisotropicVolume(
  device: GPUDevice,
  volume: AnisotropicVolume,
): Promise<ManagedTexture> {
  const { texture } = await uploadVolume(device, anisotropicSource(volume), { level: 0 });
  return texture;
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

// --- Item 9 stage 9c: multi-level/multi-region synthetic sources -----------------------------------
//
// The single-level `syntheticSource()` above is enough for whole-level uploads (`uploadVolume`'s
// `chunks()` path), but a real multi-brick ROI test needs a source whose `readRegion`/`regionChunkCount`
// actually work (they're what `uploadRegionToAtlasSlot` calls) and, ideally, more than one resolution
// level - general-purpose infrastructure reusable beyond just this one fixture, not special-cased to it.

/** Box-downsample `vol` 2x per axis (real 8-voxel average, not a stand-in) - the simplest correct way
 * to derive a coarser multiscale level from a finest-level `SyntheticVolume`. Odd input sizes floor. */
export function downsample2x(vol: SyntheticVolume): SyntheticVolume {
  const inSize = vol.size;
  const outSize = Math.max(1, Math.floor(inSize / 2));
  const data = new Float32Array(outSize * outSize * outSize);
  for (let z = 0; z < outSize; z++) {
    for (let y = 0; y < outSize; y++) {
      for (let x = 0; x < outSize; x++) {
        let sum = 0;
        let count = 0;
        for (let dz = 0; dz < 2; dz++) {
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              const sx = x * 2 + dx;
              const sy = y * 2 + dy;
              const sz = z * 2 + dz;
              if (sx >= inSize || sy >= inSize || sz >= inSize) continue;
              sum += vol.data[sx + sy * inSize + sz * inSize * inSize]!;
              count++;
            }
          }
        }
        data[x + y * outSize + z * outSize * outSize] = count > 0 ? sum / count : 0;
      }
    }
  }
  return { size: outSize, data };
}

/** A cubic sub-region of constant density, for placing distinct "hot spots" in a `multiRegionVolume`. */
export interface HotspotRegion {
  /** Voxel-space center within the finest level. */
  center: readonly [number, number, number];
  /** Half-size in voxels (region spans `center ± halfSize` on each axis, clamped to the volume). */
  halfSize: number;
  value: number;
}

/** A `baseline`-density volume with one or more distinct constant-value cubic `regions` overlaid -
 * unlike `sphereVolume`'s single analytically-symmetric feature, this is built for tests that need
 * several independently-identifiable, non-overlapping regions (e.g. one per brick slot). */
export function multiRegionVolume(size: number, baseline: number, regions: readonly HotspotRegion[]): SyntheticVolume {
  const data = new Float32Array(size * size * size).fill(baseline);
  for (const r of regions) {
    const [cx, cy, cz] = r.center;
    const x0 = Math.max(0, cx - r.halfSize);
    const x1 = Math.min(size, cx + r.halfSize);
    const y0 = Math.max(0, cy - r.halfSize);
    const y1 = Math.min(size, cy + r.halfSize);
    const z0 = Math.max(0, cz - r.halfSize);
    const z1 = Math.min(size, cz + r.halfSize);
    for (let z = z0; z < z1; z++) {
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          data[x + y * size + z * size * size] = r.value;
        }
      }
    }
  }
  return { size, data };
}

/**
 * Wraps a real multiscale pyramid (`levels[0]` finest) as a `VolumeSource` with genuinely working
 * `readChunk`/`chunks`/`readRegion`/`regionChunkCount` - chunked into fixed `chunkSize` pieces (ragged
 * at the volume's edges, same as a real chunked store), with `readRegion`/`regionChunkCount` yielding
 * only chunks that actually intersect the requested box, clipped by nothing more than the box itself
 * (each chunk keeps its own true origin/shape, matching the real `VolumeSource` contract - the caller
 * clips into its own destination, same as every other implementation in this codebase).
 */
export function chunkedMultiLevelSource(levels: readonly SyntheticVolume[], chunkSize = 16): VolumeSource {
  const spacing: readonly [number, number, number] = [1e-6, 1e-6, 1e-6];
  const dimsAt = (level: number): readonly [number, number, number] => {
    const s = levels[level]!.size;
    return [s, s, s];
  };

  function* chunkOrigins(level: number): Generator<[number, number, number]> {
    const dim = levels[level]!.size;
    for (let z = 0; z < dim; z += chunkSize) {
      for (let y = 0; y < dim; y += chunkSize) {
        for (let x = 0; x < dim; x += chunkSize) {
          yield [x, y, z];
        }
      }
    }
  }

  function chunkAt(level: number, origin: readonly [number, number, number]): VolumeChunk {
    const vol = levels[level]!;
    const dim = vol.size;
    const [ox, oy, oz] = origin;
    const cw = Math.min(chunkSize, dim - ox);
    const ch = Math.min(chunkSize, dim - oy);
    const cd = Math.min(chunkSize, dim - oz);
    const data = new Float32Array(cw * ch * cd);
    for (let z = 0; z < cd; z++) {
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          data[x + y * cw + z * cw * ch] = vol.data[ox + x + (oy + y) * dim + (oz + z) * dim * dim]!;
        }
      }
    }
    return { origin: [ox, oy, oz], shape: [cw, ch, cd], data };
  }

  function intersects(
    origin: readonly [number, number, number],
    shape: readonly [number, number, number],
    voxelMin: readonly [number, number, number],
    voxelMax: readonly [number, number, number],
  ): boolean {
    for (let a = 0; a < 3; a++) {
      if (origin[a]! >= voxelMax[a]! || origin[a]! + shape[a]! <= voxelMin[a]!) return false;
    }
    return true;
  }

  function chunkShapeAt(level: number, origin: readonly [number, number, number]): [number, number, number] {
    const dim = levels[level]!.size;
    return [
      Math.min(chunkSize, dim - origin[0]),
      Math.min(chunkSize, dim - origin[1]),
      Math.min(chunkSize, dim - origin[2]),
    ];
  }

  return {
    dimensions: dimsAt(0),
    spacing,
    dtype: "float32",
    valueRange: [0, 1],
    levelCount: levels.length,
    dimensionsAt: dimsAt,
    spacingAt: () => spacing,
    async readChunk(level, x, y, z): Promise<VolumeChunk> {
      const dim = levels[level]!.size;
      const ox = Math.min(dim, Math.floor(x / chunkSize) * chunkSize);
      const oy = Math.min(dim, Math.floor(y / chunkSize) * chunkSize);
      const oz = Math.min(dim, Math.floor(z / chunkSize) * chunkSize);
      return chunkAt(level, [ox, oy, oz]);
    },
    async *chunks(level: number): AsyncIterable<VolumeChunk> {
      for (const origin of chunkOrigins(level)) yield chunkAt(level, origin);
    },
    async *readRegion(level, voxelMin, voxelMax, signal): AsyncIterable<VolumeChunk> {
      for (const origin of chunkOrigins(level)) {
        signal?.throwIfAborted();
        if (!intersects(origin, chunkShapeAt(level, origin), voxelMin, voxelMax)) continue;
        yield chunkAt(level, origin);
      }
    },
    regionChunkCount(level, voxelMin, voxelMax): number {
      let count = 0;
      for (const origin of chunkOrigins(level)) {
        if (intersects(origin, chunkShapeAt(level, origin), voxelMin, voxelMax)) count++;
      }
      return count;
    },
  };
}
