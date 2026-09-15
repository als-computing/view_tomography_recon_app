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
 * returns `null` when any corner is at/behind the camera, OR close enough to the camera plane
 * (RELATIVE to the box's own deepest corner) that the perspective divide can't be trusted (the box
 * can't be reliably bounded on screen — the caller should keep every tile that frame). Padded by
 * `pad` on each side.
 *
 * The near-camera cutoff is a RATIO against the box's own deepest corner, not a fixed absolute
 * epsilon and not a fraction of the box's raw size — found live, across two rounds: a fixed
 * `cw <= 1e-6` only caught a corner literally behind the camera; a first attempt at scaling the
 * cutoff to the box's own absolute size (`Math.max(hx,hy,hz) * 1e-3`) still missed real cases at
 * angles less extreme than "camera almost touching one corner" ("it is getting a little better, but
 * there are still angles where it is unexpectedly clipping... need to be more aggressive"). `cw` is a
 * corner's world-unit depth along the view axis (same units as `boxHalf`), so for a camera positioned
 * anywhere reasonably close to one end of a strongly ELONGATED volume — looking down its own length,
 * or along the short axis of a flat/wide one — the near corner's `cw` can be a small fraction of the
 * FAR corner's `cw` well before it's a small fraction of the box's raw half-extent (e.g. a box 40
 * units long: a camera 4 units from the near corner and 44 from the far one is nowhere near the near
 * corner in absolute box-scale terms, but the near corner is already only ~9% of the far corner's
 * depth — exactly the regime a linear perspective divide starts breaking down in). Comparing each
 * corner's depth against the box's OWN deepest corner is self-calibrating regardless of box size or
 * camera distance, and directly targets "this box's own corners span a degenerate depth RANGE for this
 * view," which is the actual condition that makes the projection untrustworthy — not merely "some
 * corner is close to the camera in absolute terms." This mechanism only affects `fast`/`quality` (the
 * only configs with `spec.tiles` on; `baseline` never calls this at all).
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
  const cws = new Array<number>(8);
  let cwMax = -Infinity;
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? hx : -hx;
    const y = i & 2 ? hy : -hy;
    const z = i & 4 ? hz : -hz;
    const cw = e[3]! * x + e[7]! * y + e[11]! * z + e[15]!;
    cws[i] = cw;
    if (cw > cwMax) cwMax = cw;
  }
  // Aggressive, relative safety check (see this function's own doc comment for why relative-to-the-
  // box's-own-deepest-corner, not an absolute or box-scale-relative epsilon): bail to "keep all tiles"
  // whenever the box's own deepest corner is at/behind the camera, or ANY corner's depth falls below
  // 25% of it - a substantial margin, deliberately biased toward "occasionally skip a real optimization
  // opportunity" over "occasionally cull real geometry," since the former only costs a little
  // performance in an already-extreme viewing regime and the latter is a visible correctness bug.
  if (cwMax <= 1e-6) return null;
  const cwEps = cwMax * 0.25;
  for (let i = 0; i < 8; i++) {
    if (cws[i]! <= cwEps) return null;
  }
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
    const cw = cws[i]!;
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
