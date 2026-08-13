/**
 * Geometric primitives and intersection tests: {@link Aabb}, {@link Sphere}, {@link Ray},
 * {@link Plane}, and {@link Frustum}. Used for bounds, picking, and culling.
 *
 * @packageDocumentation
 */

import type { Mat4 } from "./mat4.js";
import { Vec3, type Vec3Like } from "./vec3.js";
import { EPSILON } from "./scalar.js";

/** An axis-aligned bounding box defined by `min` and `max` corners. */
export class Aabb {
  public readonly min: Vec3;
  public readonly max: Vec3;

  /** Create a box from `min`/`max` corners; defaults to the empty (inverted-infinite) box. */
  public constructor(min?: Vec3, max?: Vec3) {
    this.min = min ?? new Vec3(Infinity, Infinity, Infinity);
    this.max = max ?? new Vec3(-Infinity, -Infinity, -Infinity);
  }

  /** Reset to the empty (inverted-infinite) box. */
  public makeEmpty(): this {
    this.min.set(Infinity, Infinity, Infinity);
    this.max.set(-Infinity, -Infinity, -Infinity);
    return this;
  }

  /** Whether the box is empty (no points). */
  public isEmpty(): boolean {
    return this.max.x < this.min.x || this.max.y < this.min.y || this.max.z < this.min.z;
  }

  /** Grow the box to include `point`. */
  public expandByPoint(point: Vec3Like): this {
    this.min.min(point);
    this.max.max(point);
    return this;
  }

  /** Build from an iterable of points. */
  public setFromPoints(points: Iterable<Vec3Like>): this {
    this.makeEmpty();
    for (const p of points) this.expandByPoint(p);
    return this;
  }

  /** Write the center into `out`. */
  public getCenter(out: Vec3): Vec3 {
    return Vec3.add(out, this.min, this.max).multiplyScalar(0.5);
  }

  /** Write the size (max - min) into `out`. */
  public getSize(out: Vec3): Vec3 {
    return Vec3.sub(out, this.max, this.min);
  }

  /**
   * Set this box from a center and full size (extent), both in the same coordinate space.
   * Useful for volume world bounds: `setFromCenterSize(origin, physicalSize)`.
   */
  public setFromCenterSize(center: Vec3Like, size: Vec3Like): this {
    const hx = size.x * 0.5;
    const hy = size.y * 0.5;
    const hz = size.z * 0.5;
    this.min.set(center.x - hx, center.y - hy, center.z - hz);
    this.max.set(center.x + hx, center.y + hy, center.z + hz);
    return this;
  }

  /** Whether `point` is inside (inclusive). */
  public containsPoint(point: Vec3Like): boolean {
    return (
      point.x >= this.min.x &&
      point.x <= this.max.x &&
      point.y >= this.min.y &&
      point.y <= this.max.y &&
      point.z >= this.min.z &&
      point.z <= this.max.z
    );
  }

  /** Whether this box overlaps `other`. */
  public intersectsAabb(other: Aabb): boolean {
    return (
      this.min.x <= other.max.x &&
      this.max.x >= other.min.x &&
      this.min.y <= other.max.y &&
      this.max.y >= other.min.y &&
      this.min.z <= other.max.z &&
      this.max.z >= other.min.z
    );
  }
}

/** A bounding sphere. */
export class Sphere {
  public readonly center: Vec3;
  public radius: number;

  /** Create a sphere from `center` and `radius` (default: origin, radius 0). */
  public constructor(center?: Vec3, radius = 0) {
    this.center = center ?? new Vec3();
    this.radius = radius;
  }

  /** Whether `point` is within the sphere (inclusive). */
  public containsPoint(point: Vec3Like): boolean {
    return this.center.distanceToSq(point) <= this.radius * this.radius;
  }

  /** Whether this sphere overlaps `other`. */
  public intersectsSphere(other: Sphere): boolean {
    const r = this.radius + other.radius;
    return this.center.distanceToSq(other.center) <= r * r;
  }
}

/** A ray with an origin and a (assumed unit) direction. */
export class Ray {
  public readonly origin: Vec3;
  public readonly direction: Vec3;

  /** Create a ray from `origin` and (assumed unit) `direction` (default: origin, looking down -Z). */
  public constructor(origin?: Vec3, direction?: Vec3) {
    this.origin = origin ?? new Vec3();
    this.direction = direction ?? new Vec3(0, 0, -1);
  }

  /** Point at parameter `t` along the ray, written into `out`. */
  public at(t: number, out: Vec3): Vec3 {
    return out.copy(this.direction).multiplyScalar(t).add(this.origin);
  }

