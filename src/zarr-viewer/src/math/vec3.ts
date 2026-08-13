/**
 * A 3-component vector.
 *
 * The API follows a familiar in-place convention: instance methods mutate `this` and return it for
 * chaining (allocation-free), while `static` methods take an explicit `out` destination for hot
 * loops where mutating an operand is undesirable.
 *
 * @packageDocumentation
 */

import type { Mat3 } from "./mat3.js";
import type { Mat4 } from "./mat4.js";
import type { Quat } from "./quat.js";
import { clamp as clampScalar, EPSILON } from "./scalar.js";

/** Anything with numeric `x`, `y`, `z` fields — accepted by most {@link Vec3} methods. */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/**
 * A mutable 3D vector backed by plain `number` fields (monomorphic and JIT-friendly).
 *
 * @example
 * ```ts
 * const v = new Vec3(1, 2, 3).add(new Vec3(0, 1, 0)).normalize();
 * const dist = v.distanceTo(Vec3.zero());
 * ```
 */
export class Vec3 implements Vec3Like {
  public x: number;
  public y: number;
  public z: number;

  /** Create a vector `(x, y, z)`, defaulting to the origin `(0, 0, 0)`. */
  public constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  // ---- factories ----------------------------------------------------------

  /** A new zero vector `(0, 0, 0)`. */
  public static zero(): Vec3 {
    return new Vec3(0, 0, 0);
  }

  /** A new vector with all components set to `1`. */
  public static one(): Vec3 {
    return new Vec3(1, 1, 1);
  }

  /** Unit vector along +X. */
  public static unitX(): Vec3 {
    return new Vec3(1, 0, 0);
  }

  /** Unit vector along +Y. */
  public static unitY(): Vec3 {
    return new Vec3(0, 1, 0);
  }

  /** Unit vector along +Z. */
  public static unitZ(): Vec3 {
    return new Vec3(0, 0, 1);
  }

  /** Create from an array-like at `offset`. */
  public static fromArray(array: ArrayLike<number>, offset = 0): Vec3 {
    return new Vec3(array[offset]!, array[offset + 1]!, array[offset + 2]!);
  }

  // ---- basic mutation -----------------------------------------------------

  /** Set all three components. */
  public set(x: number, y: number, z: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  /** Set all three components to `s`. */
  public setScalar(s: number): this {
    this.x = s;
    this.y = s;
    this.z = s;
    return this;
  }

  /** Copy components from `v`. */
  public copy(v: Vec3Like): this {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  }

  /** Allocate a copy of this vector. */
  public clone(): Vec3 {
    return new Vec3(this.x, this.y, this.z);
  }

  // ---- arithmetic (in place) ---------------------------------------------

  /** Add `v` to this vector. */
  public add(v: Vec3Like): this {
    this.x += v.x;
    this.y += v.y;
    this.z += v.z;
    return this;
  }

  /** Add scalar `s` to each component. */
  public addScalar(s: number): this {
    this.x += s;
    this.y += s;
    this.z += s;
    return this;
  }

  /** Add `v * s` to this vector (fused multiply-add; the workhorse of integrators). */
  public addScaledVector(v: Vec3Like, s: number): this {
    this.x += v.x * s;
    this.y += v.y * s;
    this.z += v.z * s;
    return this;
  }

  /** Subtract `v` from this vector. */
  public sub(v: Vec3Like): this {
    this.x -= v.x;
    this.y -= v.y;
    this.z -= v.z;
    return this;
  }

  /** Component-wise multiply by `v`. */
  public multiply(v: Vec3Like): this {
    this.x *= v.x;
    this.y *= v.y;
    this.z *= v.z;
    return this;
  }

  /** Multiply each component by scalar `s`. */
  public multiplyScalar(s: number): this {
    this.x *= s;
    this.y *= s;
    this.z *= s;
    return this;
  }

  /** Component-wise divide by `v`. */
  public divide(v: Vec3Like): this {
    this.x /= v.x;
    this.y /= v.y;
    this.z /= v.z;
    return this;
  }

  /** Divide each component by scalar `s`. */
  public divideScalar(s: number): this {
    return this.multiplyScalar(1 / s);
  }

  /** Negate all components. */
  public negate(): this {
    this.x = -this.x;
    this.y = -this.y;
    this.z = -this.z;
    return this;
  }

  // ---- products & length --------------------------------------------------

  /** Dot product with `v`. */
  public dot(v: Vec3Like): number {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }

  /** Set this vector to the cross product `a x b`. */
  public crossVectors(a: Vec3Like, b: Vec3Like): this {
    const ax = a.x;
    const ay = a.y;
    const az = a.z;
    const bx = b.x;
    const by = b.y;
    const bz = b.z;
    this.x = ay * bz - az * by;
    this.y = az * bx - ax * bz;
    this.z = ax * by - ay * bx;
    return this;
  }

  /** Cross this vector with `v` in place (`this = this x v`). */
  public cross(v: Vec3Like): this {
    return this.crossVectors(this, v);
  }

  /** Euclidean length (magnitude). */
  public length(): number {
    return Math.hypot(this.x, this.y, this.z);
  }

  /** Squared length (cheaper than {@link length}; use for comparisons). */
  public lengthSq(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }

  /** Distance to `v`. */
  public distanceTo(v: Vec3Like): number {
    return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z);
  }

