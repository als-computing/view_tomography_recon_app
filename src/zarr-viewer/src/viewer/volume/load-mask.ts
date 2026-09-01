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
import {
  uploadMaskVolume,
  uploadMaskArray,
  type GpuContext,
  type ManagedTexture,
} from "@zarr-viewer/render";

/** A loaded mask dataset: the uploaded GPU texture plus its per-class voxel tally. */
export interface LoadedMaskVolume {
  readonly texture: ManagedTexture;
  /** Voxel count per class id (index = class id) — see `discoverMaskClasses`. */
  readonly classCounts: Uint32Array;
  /** The (coarsest uploadable) resolution level actually uploaded — not applicable (`undefined`) for
   * an array-sourced mask ({@link loadMaskFromArray}), which has no level/pyramid concept. */
  readonly level?: number;
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

/**
 * Upload a caller-supplied class-id array directly — no `openOmeZarr`/`httpStore`, no network access,
 * no level/pyramid logic. For a host app with its own client-side rasterizer that just wants to hand
 * this viewer a finished array (e.g. a live interactive-classifier result) at whatever resolution it
 * chooses. `data` must be exactly `dims[0]*dims[1]*dims[2]` bytes (see `uploadMaskArray`'s own doc for
 * the exact layout). Kept `async` (trivially resolving) to match `loadMaskVolume`'s call shape, even
 * though the underlying upload is synchronous.
 */
export async function loadMaskFromArray(
  ctx: GpuContext,
  data: Uint8Array,
  dims: readonly [number, number, number],
): Promise<LoadedMaskVolume> {
  const { texture, classCounts } = uploadMaskArray(ctx.device, data, dims);
  return { texture, classCounts };
}
