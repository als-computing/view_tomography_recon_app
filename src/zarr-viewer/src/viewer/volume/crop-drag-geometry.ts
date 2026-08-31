/**
 * Pure ray/box geometry for interactive crop-box dragging: which face of the crop box a view ray hits
 * first, where a face should move to when the user drags it, and projecting the box's corners to
 * screen space for the wireframe overlay. No DOM, no GPU calls, no mutable viewer state — mirrors
 * `roi-geometry.ts`'s style (plain number tuples, allocation-light).
 *
 * @packageDocumentation
 */

import type { Mat4 } from "@zarr-viewer/math";
import { mulMat4Vec4 } from "../util.js";

/** 0 = x, 1 = y, 2 = z. */
export type CropFaceAxis = 0 | 1 | 2;

/** The 8 corners of an AABB, indexed by bit0=x/bit1=y/bit2=z (0 = min side, 1 = max side). */
export function boxCorners(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): [number, number, number][] {
  const corners: [number, number, number][] = [];
  for (let i = 0; i < 8; i++) {
    corners.push([(i & 1) === 0 ? min[0] : max[0], (i & 2) === 0 ? min[1] : max[1], (i & 4) === 0 ? min[2] : max[2]]);
  }
  return corners;
}

/**
 * Inflate a box outward by `fraction` of *each axis's own* span (not the largest overall dimension —
 * padding a thin axis by a fraction of some other, larger axis risks the two padded faces on that thin
 * axis overlapping, which reads as "grabs the wrong side" instead of "hard to select"). Hit-testing
 * against the raw box requires the cursor to land exactly on an infinitely-thin face plane, which reads
 * as sluggish/hard-to-select - this widens the target without changing the box actually drawn or the
 * value written into `cropping`. A tiny floor (a small fraction of the largest overall dimension, well
 * below any legitimate per-axis pad) only exists to keep a fully-collapsed axis from getting a
 * literally-zero pad - it's deliberately too small to noticeably affect a real (nonzero) thin axis, so
 * it doesn't reintroduce the cross-axis-overlap problem this function exists to avoid.
 */
export function padBox(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
  fraction: number,
): { min: [number, number, number]; max: [number, number, number] } {
  const overall = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const floor = overall * 1e-4;
  const outMin: [number, number, number] = [0, 0, 0];
  const outMax: [number, number, number] = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const span = max[a]! - min[a]!;
    const pad = Math.max(span * fraction, floor, 1e-6);
    outMin[a] = min[a]! - pad;
    outMax[a] = max[a]! + pad;
  }
  return { min: outMin, max: outMax };
}

/** The 12 edges of a box, as pairs of `boxCorners()` indices (differ in exactly one bit). */
export const BOX_EDGES: readonly [number, number][] = [
  [0, 1], [2, 3], [4, 5], [6, 7], // x-direction edges
  [0, 2], [1, 3], [4, 6], [5, 7], // y-direction edges
  [0, 4], [1, 5], [2, 6], [3, 7], // z-direction edges
];

/** Project a world point through `viewProj` into CSS-pixel screen coordinates, or `null` when it's
 * behind the camera (w <= 0) — the caller should skip drawing edges with a null endpoint. */
export function worldToScreen(
  viewProj: Mat4,
  x: number, y: number, z: number,
  width: number, height: number,
): [number, number] | null {
  const [cx, cy, , cw] = mulMat4Vec4(viewProj, x, y, z, 1);
  if (cw <= 1e-6) return null;
  const ndcX = cx / cw;
  const ndcY = cy / cw;
  // NOTE: Y sign empirically matched to observed on-screen behavior (see the comment at this
  // function's call site in WebGpuVolumeViewer.ts) rather than derived from a documented NDC
  // convention - the volume shader's own ray reconstruction deliberately bypasses viewProj (a
  // documented float32-precision workaround), so there was no in-codebase precedent for which Y sign
  // this Mat4's clip-space actually uses once projected forward (non-inverted) through mulMat4Vec4.
  return [(ndcX * 0.5 + 0.5) * width, (ndcY * 0.5 + 0.5) * height];
}

/** A face hit: which axis/side of the box, the ray distance, and the world-space hit point. */
export interface CropFaceHit {
  axis: CropFaceAxis;
  side: "min" | "max";
  t: number;
  point: [number, number, number];
}

/** World-space AABB of the crop box, derived from UVW `cropMin`/`cropMax` and the volume's sim size —
 * the same `val = u*size - size/2` convention `roi-geometry.ts`'s `toU` inverts. */
export function cropWorldBox(
  cropMin: readonly [number, number, number],
  cropMax: readonly [number, number, number],
  sizeSim: { x: number; y: number; z: number },
): { min: [number, number, number]; max: [number, number, number] } {
  const size: [number, number, number] = [sizeSim.x, sizeSim.y, sizeSim.z];
  const toWorld = (u: number, a: number): number => u * size[a]! - size[a]! * 0.5;
  return {
    min: [toWorld(cropMin[0], 0), toWorld(cropMin[1], 1), toWorld(cropMin[2], 2)],
    max: [toWorld(cropMax[0], 0), toWorld(cropMax[1], 1), toWorld(cropMax[2], 2)],
  };
}