  /** Squared distance to `v`. */
  public distanceToSq(v: Vec3Like): number {
    const dx = this.x - v.x;
    const dy = this.y - v.y;
    const dz = this.z - v.z;
    return dx * dx + dy * dy + dz * dz;
  }

  /** Normalize to unit length. A zero-length vector is left unchanged. */
  public normalize(): this {
    const len = this.length();
    return len > 0 ? this.multiplyScalar(1 / len) : this;
  }

  /** Scale to the given length (normalizes first). */
  public setLength(length: number): this {
    return this.normalize().multiplyScalar(length);
  }

  /** Clamp this vector's length into `[min, max]`. */
  public clampLength(min: number, max: number): this {
    const len = this.length();
    if (len === 0) return this;
    return this.multiplyScalar(clampScalar(len, min, max) / len);
  }

  // ---- interpolation & bounds --------------------------------------------

  /** Linearly interpolate toward `v` by `t`. */
  public lerp(v: Vec3Like, t: number): this {
    this.x += (v.x - this.x) * t;
    this.y += (v.y - this.y) * t;
    this.z += (v.z - this.z) * t;
    return this;
  }

  /** Component-wise minimum with `v`. */
  public min(v: Vec3Like): this {
    this.x = Math.min(this.x, v.x);
    this.y = Math.min(this.y, v.y);
    this.z = Math.min(this.z, v.z);
    return this;
  }

  /** Component-wise maximum with `v`. */
  public max(v: Vec3Like): this {
    this.x = Math.max(this.x, v.x);
    this.y = Math.max(this.y, v.y);
    this.z = Math.max(this.z, v.z);
    return this;
  }

  /** Component-wise clamp into `[min, max]`. */
  public clamp(min: Vec3Like, max: Vec3Like): this {
    this.x = clampScalar(this.x, min.x, max.x);
    this.y = clampScalar(this.y, min.y, max.y);
    this.z = clampScalar(this.z, min.z, max.z);
    return this;
  }

  // ---- geometry -----------------------------------------------------------

  /** Angle in radians between this vector and `v`. */
  public angleTo(v: Vec3Like): number {
    const denom = Math.sqrt(this.lengthSq() * (v.x * v.x + v.y * v.y + v.z * v.z));
    if (denom === 0) return Math.PI / 2;
    return Math.acos(clampScalar(this.dot(v) / denom, -1, 1));
  }

  /** Reflect this vector about a unit-length `normal` (in place). */
  public reflect(normal: Vec3Like): this {
    const d = 2 * this.dot(normal);
    this.x -= d * normal.x;
    this.y -= d * normal.y;
    this.z -= d * normal.z;
    return this;
  }

  /** Project this vector onto `v` (in place). */
  public projectOnto(v: Vec3Like): this {
    const denom = v.x * v.x + v.y * v.y + v.z * v.z;
    if (denom === 0) return this.set(0, 0, 0);
    const scalar = this.dot(v) / denom;
    return this.set(v.x * scalar, v.y * scalar, v.z * scalar);
  }

  // ---- transforms ---------------------------------------------------------

  /**
   * Transform as a point by a column-major 4x4 matrix, including translation and the perspective
   * divide.
   */
  public applyMat4(m: Mat4): this {
    const e = m.elements;
    const { x, y, z } = this;
    const w = e[3]! * x + e[7]! * y + e[11]! * z + e[15]!;
    const invW = w === 0 ? 1 : 1 / w;
    this.x = (e[0]! * x + e[4]! * y + e[8]! * z + e[12]!) * invW;
    this.y = (e[1]! * x + e[5]! * y + e[9]! * z + e[13]!) * invW;
    this.z = (e[2]! * x + e[6]! * y + e[10]! * z + e[14]!) * invW;
    return this;
  }

  /** Transform as a direction by a 4x4 matrix (ignores translation) and renormalize. */
  public transformDirection(m: Mat4): this {
    const e = m.elements;
    const { x, y, z } = this;
    this.x = e[0]! * x + e[4]! * y + e[8]! * z;
    this.y = e[1]! * x + e[5]! * y + e[9]! * z;
    this.z = e[2]! * x + e[6]! * y + e[10]! * z;
    return this.normalize();
  }

  /** Transform by a column-major 3x3 matrix. */
  public applyMat3(m: Mat3): this {
    const e = m.elements;
    const { x, y, z } = this;
    this.x = e[0]! * x + e[3]! * y + e[6]! * z;
    this.y = e[1]! * x + e[4]! * y + e[7]! * z;
    this.z = e[2]! * x + e[5]! * y + e[8]! * z;
    return this;
  }

