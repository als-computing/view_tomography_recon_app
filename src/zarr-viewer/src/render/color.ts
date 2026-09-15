/**
 * Render-side color helpers: normalize {@link "@zarr-viewer/math".Color4Like} values for WebGPU.
 *
 * @packageDocumentation
 */

import {
  asColor3,
  asColor4,
  scaleColor3,
  type Color3,
  type Color3Like,
  type Color4,
  type Color4Like,
} from "@zarr-viewer/math";

/** Convert a {@link Color4Like} to a WebGPU `GPUColor` dict. */
export function toGpuColor(c: Color4Like): GPUColor {
  const t = asColor4(c);
  return { r: t[0], g: t[1], b: t[2], a: t[3] };
}

/** Normalize a light color × intensity into linear RGB. */
export function scaleLightColor(color: Color3Like, intensity: number): Color3 {
  return scaleColor3([0, 0, 0], color, intensity);
}

/** Normalize material / clear colors to concrete tuples. */
export function normalizeColor3(c: Color3Like): Color3 {
  return asColor3(c);
}

/** Normalize RGBA material colors to concrete tuples. */
export function normalizeColor4(c: Color4Like): Color4 {
  return asColor4(c);
}