  /** Nearest intersection distance with `sphere`, or `null` if none. */
  public intersectSphere(sphere: Sphere): number | null {
    const ox = this.origin.x - sphere.center.x;
    const oy = this.origin.y - sphere.center.y;
    const oz = this.origin.z - sphere.center.z;
    const dirDotOrigin = ox * this.direction.x + oy * this.direction.y + oz * this.direction.z;
    const c = ox * ox + oy * oy + oz * oz - sphere.radius * sphere.radius;
    const disc = dirDotOrigin * dirDotOrigin - c;
    if (disc < 0) return null;
    const sqrtDisc = Math.sqrt(disc);
    const t0 = -dirDotOrigin - sqrtDisc;
    const t1 = -dirDotOrigin + sqrtDisc;
    if (t0 >= 0) return t0;
    if (t1 >= 0) return t1;
    return null;
  }

  /** Nearest intersection distance with `box`, or `null` if none (slab method). */
  public intersectAabb(box: Aabb): number | null {
    const ox = this.origin.x;
    const oy = this.origin.y;
    const oz = this.origin.z;
    const dx = this.direction.x;
    const dy = this.direction.y;
    const dz = this.direction.z;
    const minX = box.min.x;
    const minY = box.min.y;
    const minZ = box.min.z;
    const maxX = box.max.x;
    const maxY = box.max.y;
    const maxZ = box.max.z;

    let tmin = -Infinity;
    let tmax = Infinity;

    // X slabs
    {
      const inv = 1 / dx;
      let t1 = (minX - ox) * inv;
      let t2 = (maxX - ox) * inv;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmax < tmin) return null;
    }
    // Y slabs
    {
      const inv = 1 / dy;
      let t1 = (minY - oy) * inv;
      let t2 = (maxY - oy) * inv;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmax < tmin) return null;
    }
    // Z slabs
    {
      const inv = 1 / dz;
      let t1 = (minZ - oz) * inv;
      let t2 = (maxZ - oz) * inv;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmax < tmin) return null;
    }

    if (tmax < 0) return null;
    return tmin >= 0 ? tmin : tmax;
  }

  /**
   * Nearest intersection distance with triangle `a,b,c` via the Möller–Trumbore algorithm, or
   * `null` if the ray misses (or hits behind the origin). Set `backfaceCull` to ignore triangles
   * whose winding faces away from the ray. The direction need not be unit; `t` is then in units of
   * the direction's length.
   */
  public intersectTriangle(
    a: Vec3Like,
    b: Vec3Like,
    c: Vec3Like,
    backfaceCull = false,
  ): number | null {
    const o = this.origin;
    const d = this.direction;
    const e1x = b.x - a.x;
    const e1y = b.y - a.y;
    const e1z = b.z - a.z;
    const e2x = c.x - a.x;
    const e2y = c.y - a.y;
    const e2z = c.z - a.z;
    // p = d × e2
    const px = d.y * e2z - d.z * e2y;
    const py = d.z * e2x - d.x * e2z;
    const pz = d.x * e2y - d.y * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (backfaceCull ? det < EPSILON : Math.abs(det) < EPSILON) return null;
    const invDet = 1 / det;
    const tx = o.x - a.x;
    const ty = o.y - a.y;
    const tz = o.z - a.z;
    const u = (tx * px + ty * py + tz * pz) * invDet;
    if (u < 0 || u > 1) return null;
    // q = t × e1
    const qx = ty * e1z - tz * e1y;
    const qy = tz * e1x - tx * e1z;
    const qz = tx * e1y - ty * e1x;
    const v = (d.x * qx + d.y * qy + d.z * qz) * invDet;
    if (v < 0 || u + v > 1) return null;
    const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
    return t >= 0 ? t : null;
  }
}

/**
 * Barycentric coordinates `(u, v, w)` of `p` with respect to triangle `a,b,c` (written into `out` as
 * `x=u, y=v, z=w`, so `p = u·a + v·b + w·c`). Uses Ericson's cached-dot-product form.
 */
export function barycentric(
  p: Vec3Like,
  a: Vec3Like,
  b: Vec3Like,
  c: Vec3Like,
  out: Vec3,
): Vec3 {
  const v0x = b.x - a.x;
  const v0y = b.y - a.y;
  const v0z = b.z - a.z;
  const v1x = c.x - a.x;
  const v1y = c.y - a.y;
  const v1z = c.z - a.z;
  const v2x = p.x - a.x;
  const v2y = p.y - a.y;
  const v2z = p.z - a.z;
  const d00 = v0x * v0x + v0y * v0y + v0z * v0z;
  const d01 = v0x * v1x + v0y * v1y + v0z * v1z;
  const d11 = v1x * v1x + v1y * v1y + v1z * v1z;
  const d20 = v2x * v0x + v2y * v0y + v2z * v0z;
  const d21 = v2x * v1x + v2y * v1y + v2z * v1z;
  const denom = d00 * d11 - d01 * d01;
  if (Math.abs(denom) < EPSILON) return out.set(1, 0, 0); // degenerate triangle
  const inv = 1 / denom;
  const v = (d11 * d20 - d01 * d21) * inv;
  const w = (d00 * d21 - d01 * d20) * inv;
  return out.set(1 - v - w, v, w);
}