  /** Rotate this vector by a unit quaternion. */
  public applyQuat(q: Quat): this {
    const { x, y, z } = this;
    const qx = q.x;
    const qy = q.y;
    const qz = q.z;
    const qw = q.w;
    // t = 2 * cross(q.xyz, v)
    const tx = 2 * (qy * z - qz * y);
    const ty = 2 * (qz * x - qx * z);
    const tz = 2 * (qx * y - qy * x);
    // v + qw * t + cross(q.xyz, t)
    this.x = x + qw * tx + (qy * tz - qz * ty);
    this.y = y + qw * ty + (qz * tx - qx * tz);
    this.z = z + qw * tz + (qx * ty - qy * tx);
    return this;
  }

  // ---- comparison & serialization ----------------------------------------

  /** Exact component equality. */
  public equals(v: Vec3Like): boolean {
    return this.x === v.x && this.y === v.y && this.z === v.z;
  }

  /** Approximate equality within `tolerance`. */
  public approxEquals(v: Vec3Like, tolerance: number = EPSILON): boolean {
    return (
      Math.abs(this.x - v.x) <= tolerance &&
      Math.abs(this.y - v.y) <= tolerance &&
      Math.abs(this.z - v.z) <= tolerance
    );
  }

  /** Whether any component is `NaN`. */
  public isNaN(): boolean {
    return Number.isNaN(this.x) || Number.isNaN(this.y) || Number.isNaN(this.z);
  }

  /** Write components into `array` at `offset` and return it. */
  public toArray<T extends { [index: number]: number }>(array: T, offset = 0): T {
    array[offset] = this.x;
    array[offset + 1] = this.y;
    array[offset + 2] = this.z;
    return array;
  }

  // ---- static out-parameter forms ----------------------------------------

  /** `out = a + b`. */
  public static add(out: Vec3, a: Vec3Like, b: Vec3Like): Vec3 {
    out.x = a.x + b.x;
    out.y = a.y + b.y;
    out.z = a.z + b.z;
    return out;
  }

  /** `out = a - b`. */
  public static sub(out: Vec3, a: Vec3Like, b: Vec3Like): Vec3 {
    out.x = a.x - b.x;
    out.y = a.y - b.y;
    out.z = a.z - b.z;
    return out;
  }

  /** `out = a x b`. */
  public static cross(out: Vec3, a: Vec3Like, b: Vec3Like): Vec3 {
    return out.crossVectors(a, b);
  }

  /** `out = a * s`. */
  public static scale(out: Vec3, a: Vec3Like, s: number): Vec3 {
    out.x = a.x * s;
    out.y = a.y * s;
    out.z = a.z * s;
    return out;
  }

  /** `out = a + b * s` (fused multiply-add; the workhorse of integrators). */
  public static addScaled(out: Vec3, a: Vec3Like, b: Vec3Like, s: number): Vec3 {
    out.x = a.x + b.x * s;
    out.y = a.y + b.y * s;
    out.z = a.z + b.z * s;
    return out;
  }

  /** `out = a * b` (component-wise). */
  public static multiply(out: Vec3, a: Vec3Like, b: Vec3Like): Vec3 {
    out.x = a.x * b.x;
    out.y = a.y * b.y;
    out.z = a.z * b.z;
    return out;
  }

  /** `out = -a`. */
  public static negate(out: Vec3, a: Vec3Like): Vec3 {
    out.x = -a.x;
    out.y = -a.y;
    out.z = -a.z;
    return out;
  }

  /** `out = a / |a|` (unit vector; `a` copied unchanged when zero-length). */
  public static normalize(out: Vec3, a: Vec3Like): Vec3 {
    const len = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
    if (len === 0) {
      out.x = a.x;
      out.y = a.y;
      out.z = a.z;
      return out;
    }
    const inv = 1 / len;
    out.x = a.x * inv;
    out.y = a.y * inv;
    out.z = a.z * inv;
    return out;
  }

  /** `out = componentwise min(a, b)`. */
  public static min(out: Vec3, a: Vec3Like, b: Vec3Like): Vec3 {
    out.x = a.x < b.x ? a.x : b.x;
    out.y = a.y < b.y ? a.y : b.y;
    out.z = a.z < b.z ? a.z : b.z;
    return out;
  }

  /** `out = componentwise max(a, b)`. */
  public static max(out: Vec3, a: Vec3Like, b: Vec3Like): Vec3 {
    out.x = a.x > b.x ? a.x : b.x;
    out.y = a.y > b.y ? a.y : b.y;
    out.z = a.z > b.z ? a.z : b.z;
    return out;
  }

  /** `out = lerp(a, b, t)`. */
  public static lerp(out: Vec3, a: Vec3Like, b: Vec3Like, t: number): Vec3 {
    out.x = a.x + (b.x - a.x) * t;
    out.y = a.y + (b.y - a.y) * t;
    out.z = a.z + (b.z - a.z) * t;
    return out;
  }

  /** Dot product of two vector-likes. */
  public static dot(a: Vec3Like, b: Vec3Like): number {
    return a.x * b.x + a.y * b.y + a.z * b.z;
  }

  /** Distance between two vector-likes. */
  public static distance(a: Vec3Like, b: Vec3Like): number {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  }

  /** Squared distance between two vector-likes (cheaper than {@link Vec3.distance}). */
  public static distanceSq(a: Vec3Like, b: Vec3Like): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return dx * dx + dy * dy + dz * dz;
  }
}
