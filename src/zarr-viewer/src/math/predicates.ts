/**
 * Geometric orientation predicates computed with compensated (error-free-transform) arithmetic, so
 * the **sign** is reliable even for nearly-degenerate configurations where the naive floating-point
 * determinant flips. Orientation tests underpin convex hull, Delaunay/mesh construction, point-in-
 * polygon, and winding/consistency checks.
 *
 * These use Kahan-style compensated determinants (exact products via {@link twoProduct}, corrections
 * carried through the sums). They are far more robust than the naive determinant and exact when the
 * coordinate differences are representable; they are not a full multi-stage Shewchuk adaptive
 * expansion, so at the exact degeneracy boundary they degrade gracefully to ~0 rather than
 * guaranteeing the last-bit sign.
 *
 * @packageDocumentation
 */

import type { Vec3Like } from "./vec3.js";
import { twoProduct, twoSum } from "./summation.js";

/** Anything with numeric `x`, `y`. */
export interface Point2Like {
  x: number;
  y: number;
}

/** Compensated `p·q − r·s` (accurate 2×2 determinant). */
function det2(p: number, q: number, r: number, s: number): number {
  const [x, xe] = twoProduct(p, q);
  const [y, ye] = twoProduct(r, s);
  const [hi, he] = twoSum(x, -y);
  return hi + (he + (xe - ye));
}

/**
 * Twice the signed area of triangle `(a, b, c)`. `> 0` if `a→b→c` winds counter-clockwise, `< 0`
 * clockwise, `≈ 0` collinear.
 */
export function orient2d(a: Point2Like, b: Point2Like, c: Point2Like): number {
  return det2(a.x - c.x, b.y - c.y, a.y - c.y, b.x - c.x);
}

/**
 * Six times the signed volume of tetrahedron `(a, b, c, d)`. `> 0` if `d` is below the plane of
 * `a,b,c` (with `a→b→c` counter-clockwise viewed from above), `< 0` above, `≈ 0` coplanar.
 * Evaluated by cofactor expansion using compensated 2×2 minors.
 */
export function orient3d(a: Vec3Like, b: Vec3Like, c: Vec3Like, d: Vec3Like): number {
  const adx = a.x - d.x;
  const ady = a.y - d.y;
  const adz = a.z - d.z;
  const bdx = b.x - d.x;
  const bdy = b.y - d.y;
  const bdz = b.z - d.z;
  const cdx = c.x - d.x;
  const cdy = c.y - d.y;
  const cdz = c.z - d.z;

  // det | adx ady adz ; bdx bdy bdz ; cdx cdy cdz |
  const m1 = det2(bdy, cdz, bdz, cdy); // bdy·cdz − bdz·cdy
  const m2 = det2(bdz, cdx, bdx, cdz); // bdz·cdx − bdx·cdz
  const m3 = det2(bdx, cdy, bdy, cdx); // bdx·cdy − bdy·cdx

  // adx·m1 + ady·m2 + adz·m3, accumulated compensated.
  const [p1, e1] = twoProduct(adx, m1);
  const [p2, e2] = twoProduct(ady, m2);
  const [p3, e3] = twoProduct(adz, m3);
  const [s1, se1] = twoSum(p1, p2);
  const [s2, se2] = twoSum(s1, p3);
  return s2 + (se2 + se1 + e1 + e2 + e3);
}