/**
 * Closest point on segment `a→b` to `p`, written into `out`; returns the segment parameter
 * `t ∈ [0,1]` (`out = a + t·(b − a)`).
 */
export function closestPointOnSegment(p: Vec3Like, a: Vec3Like, b: Vec3Like, out: Vec3): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const lenSq = abx * abx + aby * aby + abz * abz;
  let t = lenSq > 0 ? ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / lenSq : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  out.set(a.x + abx * t, a.y + aby * t, a.z + abz * t);
  return t;
}

/** Closest point on (or in) `box` to `p`, written into `out` (component-wise clamp). */
export function closestPointOnAabb(p: Vec3Like, box: Aabb, out: Vec3): Vec3 {
  const cx = p.x < box.min.x ? box.min.x : p.x > box.max.x ? box.max.x : p.x;
  const cy = p.y < box.min.y ? box.min.y : p.y > box.max.y ? box.max.y : p.y;
  const cz = p.z < box.min.z ? box.min.z : p.z > box.max.z ? box.max.z : p.z;
  return out.set(cx, cy, cz);
}

/**
 * Closest point on triangle `a,b,c` to `p`, written into `out`. Handles all seven Voronoi regions
 * (vertices, edges, face) per Ericson, "Real-Time Collision Detection" §5.1.5.
 */
export function closestPointOnTriangle(
  p: Vec3Like,
  a: Vec3Like,
  b: Vec3Like,
  c: Vec3Like,
  out: Vec3,
): Vec3 {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const acx = c.x - a.x;
  const acy = c.y - a.y;
  const acz = c.z - a.z;
  const apx = p.x - a.x;
  const apy = p.y - a.y;
  const apz = p.z - a.z;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return out.set(a.x, a.y, a.z); // vertex A

  const bpx = p.x - b.x;
  const bpy = p.y - b.y;
  const bpz = p.z - b.z;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return out.set(b.x, b.y, b.z); // vertex B

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3); // edge AB
    return out.set(a.x + abx * v, a.y + aby * v, a.z + abz * v);
  }

  const cpx = p.x - c.x;
  const cpy = p.y - c.y;
  const cpz = p.z - c.z;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return out.set(c.x, c.y, c.z); // vertex C

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6); // edge AC
    return out.set(a.x + acx * w, a.y + acy * w, a.z + acz * w);
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6)); // edge BC
    return out.set(b.x + (c.x - b.x) * w, b.y + (c.y - b.y) * w, b.z + (c.z - b.z) * w);
  }

  // Interior: project onto the face via barycentric coordinates.
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return out.set(a.x + abx * v + acx * w, a.y + aby * v + acy * w, a.z + abz * v + acz * w);
}

/**
 * Closest points between segments `p1→q1` and `p2→q2`, written into `out1`/`out2`; returns the
 * squared distance between them. Handles parallel and degenerate (point) segments (Ericson §5.1.9).
 */
export function closestPointsBetweenSegments(
  p1: Vec3Like,
  q1: Vec3Like,
  p2: Vec3Like,
  q2: Vec3Like,
  out1: Vec3,
  out2: Vec3,
): number {
  const d1x = q1.x - p1.x;
  const d1y = q1.y - p1.y;
  const d1z = q1.z - p1.z;
  const d2x = q2.x - p2.x;
  const d2y = q2.y - p2.y;
  const d2z = q2.z - p2.z;
  const rx = p1.x - p2.x;
  const ry = p1.y - p2.y;
  const rz = p1.z - p2.z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;

  let s: number;
  let t: number;
  if (a <= EPSILON && e <= EPSILON) {
    s = 0;
    t = 0;
  } else if (a <= EPSILON) {
    s = 0;
    t = clampUnit(f / e);
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPSILON) {
      t = 0;
      s = clampUnit(-c / a);
    } else {
      const bb = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - bb * bb;
      s = denom > EPSILON ? clampUnit((bb * f - c * e) / denom) : 0;
      t = (bb * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clampUnit(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clampUnit((bb - c) / a);
      }
    }
  }

  const c1x = p1.x + d1x * s;
  const c1y = p1.y + d1y * s;
  const c1z = p1.z + d1z * s;
  const c2x = p2.x + d2x * t;
  const c2y = p2.y + d2y * t;
  const c2z = p2.z + d2z * t;
  out1.set(c1x, c1y, c1z);
  out2.set(c2x, c2y, c2z);
  const dx = c1x - c2x;
  const dy = c1y - c2y;
  const dz = c1z - c2z;
  return dx * dx + dy * dy + dz * dz;
}

