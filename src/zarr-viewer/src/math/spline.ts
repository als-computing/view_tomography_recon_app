/**
 * Spline evaluation for camera paths and animation: cubic Bezier, Catmull-Rom, and Hermite. All
 * write into an `out` vector to stay allocation-free.
 *
 * @packageDocumentation
 */

import type { Vec3, Vec3Like } from "./vec3.js";

/**
 * Evaluate a cubic Bezier at `t` in [0, 1] with control points `p0..p3`.
 *
 * @example
 * ```ts
 * cubicBezier(out, p0, p1, p2, p3, 0.5);
 * ```
 */
export function cubicBezier(
  out: Vec3,
  p0: Vec3Like,
  p1: Vec3Like,
  p2: Vec3Like,
  p3: Vec3Like,
  t: number,
): Vec3 {
  const u = 1 - t;
  const uu = u * u;
  const tt = t * t;
  const a = uu * u;
  const b = 3 * uu * t;
  const c = 3 * u * tt;
  const d = tt * t;
  out.x = a * p0.x + b * p1.x + c * p2.x + d * p3.x;
  out.y = a * p0.y + b * p1.y + c * p2.y + d * p3.y;
  out.z = a * p0.z + b * p1.z + c * p2.z + d * p3.z;
  return out;
}

/**
 * Evaluate a Catmull-Rom spline segment between `p1` and `p2` (with neighbors `p0`, `p3`) at `t`.
 * `tension` = 0.5 is the classic centripetal-ish uniform Catmull-Rom.
 */
export function catmullRom(
  out: Vec3,
  p0: Vec3Like,
  p1: Vec3Like,
  p2: Vec3Like,
  p3: Vec3Like,
  t: number,
  tension = 0.5,
): Vec3 {
  const t2 = t * t;
  const t3 = t2 * t;
  const evalComponent = (a: number, b: number, c: number, d: number): number => {
    const m1 = tension * (c - a);
    const m2 = tension * (d - b);
    return (
      (2 * b - 2 * c + m1 + m2) * t3 + (-3 * b + 3 * c - 2 * m1 - m2) * t2 + m1 * t + b
    );
  };
  out.x = evalComponent(p0.x, p1.x, p2.x, p3.x);
  out.y = evalComponent(p0.y, p1.y, p2.y, p3.y);
  out.z = evalComponent(p0.z, p1.z, p2.z, p3.z);
  return out;
}

/**
 * Evaluate a cubic Hermite segment from point `p0` (tangent `m0`) to point `p1` (tangent `m1`).
 */
export function hermite(
  out: Vec3,
  p0: Vec3Like,
  m0: Vec3Like,
  p1: Vec3Like,
  m1: Vec3Like,
  t: number,
): Vec3 {
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  out.x = h00 * p0.x + h10 * m0.x + h01 * p1.x + h11 * m1.x;
  out.y = h00 * p0.y + h10 * m0.y + h01 * p1.y + h11 * m1.y;
  out.z = h00 * p0.z + h10 * m0.z + h01 * p1.z + h11 * m1.z;
  return out;
}
