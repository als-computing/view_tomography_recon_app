/**
 * Pure ray/AABB geometry for the ROI brick streaming subsystem: whether a crop box is active, the
 * ray/volume-box intersection, view-ray reconstruction from NDC, and the focal-region AABB the
 * viewer streams a high-res brick for. No DOM, no GPU calls, no mutable viewer state — every input
 * (including scratch matrices) is passed in explicitly.
 *
 * @packageDocumentation
 */

import type { Mat4 } from "@zarr-viewer/math";
import { mulMat4Vec4 } from "../util.js";

// ROI brick sizing (UVW [0,1]). The on-screen frustum at the first-hit is only ~10% of XY when
// zoomed in — too small a patch. We widen the frustum, extrude into the volume, and pad; if the
// box no longer fits L0, the caller (updateRoi) shrinks it.
const ROI_VIEW_SCALE = 1.75; // NDC corner scale (>1 fetches around the viewport)
const ROI_DEPTH_UVW = 0.38; // UVW-length into the volume from the near face along the view
const ROI_PAD = 0.35; // extra fraction of the AABB on each side
const ROI_MIN_SPAN = 0.18; // minimum UVW span per axis

/** `true` when the crop box excludes any part of the volume (i.e. isn't the full `[0,1]^3`). */
export function cropIsSet(
  cropMin: readonly [number, number, number],
  cropMax: readonly [number, number, number],
): boolean {
  return (
    cropMin[0] > 0.001 ||
    cropMin[1] > 0.001 ||
    cropMin[2] > 0.001 ||
    cropMax[0] < 0.999 ||
    cropMax[1] < 0.999 ||
    cropMax[2] < 0.999
  );
}

/** Ray ∩ volume box `[-h, h]`; returns `[tNear, tFar]` or `null`. */
export function intersectRoiBox(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  hx: number, hy: number, hz: number,
): [number, number] | null {
  const invx = 1 / (dx === 0 ? 1e-20 : dx);
  const invy = 1 / (dy === 0 ? 1e-20 : dy);
  const invz = 1 / (dz === 0 ? 1e-20 : dz);
  let a0 = (-hx - ox) * invx; let a1 = (hx - ox) * invx; if (a0 > a1) [a0, a1] = [a1, a0];
  let b0 = (-hy - oy) * invy; let b1 = (hy - oy) * invy; if (b0 > b1) [b0, b1] = [b1, b0];
  let c0 = (-hz - oz) * invz; let c1 = (hz - oz) * invz; if (c0 > c1) [c0, c1] = [c1, c0];
  const tN = Math.max(a0, b0, c0);
  const tF = Math.min(a1, b1, c1);
  if (tN > tF || tF < 0) return null;
  return [tN, tF];
}

/** Ray direction (world, normalized) through NDC `(nx, ny)` using the given inverse view-proj. */
export function rayDir(invViewProj: Mat4, nx: number, ny: number): [number, number, number] {
  const nearH = mulMat4Vec4(invViewProj, nx, ny, 0, 1);
  const farH = mulMat4Vec4(invViewProj, nx, ny, 1, 1);
  const nw = nearH[3] || 1e-12; // guard a degenerate (w=0) homogeneous divide
  const fw = farH[3] || 1e-12;
  const ax = nearH[0] / nw, ay = nearH[1] / nw, az = nearH[2] / nw;
  const bx = farH[0] / fw, by = farH[1] / fw, bz = farH[2] / fw;
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const dl = Math.hypot(dx, dy, dz) || 1;
  return [dx / dl, dy / dl, dz / dl];
}

/**
 * Focal-region AABB in UVW `[0,1]`. Starts at the volume ENTRY along the view (closest to the
 * camera) and extrudes inward. Probe-centered placement put the near face inside the sample, so
 * the high-res region started too far from the camera. If the generous box is too big for a finer
 * level, the caller shrinks it. No view-ray hit → no ROI.
 *
 * `invViewProj` is a scratch matrix: this function overwrites it with `lastViewProj`'s inverse (the
 * same allocation-free reuse pattern as the rest of the per-frame render path).
 */
export function focalRoiUvw(
  invViewProj: Mat4,
  lastViewProj: Mat4,
  sizeSim: { x: number; y: number; z: number },
  eye: { x: number; y: number; z: number },
): { min: [number, number, number]; max: [number, number, number] } | null {
  invViewProj.copy(lastViewProj);
  if (!invViewProj.invert()) return null;
  const hx = sizeSim.x * 0.5, hy = sizeSim.y * 0.5, hz = sizeSim.z * 0.5;
  const [ccx, ccy, ccz] = rayDir(invViewProj, 0, 0);
  const hit = intersectRoiBox(eye.x, eye.y, eye.z, ccx, ccy, ccz, hx, hy, hz);
  if (!hit) return null;
  const tNear = Math.max(hit[0], 0);
  const tFar = hit[1];
  if (tFar < tNear) return null;

  const toU = (val: number, h: number): number => Math.min(1, Math.max(0, (val + h) / (2 * h)));
  const vu = ccx / (2 * hx), vv = ccy / (2 * hy), vw = ccz / (2 * hz);
  const vLen = Math.hypot(vu, vv, vw) || 1;
  const tStart = tNear;
  const tEnd = Math.min(tFar, tStart + ROI_DEPTH_UVW / vLen);
  const tMid = (tStart + tEnd) * 0.5;
  const fx = Math.min(hx, Math.max(-hx, eye.x + ccx * tMid));
  const fy = Math.min(hy, Math.max(-hy, eye.y + ccy * tMid));
  const fz = Math.min(hz, Math.max(-hz, eye.z + ccz * tMid));

  let mnu = 1, mnv = 1, mnw = 1;
  let mxu = 0, mxv = 0, mxw = 0;
  const add = (x: number, y: number, z: number): void => {
    const u = toU(x, hx), v = toU(y, hy), w = toU(z, hz);
    mnu = Math.min(mnu, u); mxu = Math.max(mxu, u);
    mnv = Math.min(mnv, v); mxv = Math.max(mxv, v);
    mnw = Math.min(mnw, w); mxw = Math.max(mxw, w);
  };
  add(fx, fy, fz);
  for (const t of [tStart, tMid, tEnd]) {
    for (const [su, sv] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
      const [dx, dy, dz] = rayDir(
        invViewProj,
        (su * 2 - 1) * ROI_VIEW_SCALE,
        ((1 - sv) * 2 - 1) * ROI_VIEW_SCALE,
      );
      add(eye.x + dx * t, eye.y + dy * t, eye.z + dz * t);
    }
  }
  const padU = (mxu - mnu) * ROI_PAD, padV = (mxv - mnv) * ROI_PAD, padW = (mxw - mnw) * ROI_PAD;
  mnu -= padU; mxu += padU;
  mnv -= padV; mxv += padV;
  mnw -= padW; mxw += padW;
  const fu = toU(fx, hx), fv = toU(fy, hy), fw = toU(fz, hz);
  const grow = (mn: number, mx: number, f: number): [number, number] => {
    if (mx - mn >= ROI_MIN_SPAN) return [mn, mx];
    return [f - ROI_MIN_SPAN * 0.5, f + ROI_MIN_SPAN * 0.5];
  };
  [mnu, mxu] = grow(mnu, mxu, fu);
  [mnv, mxv] = grow(mnv, mxv, fv);
  [mnw, mxw] = grow(mnw, mxw, fw);
  return {
    min: [Math.max(0, mnu), Math.max(0, mnv), Math.max(0, mnw)],
    max: [Math.min(1, mxu), Math.min(1, mxv), Math.min(1, mxw)],
  };
}