function clampUnit(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** An infinite plane `normal . x + constant = 0` with a unit `normal`. */
export class Plane {
  public readonly normal: Vec3;
  public constant: number;

  /** Create a plane from a (unit) `normal` and `constant` (default: the `y = 0` ground plane). */
  public constructor(normal?: Vec3, constant = 0) {
    this.normal = normal ?? new Vec3(0, 1, 0);
    this.constant = constant;
  }

  /** Normalize the plane so `normal` is unit length. */
  public normalize(): this {
    const inv = 1 / this.normal.length();
    this.normal.multiplyScalar(inv);
    this.constant *= inv;
    return this;
  }

  /** Signed distance from `point` to the plane. */
  public distanceToPoint(point: Vec3Like): number {
    return this.normal.dot(point) + this.constant;
  }
}

/** A view frustum: six planes with inward-facing normals. */
export class Frustum {
  public readonly planes: readonly Plane[];

  /** Create a frustum with six default planes; populate via {@link Frustum.setFromProjectionMatrix}. */
  public constructor() {
    this.planes = [new Plane(), new Plane(), new Plane(), new Plane(), new Plane(), new Plane()];
  }

  /**
   * Extract the six frustum planes from a column-major view-projection matrix, assuming clip-space
   * depth in `[0, 1]` (WebGPU convention).
   */
  public setFromProjectionMatrix(m: Mat4): this {
    const e = m.elements;
    // Column-major rows: row r = [e[r], e[4+r], e[8+r], e[12+r]].
    const r00 = e[0]!;
    const r01 = e[4]!;
    const r02 = e[8]!;
    const r03 = e[12]!;
    const r10 = e[1]!;
    const r11 = e[5]!;
    const r12 = e[9]!;
    const r13 = e[13]!;
    const r20 = e[2]!;
    const r21 = e[6]!;
    const r22 = e[10]!;
    const r23 = e[14]!;
    const r30 = e[3]!;
    const r31 = e[7]!;
    const r32 = e[11]!;
    const r33 = e[15]!;
    const p = this.planes;

    const setPlane = (plane: Plane, a: number, b: number, c: number, d: number): void => {
      plane.normal.set(a, b, c);
      plane.constant = d;
      plane.normalize();
    };

    // left, right, bottom, top, near (row2), far (row3 - row2).
    setPlane(p[0]!, r30 + r00, r31 + r01, r32 + r02, r33 + r03);
    setPlane(p[1]!, r30 - r00, r31 - r01, r32 - r02, r33 - r03);
    setPlane(p[2]!, r30 + r10, r31 + r11, r32 + r12, r33 + r13);
    setPlane(p[3]!, r30 - r10, r31 - r11, r32 - r12, r33 - r13);
    setPlane(p[4]!, r20, r21, r22, r23);
    setPlane(p[5]!, r30 - r20, r31 - r21, r32 - r22, r33 - r23);
    return this;
  }

  /** Whether `point` lies inside all six planes. */
  public containsPoint(point: Vec3Like): boolean {
    for (const plane of this.planes) {
      if (plane.distanceToPoint(point) < 0) return false;
    }
    return true;
  }

  /** Whether `sphere` is at least partially inside the frustum. */
  public intersectsSphere(sphere: Sphere): boolean {
    for (const plane of this.planes) {
      if (plane.distanceToPoint(sphere.center) < -sphere.radius) return false;
    }
    return true;
  }

  /**
   * Whether `box` is at least partially inside the frustum (plane/AABB test using each plane's
   * positive vertex). Empty boxes are rejected.
   */
  public intersectsAabb(box: Aabb): boolean {
    if (box.isEmpty()) return false;
    for (const plane of this.planes) {
      const nx = plane.normal.x;
      const ny = plane.normal.y;
      const nz = plane.normal.z;
      // Positive vertex: the AABB corner farthest along the plane normal.
      const px = nx >= 0 ? box.max.x : box.min.x;
      const py = ny >= 0 ? box.max.y : box.min.y;
      const pz = nz >= 0 ? box.max.z : box.min.z;
      if (nx * px + ny * py + nz * pz + plane.constant < 0) return false;
    }
    return true;
  }
}
