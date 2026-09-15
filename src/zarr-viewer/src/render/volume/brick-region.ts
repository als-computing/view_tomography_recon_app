/**
 * `chooseBrickRegion` — pick the finest multiscale level whose voxel sub-box fits given GPU/byte
 * limits, for high-res ROI brick streaming.
 *
 * The `BrickLoader` class this file used to also export (streaming a single dedicated brick texture)
 * was retired in item 9 stage 9b: `ResidencyController` now streams directly into a shared `BrickAtlas`
 * via `upload-to-atlas.ts`'s `uploadRegionToAtlasSlot`/`chooseAtlasBrickRegion` (which itself reuses
 * this file's `chooseBrickRegion` for its own level-search, fit against the atlas's fixed slot size
 * instead of a variable per-request texture-dimension/byte budget).
 *
 * @packageDocumentation
 */

import type { VolumeSource } from "@zarr-viewer/io";

// Smaller than the whole-level budget: keeps the brick texture cache-friendly and the fine voxel
// coarse enough that the (global) brick step doesn't explode the ray-march step count.
const DEFAULT_MAX_BRICK_BYTES = 192 * 1024 * 1024;

/**
 * Pick the finest multiscale level whose voxel sub-box for `[cropMin, cropMax]` (UVW `[0,1]`) fits the
 * GPU per-axis dimension limit and the byte budget (at ≥ r16). Returns the level + voxel box, or null
 * if even the coarsest level's sub-box doesn't fit. Finer levels have more voxels for the same crop
 * fraction, so we scan finest→coarsest and take the first that fits.
 */
export function chooseBrickRegion(
  source: VolumeSource,
  cropMin: readonly [number, number, number],
  cropMax: readonly [number, number, number],
  opts: {
    maxTextureDimension: number;
    maxUploadBytes?: number;
    /** Optional UVW box that overrides `cropMin`/`cropMax` (ray-guided vis-bin hint). */
    hint?: { min: readonly [number, number, number]; max: readonly [number, number, number] };
  },
): { level: number; voxelMin: [number, number, number]; voxelMax: [number, number, number] } | null {
  const loU = opts.hint?.min ?? cropMin;
  const hiU = opts.hint?.max ?? cropMax;
  const budget = opts.maxUploadBytes ?? DEFAULT_MAX_BRICK_BYTES;
  for (let level = 0; level < source.levelCount; level++) {
    const dims = source.dimensionsAt(level);
    const voxelMin: [number, number, number] = [0, 0, 0];
    const voxelMax: [number, number, number] = [0, 0, 0];
    let fits = true;
    let voxels = 1;
    for (let a = 0; a < 3; a++) {
      const d = dims[a]!;
      const lo = Math.max(0, Math.min(d - 1, Math.floor(loU[a]! * d)));
      const hi = Math.max(lo + 1, Math.min(d, Math.ceil(hiU[a]! * d)));
      voxelMin[a] = lo;
      voxelMax[a] = hi;
      const size = hi - lo;
      if (size > opts.maxTextureDimension) fits = false;
      voxels *= size;
    }
    // Require at least r16 (2 bytes/voxel) to fit the budget.
    if (fits && voxels * 2 <= budget) return { level, voxelMin, voxelMax };
  }
  return null;
}
