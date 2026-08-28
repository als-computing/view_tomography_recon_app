/**
 * Pure screen-space geometry for the volume renderer. No GPU calls, no class state.
 *
 * @packageDocumentation
 */

import type { Mat4 } from "@zarr-viewer/math";

/** Padding (px) added around a computed screen bbox — never clip active tiles at the very edge. */
export interface ScreenBbox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Screen-space pixel bounding box of the volume AABB (half-extents `boxHalf`, centered at the
 * origin), for conservative tile classification. Projects the 8 box corners with `viewProj`;
 * returns `null` when any corner is at/behind the camera (the box can't be reliably bounded on
 * screen — the caller should keep every tile that frame). Padded by `pad` on each side.
 */
export function aabbScreenBbox(
  viewProj: Mat4,
  w: number,
  h: number,
  boxHalf: readonly [number, number, number],
  pad: number,
): ScreenBbox | null {
  const e = viewProj.elements;
  const [hx, hy, hz] = boxHalf;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? hx : -hx;
    const y = i & 2 ? hy : -hy;
    const z = i & 4 ? hz : -hz;
    const cx = e[0]! * x + e[4]! * y + e[8]! * z + e[12]!;
    const cy = e[1]! * x + e[5]! * y + e[9]! * z + e[13]!;
    const cw = e[3]! * x + e[7]! * y + e[11]! * z + e[15]!;
    if (cw <= 1e-6) return null; // corner at/behind the camera — can't bound; keep all tiles
    const px = ((cx / cw) * 0.5 + 0.5) * w;
    // The fragment shader reconstructs rays with ndc.y = 2·py/h − 1 (y-flipped from standard clip),
    // so a point renders at py = (ndc.y + 1)/2·h — match that, or the bbox is vertically mirrored.
    const py = ((cy / cw) * 0.5 + 0.5) * h;
    minX = Math.min(minX, px);
    maxX = Math.max(maxX, px);
    minY = Math.min(minY, py);
    maxY = Math.max(maxY, py);
  }
  return {
    minX: Math.max(0, minX - pad),
    minY: Math.max(0, minY - pad),
    maxX: Math.min(w, maxX + pad),
    maxY: Math.min(h, maxY + pad),
  };
}
