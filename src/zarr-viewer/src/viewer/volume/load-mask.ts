/**
 * Loads a mask/annotation volume (item 7 Phase B): opens its own {@link VolumeSource} and uploads a
 * single coarse level as raw class ids. Assumed to share the primary volume's exact voxel grid (it's
 * an annotation of that same scan) — no world-AABB/translation handling, unlike the shelved general
 * multi-volume-layer work, which is why this is much simpler than `load-layer.ts`.
 *
 * For now this loads via the same OME-Zarr path as the primary — the only IO format this codebase
 * currently supports. The annotation app's real export format (a TIFF stack) needs its own loader
 * that also produces a `VolumeSource`; once that exists it plugs into this same function (and
 * everything downstream of it) with no changes needed here.
 *
 * @packageDocumentation
 */

import { openOmeZarr, httpStore, listUploadableLevels } from "@zarr-viewer/io";
import { uploadMaskVolume, type GpuContext, type ManagedTexture } from "@zarr-viewer/render";

/** A loaded mask dataset: the uploaded GPU texture plus its per-class voxel tally. */
export interface LoadedMaskVolume {
  readonly texture: ManagedTexture;
  /** Voxel count per class id (index = class id) — see `discoverMaskClasses`. */
  readonly classCounts: Uint32Array;
  /** The (coarsest uploadable) resolution level actually uploaded. */
  readonly level: number;
}

/** Open `url` as an OME-Zarr mask volume and upload its coarsest uploadable level. */
export async function loadMaskVolume(ctx: GpuContext, url: string): Promise<LoadedMaskVolume> {
  const store = httpStore(url);
  const source = await openOmeZarr(store, { skipRangeEstimate: true });

  const maxTex = ctx.device.limits.maxTextureDimension3D;
  const levels = listUploadableLevels(source, { maxTextureDimension: maxTex });
  if (levels.length === 0) {
    throw new Error(`Mask has no uploadable resolution level (GPU max 3D texture ${maxTex}).`);
  }
  const level = levels[levels.length - 1]!; // coarsest uploadable level

  const { texture, classCounts } = await uploadMaskVolume(ctx.device, source, { level });
  return { texture, classCounts, level };
}
