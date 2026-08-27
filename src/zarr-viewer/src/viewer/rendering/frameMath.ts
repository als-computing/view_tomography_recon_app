/**
 * Pure per-frame render-loop math: camera basis extraction, the near/far bracket around the volume
 * box, the measure-plane's world depth, the edge-ruler scale, and TAAU's sub-pixel jitter projection.
 * No GPU calls, no closure state — every input (including scratch matrices) is passed in explicitly,
 * mirroring the render loop's own allocation-free style.
 *
 * @packageDocumentation
 */

import type { Mat4 } from "@zarr-viewer/math";
import { niceFloor125 } from "../util.js";

export interface CameraBasis {
  readonly right: [number, number, number];
  readonly up: [number, number, number];
  readonly forward: [number, number, number];
}

/**
 * Camera world-space right/up/forward, normalized, from a Mat4's column-major `elements`. The
 * camera looks down its local -Z, so forward = -(world Z axis) = -(column 2).
 */
export function computeCameraBasis(wm: ArrayLike<number>): CameraBasis {
  let fx = -wm[8]!, fy = -wm[9]!, fz = -wm[10]!;
  const flen = Math.hypot(fx, fy, fz) || 1;
  fx /= flen;
  fy /= flen;
  fz /= flen;
  const rlen = Math.hypot(wm[0]!, wm[1]!, wm[2]!) || 1;
  const ulen = Math.hypot(wm[4]!, wm[5]!, wm[6]!) || 1;
  return {
    forward: [fx, fy, fz],
    right: [wm[0]! / rlen, wm[1]! / rlen, wm[2]! / rlen],
    up: [wm[4]! / ulen, wm[5]! / ulen, wm[6]! / ulen],
  };
}

export interface NearFar {
  readonly near: number;
  readonly far: number;
  readonly centerDepth: number;
  readonly extent: number;
  /** Half the box's projected depth along the view axis — also the measure plane's half-thickness. */
  readonly halfDepth: number;
}

/**
 * Near/far planes bracketing the volume box's center along the view axis, sized from its actual
 * projected depth (not the bounding sphere) so the near/far ratio stays float32-stable at any
 * zoom/orientation. See the render loop's inline comments for the full rationale — this is the fix
 * for both thin-slab near-clipping and far-zoom-out precision collapse.
 */
export function computeNearFar(
  sizeSim: { x: number; y: number; z: number },
  cameraPosition: { x: number; y: number; z: number },
  forward: readonly [number, number, number],
): NearFar {
  const extent = Math.max(sizeSim.x, sizeSim.y, sizeSim.z) || 1;
  const [fx, fy, fz] = forward;
  const centerDepth = -(cameraPosition.x * fx + cameraPosition.y * fy + cameraPosition.z * fz);
  const halfDepth = 0.5 * (sizeSim.x * Math.abs(fx) + sizeSim.y * Math.abs(fy) + sizeSim.z * Math.abs(fz));
  const margin = Math.max(halfDepth * 1.25 + extent * 0.02, centerDepth * 0.05);
  const far = Math.max(centerDepth + margin, margin * 2);
  const near = Math.max(centerDepth - margin, far * 0.002);
  return { near, far, centerDepth, extent, halfDepth };
}

/**
 * World depth (along the view axis) of the measure plane: `measureDepthFraction` (0=front face,
 * 1=back face) interpolated across the box's actual depth footprint, clamped so the front face
 * never goes in front of `near` (usable when the eye is inside the volume).
 */
export function computeMeasurePlaneDepth(
  centerDepth: number,
  halfDepth: number,
  near: number,
  measureDepthFraction: number,
): number {
  const frontDepth = Math.max(centerDepth - halfDepth, near);
  const backDepth = Math.max(centerDepth + halfDepth, frontDepth + 1e-6);
  const planeT = Math.min(1, Math.max(0, measureDepthFraction));
  return frontDepth + planeT * (backDepth - frontDepth);
}

export interface Ruler {
  majorPx: number;
  minorPerMajor: number;
  majorValue: number;
  unitLabel: string;
}

/**
 * Edge-ruler scale: world units per CSS pixel at the calibration depth (the measure-plane depth
 * when it's on, else the orbit-pivot distance), snapped to a "nice" 1/2/5·10ⁿ major-tick value with
 * an ~80px major spacing. `null` when the depth/height inputs are degenerate (nothing to calibrate
 * against yet, e.g. before the first layout pass).
 */
export function computeRuler(params: {
  measureDist: number;
  fovY: number;
  cssHeight: number;
  /** Convert a world-space (sim-unit) length per pixel to the display unit per pixel. */
  worldPerPxToDisplay: (worldPerPx: number) => number;
  unitSymbol: string;
}): Ruler | null {
  const { measureDist, fovY, cssHeight, worldPerPxToDisplay, unitSymbol } = params;
  if (!(cssHeight > 0 && Number.isFinite(measureDist) && measureDist > 0)) return null;
  const worldPerPx = (2 * measureDist * Math.tan(fovY / 2)) / cssHeight;
  const dispPerPx = worldPerPxToDisplay(worldPerPx);
  if (!(Number.isFinite(dispPerPx) && dispPerPx > 0)) return null;
  const majorValue = niceFloor125(dispPerPx * 80);
  return { majorPx: majorValue / dispPerPx, minorPerMajor: 5, majorValue, unitLabel: unitSymbol };
}

/**
 * Write a sub-pixel-jittered projection × view into `jitterViewProj` (via scratch `jitterProj`),
 * for TAAU's supersampling accumulation. Mutates both scratch matrices in place — the same
 * allocation-free reuse pattern as the rest of the per-frame render path.
 */
export function applyTaauJitter(
  jitterProj: Mat4,
  jitterViewProj: Mat4,
  proj: Mat4,
  view: Mat4,
  jitterPx: readonly [number, number],
  rw: number,
  rh: number,
): void {
  const [jx, jy] = jitterPx;
  jitterProj.copy(proj);
  jitterProj.elements[8]! += (2 * jx) / rw;
  jitterProj.elements[9]! += (2 * jy) / rh;
  jitterViewProj.multiplyMatrices(jitterProj, view);
}