/**
 * Ray ∩ box, reporting the near-hit face (axis + which side) instead of just `[tNear, tFar]` — the
 * slab method (as in `roi-geometry.ts`'s `intersectRoiBox`), extended to track which axis/side
 * produced `tNear`. Returns `null` when the ray misses the box entirely (or the box is entirely
 * behind the ray origin).
 */
export function intersectCropFaces(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  boxMin: readonly [number, number, number],
  boxMax: readonly [number, number, number],
): CropFaceHit | null {
  const o: readonly [number, number, number] = [ox, oy, oz];
  const d: readonly [number, number, number] = [dx, dy, dz];
  let tNear = -Infinity;
  let tFar = Infinity;
  let hitAxis: CropFaceAxis = 0;
  let hitSide: "min" | "max" = "min";
  for (let axis = 0; axis < 3; axis++) {
    const a = axis as CropFaceAxis;
    const inv = 1 / (d[a] === 0 ? 1e-20 : d[a]);
    let t0 = (boxMin[a] - o[a]) * inv;
    let t1 = (boxMax[a] - o[a]) * inv;
    let side0: "min" | "max" = "min";
    let side1: "min" | "max" = "max";
    if (t0 > t1) {
      [t0, t1] = [t1, t0];
      [side0, side1] = [side1, side0];
    }
    if (t0 > tNear) {
      tNear = t0;
      hitAxis = a;
      hitSide = side0;
    }
    if (t1 < tFar) tFar = t1;
  }
  if (tNear > tFar || tFar < 0) return null;
  const t = Math.max(tNear, 0);
  return {
    axis: hitAxis,
    side: hitSide,
    t,
    point: [ox + dx * t, oy + dy * t, oz + dz * t],
  };
}

/**
 * How the dragged axis itself looks on screen right now: a 2D unit direction (which way "+1 world
 * unit along the axis" moves on screen) and a world-units-per-screen-pixel scale along that direction.
 * `null` when the axis projects to a single point on screen (camera looking straight down it - no
 * screen direction to follow).
 *
 * This is deliberately screen-space, not a 3D ray-plane intersection: two earlier versions of this
 * drag (tilting a plane by the camera's right vector, then by its forward vector with an up-vector
 * fallback) both still came out feeling inverted or degenerate on some axis in practice, because a
 * ray-plane intersection's *apparent* mouse-to-axis mapping direction is a non-obvious function of the
 * plane's tilt and the current view angle — it's very easy for the "geometrically correct" ray-plane
 * result to feel backwards. Measuring how the axis actually projects to the screen (via `worldToScreen`
 * — the exact function the wireframe box itself is drawn with, so this is *guaranteed* to agree with
 * what's on screen) and directly following the mouse along that 2D direction has no such failure mode:
 * whichever way the axis visibly points on screen is the way dragging moves it, by construction.
 */
export function axisScreenProjection(
  viewProj: Mat4,
  anchor: readonly [number, number, number],
  axis: CropFaceAxis,
  width: number,
  height: number,
): { dir: [number, number]; worldPerPixel: number } | null {
  const step = 1e-3; // small world-space probe step; recomputed fresh every frame from the live camera
  const p0 = worldToScreen(viewProj, anchor[0], anchor[1], anchor[2], width, height);
  const probe: [number, number, number] = [anchor[0], anchor[1], anchor[2]];
  probe[axis] += step;
  const p1 = worldToScreen(viewProj, probe[0], probe[1], probe[2], width, height);
  if (!p0 || !p1) return null;
  const ddx = p1[0] - p0[0];
  const ddy = p1[1] - p0[1];
  const screenLen = Math.hypot(ddx, ddy);
  if (screenLen < 1e-6) return null; // axis is edge-on to the screen right now
  return { dir: [ddx / screenLen, ddy / screenLen], worldPerPixel: step / screenLen };
}

/**
 * Where a dragged face should move to along its own axis, given how far the mouse has moved on screen
 * since the drag started. Projects the screen-space mouse delta onto the axis's own screen direction
 * (from `axisScreenProjection`) and converts to world units — see that function's doc comment for why
 * this screen-space technique replaced an earlier 3D ray-plane approach.
 */
export function dragFaceScreenDelta(
  projection: { dir: readonly [number, number]; worldPerPixel: number },
  anchorWorldCoord: number,
  startScreen: readonly [number, number],
  currentScreen: readonly [number, number],
): number {
  const dx = currentScreen[0] - startScreen[0];
  const dy = currentScreen[1] - startScreen[1];
  const pixelsAlongAxis = dx * projection.dir[0] + dy * projection.dir[1];
  return anchorWorldCoord + pixelsAlongAxis * projection.worldPerPixel;
}
