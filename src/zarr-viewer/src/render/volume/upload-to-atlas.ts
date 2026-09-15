/**
 * Streams a {@link VolumeSource} region into one slot of a shared {@link BrickAtlas} (item 9 stage 9b),
 * replacing the retired `BrickLoader`'s "allocate a brand-new dedicated texture per brick" model.
 * Reuses the exact fetch-and-pack loop `uploadVolume`'s ROI branch already established
 * (`packChunkInto`) — only the destination differs: one atlas slot's fixed `slotSize³` buffer instead
 * of a freshly-sized texture at the origin.
 *
 * @packageDocumentation
 */

import type { VolumeSource } from "@zarr-viewer/io";
import type { BrickAtlas } from "../accel/brick-atlas.js";
import { chooseBrickRegion } from "./brick-region.js";
import { packChunkInto, volumeFormatBytes, type RoiBox, type VolumeTextureFormat } from "./volume-texture.js";

/**
 * Fixed atlas slot size (voxels/axis) — a deliberate simplification over the old adaptive per-request
 * shrink-to-fit (`chooseVolumeFormat`/`BrickLoader`'s variable texture dimensions): one atlas, one slot
 * size and format, chosen once. 256³ at r16float is 32 MiB/slot, 128 MiB total for the fixed N=4 slots
 * this stage uses — a reasonable, conservative budget matching the old `DEFAULT_MAX_BRICK_BYTES` (192
 * MiB) order of magnitude while leaving room for 4 concurrently-resident regions instead of 1.
 */
export const ATLAS_SLOT_SIZE = 256;

/** GPU format for the shared brick atlas texture — filterable in core WebGPU, no capability check
 * needed (unlike `r32float`, which BrickLoader could adaptively pick when supported). */
export const ATLAS_FORMAT: GPUTextureFormat = "r16float";

/**
 * Pick the finest level + an exactly-`slotSize`-voxel-cubed region (per axis, clamped to the dataset's
 * own extent when an axis is thinner than `slotSize`) covering `[cropMin, cropMax]` (UVW `[0,1]`,
 * optionally overridden by `hint`). Reuses {@link chooseBrickRegion}'s finest-that-fits level search
 * (fit against the atlas's fixed `slotSize` instead of a variable per-request texture-dimension/byte
 * budget), then expands the fitted box to the full slot size (centered, clamped into the volume) so
 * every atlas slot's placed region is uniformly addressable via one shared `atlasOrigin` + `slotSize`
 * in the shader — no per-slot, per-axis size needed.
 *
 * Known, accepted limitation: when a dataset axis is thinner than `slotSize` (every dataset in this
 * app today has ≥256 voxels/axis at some level, so this hasn't been hit in practice), the placed region
 * on that axis is smaller than `slotSize`, but the shader still divides by the one shared `slotSize`
 * scalar — a slight under-scale on that axis for such a thin dataset. Not fixed in this pass.
 *
 * `gridSnap` (default 32, matching `ResidencyController`'s pre-existing voxel-grid snap) rounds the
 * region's center to a coarser grid before placing it, so sub-voxel camera drift doesn't produce a
 * new (and thus re-streamed) region every frame.
 */
export function chooseAtlasBrickRegion(
  source: VolumeSource,
  cropMin: readonly [number, number, number],
  cropMax: readonly [number, number, number],
  slotSize: number,
  opts: {
    hint?: { min: readonly [number, number, number]; max: readonly [number, number, number] };
    gridSnap?: number;
  } = {},
): { level: number; voxelMin: [number, number, number]; voxelMax: [number, number, number] } | null {
  const fit = chooseBrickRegion(source, cropMin, cropMax, {
    maxTextureDimension: slotSize,
    maxUploadBytes: Number.POSITIVE_INFINITY,
    hint: opts.hint,
  });
  if (!fit) return null;
  const q = opts.gridSnap ?? 32;
  const dims = source.dimensionsAt(fit.level);
  const voxelMin: [number, number, number] = [0, 0, 0];
  const voxelMax: [number, number, number] = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const dim = dims[a]!;
    const size = Math.min(slotSize, dim);
    const rawCenter = (fit.voxelMin[a]! + fit.voxelMax[a]!) / 2;
    const center = Math.round(rawCenter / q) * q;
    const lo = Math.max(0, Math.min(dim - size, Math.round(center - size / 2)));
    voxelMin[a] = lo;
    voxelMax[a] = lo + size;
  }
  return { level: fit.level, voxelMin, voxelMax };
}

/** Options for {@link uploadRegionToAtlasSlot}. */
export interface UploadRegionToAtlasOptions {
  signal?: AbortSignal;
  /** Fires as chunks land: `loaded` of `total` chunks written into the slot. */
  onProgress?: (loaded: number, total: number) => void;
}

/**
 * Stream `source`'s `[voxelMin, voxelMax)` region at `level` into `atlas`'s slot `slotIndex`. The
 * region must fit within one `atlas.slotSize³` slot (see {@link chooseAtlasBrickRegion}) — this
 * function does not shrink or validate it, it's the caller's job to have picked a region that fits.
 */
export async function uploadRegionToAtlasSlot(
  device: GPUDevice,
  atlas: BrickAtlas,
  slotIndex: number,
  source: VolumeSource,
  level: number,
  voxelMin: readonly [number, number, number],
  voxelMax: readonly [number, number, number],
  options: UploadRegionToAtlasOptions = {},
): Promise<void> {
  const width = voxelMax[0] - voxelMin[0];
  const height = voxelMax[1] - voxelMin[1];
  const depth = voxelMax[2] - voxelMin[2];
  if (width > atlas.slotSize || height > atlas.slotSize || depth > atlas.slotSize) {
    throw new Error(
      `uploadRegionToAtlasSlot: region ${width}x${height}x${depth} exceeds slot size ${atlas.slotSize}`,
    );
  }
  const format = atlas.texture.desc.format as VolumeTextureFormat;
  const bytesPerElem = volumeFormatBytes(format);
  const [vmin, vmax] = source.valueRange;
  const span = vmax - vmin || 1;
  // Buffer sized to the FULL slot (not just the requested region) — BrickAtlas.uploadToSlot always
  // writes exactly slotSize^3 texels at the slot's fixed origin/extent. Any fringe beyond the actual
  // requested region (when it's smaller than the slot on some axis) stays zero and is never sampled —
  // the shader's brick-local UVW only ever covers [0, width/slotSize) etc. (see this module's own
  // chooseAtlasBrickRegion doc comment for the one known edge case where that ratio isn't exactly 1).
  const roiBox: RoiBox = {
    ox0: voxelMin[0],
    oy0: voxelMin[1],
    oz0: voxelMin[2],
    width: atlas.slotSize,
    height: atlas.slotSize,
    depth: atlas.slotSize,
  };
  const total = source.regionChunkCount(level, voxelMin, voxelMax);
  const bytesPerRow = atlas.slotSize * bytesPerElem;
  const packed = new Uint8Array(bytesPerRow * atlas.slotSize * atlas.slotSize);
  const view = new DataView(packed.buffer);
  let loaded = 0;
  options.onProgress?.(0, total);
  for await (const chunk of source.readRegion(level, voxelMin, voxelMax, options.signal)) {
    packChunkInto(view, bytesPerRow, chunk, roiBox, source.dtype, format, bytesPerElem, vmin, span);
    loaded++;
    options.onProgress?.(loaded, total);
  }
  atlas.uploadToSlot(device, slotIndex, packed);
}
