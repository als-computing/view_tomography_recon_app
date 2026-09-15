/**
 * Loads a second ("layer") dataset for the composited-volume-layers feature (item 7 of the feature
 * plan): opens its own {@link VolumeSource} and uploads a single coarse level to the GPU, mirroring
 * the primary volume's open/upload path but without a full progressive-streaming pipeline — masks and
 * secondary scans are typically smaller, so "simplest correct thing first" per the plan.
 *
 * @packageDocumentation
 */

import { units } from "@zarr-viewer/core";
import { openOmeZarr, httpStore, physicalSizeSim, listUploadableLevels, type VolumeSource } from "@zarr-viewer/io";
import {
  uploadVolume,
  chooseVolumeFormat,
  type GpuContext,
  type ManagedTexture,
} from "@zarr-viewer/render";
import { Vec3 } from "@zarr-viewer/math";

/** A loaded layer dataset: its source (for metadata) plus the uploaded GPU texture and world box. */
export interface LoadedLayerVolume {
  readonly source: VolumeSource;
  readonly texture: ManagedTexture;
  /** The (coarsest uploadable) resolution level actually uploaded. */
  readonly level: number;
  /** World-space AABB the texture's `[0,1]^3` maps onto, centered at the origin. */
  readonly worldMin: readonly [number, number, number];
  readonly worldMax: readonly [number, number, number];
}

/**
 * Open `url` as an OME-Zarr volume and upload its coarsest uploadable level. `system` is the unit
 * system used to convert the dataset's physical size into sim units (pass the same one the primary
 * volume uses, so a layer's box is comparable to the primary's).
 *
 * NGFF `translation` is not read here, matching the primary volume's own behavior (it always centers
 * its box at the world origin, sized only by `dimensions × spacing`) — a layer dataset with a real
 * physical offset from the primary will misregister until that's plumbed through end-to-end, which is
 * explicitly a later step in the plan, not something this function assumes is already correct.
 */
export async function loadLayerVolume(ctx: GpuContext, url: string, system: units.UnitSystem): Promise<LoadedLayerVolume> {
  const store = httpStore(url);
  const source = await openOmeZarr(store, { skipRangeEstimate: true });

  const maxTex = ctx.maxTextureDimension3D;
  const levels = listUploadableLevels(source, { maxTextureDimension: maxTex });
  if (levels.length === 0) {
    throw new Error(`Layer has no uploadable resolution level (GPU max 3D texture ${maxTex}).`);
  }
  const level = levels[levels.length - 1]!; // coarsest uploadable level

  const [dx, dy, dz] = source.dimensionsAt(level);
  const format = chooseVolumeFormat(dx * dy * dz, {
    supportsFloat32Filtering: ctx.supportsFloat32Filtering,
  });
  const { texture } = await uploadVolume(ctx.device, source, { level, format });

  const sizeSim = physicalSizeSim(new Vec3(), source, system, level);
  const worldMin: [number, number, number] = [-sizeSim.x * 0.5, -sizeSim.y * 0.5, -sizeSim.z * 0.5];
  const worldMax: [number, number, number] = [sizeSim.x * 0.5, sizeSim.y * 0.5, sizeSim.z * 0.5];

  return { source, texture, level, worldMin, worldMax };
}
