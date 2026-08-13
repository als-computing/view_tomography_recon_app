/**
 * A unit quaternion representing 3D rotation. Stored as `(x, y, z, w)` with `w` the scalar part.
 *
 * @packageDocumentation
 */

import type { Mat4 } from "./mat4.js";
import type { Vec3Like } from "./vec3.js";
import { clamp, EPSILON } from "./scalar.js";

/** Anything with numeric `x`, `y`, `z`, `w` fields. */
export interface QuatLike {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Euler rotation orders supported by {@link Quat.setFromEuler}. */
export type EulerOrder = "XYZ" | "YXZ" | "ZXY" | "ZYX" | "YZX" | "XZY";

/**
 * A quaternion. Defaults to the identity rotation `(0, 0, 0, 1)`.
 *
 * @example
 * ```ts
 * const q = new Quat().setFromAxisAngle(Vec3.unitY(), Math.PI / 2);
 * const v = new Vec3(1, 0, 0).applyQuat(q); // ~ (0, 0, -1)
 * ```
 */
export class Quat implements QuatLike {
  public x: number;
  public y: number;
  public z: number;
  public w: number;

  /** Create a quaternion `(x, y, z, w)`, defaulting to the identity rotation `(0, 0, 0, 1)`. */
  public constructor(x = 0, y = 0, z = 0, w = 1) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
  }

  /** A new identity quaternion. */
  public static identity(): Quat {
    return new Quat(0, 0, 0, 1);
  }

  /** Set all components. */
  public set(x: number, y: number, z: number, w: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
    return this;
  }

  /** Reset to the identity rotation. */
  public setIdentity(): this {
    return this.set(0, 0, 0, 1);
  }

  /** Copy from `q`. */
  public copy(q: QuatLike): this {
    this.x = q.x;
    this.y = q.y;
    this.z = q.z;
    this.w = q.w;
    return this;
  }

  /** Allocate a copy. */
  public clone(): Quat {
    return new Quat(this.x, this.y, this.z, this.w);
  }

  /** Set from a unit `axis` and `angle` (radians). */
  public setFromAxisAngle(axis: Vec3Like, angle: number): this {
    const half = angle / 2;
    const s = Math.sin(half);
    this.x = axis.x * s;
    this.y = axis.y * s;
    this.z = axis.z * s;
    this.w = Math.cos(half);
    return this;
  }

  /** Set from Euler angles (radians) in the given `order` (default `XYZ`). */
  public setFromEuler(x: number, y: number, z: number, order: EulerOrder = "XYZ"): this {
    const c1 = Math.cos(x / 2);
    const c2 = Math.cos(y / 2);
    const c3 = Math.cos(z / 2);
    const s1 = Math.sin(x / 2);
    const s2 = Math.sin(y / 2);
    const s3 = Math.sin(z / 2);

    switch (order) {
      case "XYZ":
        this.x = s1 * c2 * c3 + c1 * s2 * s3;
        this.y = c1 * s2 * c3 - s1 * c2 * s3;
        this.z = c1 * c2 * s3 + s1 * s2 * c3;
        this.w = c1 * c2 * c3 - s1 * s2 * s3;
        break;
      case "YXZ":
        this.x = s1 * c2 * c3 + c1 * s2 * s3;
        this.y = c1 * s2 * c3 - s1 * c2 * s3;
        this.z = c1 * c2 * s3 - s1 * s2 * c3;
        this.w = c1 * c2 * c3 + s1 * s2 * s3;
        break;
      case "ZXY":
        this.x = s1 * c2 * c3 - c1 * s2 * s3;
        this.y = c1 * s2 * c3 + s1 * c2 * s3;
        this.z = c1 * c2 * s3 + s1 * s2 * c3;
        this.w = c1 * c2 * c3 - s1 * s2 * s3;
        break;
      case "ZYX":
        this.x = s1 * c2 * c3 - c1 * s2 * s3;
        this.y = c1 * s2 * c3 + s1 * c2 * s3;
        this.z = c1 * c2 * s3 - s1 * s2 * c3;
        this.w = c1 * c2 * c3 + s1 * s2 * s3;
        break;
      case "YZX":
        this.x = s1 * c2 * c3 + c1 * s2 * s3;
        this.y = c1 * s2 * c3 + s1 * c2 * s3;
        this.z = c1 * c2 * s3 - s1 * s2 * c3;
        this.w = c1 * c2 * c3 - s1 * s2 * s3;
        break;
      case "XZY":
        this.x = s1 * c2 * c3 - c1 * s2 * s3;
        this.y = c1 * s2 * c3 - s1 * c2 * s3;
        this.z = c1 * c2 * s3 + s1 * s2 * c3;
        this.w = c1 * c2 * c3 + s1 * s2 * s3;
        break;
    }
    return this;
  }

  /** Set from the rotation part of a column-major 4x4 matrix (assumed orthonormal). */
  public setFromRotationMatrix(m: Mat4): this {
    const e = m.elements;
    const m11 = e[0]!;
    const m22 = e[5]!;
    const m33 = e[10]!;
    const trace = m11 + m22 + m33;

    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1);
      this.w = 0.25 / s;
      this.x = (e[6]! - e[9]!) * s;
      this.y = (e[8]! - e[2]!) * s;
      this.z = (e[1]! - e[4]!) * s;
    } else if (m11 > m22 && m11 > m33) {
      const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
      this.w = (e[6]! - e[9]!) / s;
      this.x = 0.25 * s;
      this.y = (e[4]! + e[1]!) / s;
      this.z = (e[8]! + e[2]!) / s;
    } else if (m22 > m33) {
      const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
      this.w = (e[8]! - e[2]!) / s;
      this.x = (e[4]! + e[1]!) / s;
      this.y = 0.25 * s;
      this.z = (e[9]! + e[6]!) / s;
    } else {
      const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
      this.w = (e[1]! - e[4]!) / s;
      this.x = (e[8]! + e[2]!) / s;
      this.y = (e[9]! + e[6]!) / s;
      this.z = 0.25 * s;
    }
    return this;
  }

  /** Dot product with `q`. */
  public dot(q: QuatLike): number {
    return this.x * q.x + this.y * q.y + this.z * q.z + this.w * q.w;
  }

  /** Magnitude. */
  public length(): number {
    return Math.hypot(this.x, this.y, this.z, this.w);
  }

  /** Normalize to unit length (falls back to identity if degenerate). */
  public normalize(): this {
    const len = this.length();
    if (len === 0) return this.setIdentity();
    const inv = 1 / len;
    this.x *= inv;
    this.y *= inv;
    this.z *= inv;
    this.w *= inv;
    return this;
  }

  /** Conjugate (inverse for a unit quaternion): negate the vector part. */
  public conjugate(): this {
    this.x = -this.x;
    this.y = -this.y;
    this.z = -this.z;
    return this;
  }

  /** Set this quaternion to the Hamilton product `a * b`. */
  public multiplyQuaternions(a: QuatLike, b: QuatLike): this {
    const ax = a.x;
    const ay = a.y;
    const az = a.z;
    const aw = a.w;
    const bx = b.x;
    const by = b.y;
    const bz = b.z;
    const bw = b.w;
    this.x = aw * bx + ax * bw + ay * bz - az * by;
    this.y = aw * by - ax * bz + ay * bw + az * bx;
    this.z = aw * bz + ax * by - ay * bx + az * bw;
    this.w = aw * bw - ax * bx - ay * by - az * bz;
    return this;
  }

  /** Right-multiply this quaternion by `q` (`this = this * q`). */
  public multiply(q: QuatLike): this {
    return this.multiplyQuaternions(this, q);
  }

  /** Premultiply this quaternion by `q` (`this = q * this`). */
  public premultiply(q: QuatLike): this {
    return this.multiplyQuaternions(q, this);
  }

  /** Spherically interpolate toward `q` by `t` in place. */
  public slerp(q: QuatLike, t: number): this {
    if (t === 0) return this;
    if (t === 1) return this.copy(q);

    let cosHalfTheta = this.dot(q);
    let qx = q.x;
    let qy = q.y;
    let qz = q.z;
    let qw = q.w;

    // Take the shorter arc.
    if (cosHalfTheta < 0) {
      cosHalfTheta = -cosHalfTheta;
      qx = -qx;
      qy = -qy;
      qz = -qz;
      qw = -qw;
    }

    if (cosHalfTheta >= 1) {
      // Quaternions are nearly identical; nlerp fallback.
      return this;
    }

    const sinHalfTheta = Math.sqrt(1 - cosHalfTheta * cosHalfTheta);
    if (sinHalfTheta < EPSILON) {
      // Linear fallback near 180 degrees.
      this.x = 0.5 * (this.x + qx);
      this.y = 0.5 * (this.y + qy);
      this.z = 0.5 * (this.z + qz);
      this.w = 0.5 * (this.w + qw);
      return this.normalize();
    }

    const halfTheta = Math.atan2(sinHalfTheta, cosHalfTheta);
    const ratioA = Math.sin((1 - t) * halfTheta) / sinHalfTheta;
    const ratioB = Math.sin(t * halfTheta) / sinHalfTheta;

    this.x = this.x * ratioA + qx * ratioB;
    this.y = this.y * ratioA + qy * ratioB;
    this.z = this.z * ratioA + qz * ratioB;
    this.w = this.w * ratioA + qw * ratioB;
    return this;
  }

  /** Angle (radians) between this rotation and `q`. */
  public angleTo(q: QuatLike): number {
    return 2 * Math.acos(clamp(Math.abs(this.dot(q)), -1, 1));
  }

  /**
   * General inverse `q⁻¹ = conjugate(q) / |q|²`. Equivalent to {@link conjugate} for a unit
   * quaternion, but correct for non-unit quaternions too.
   */
  public invert(): this {
    const lenSq = this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w;
    if (lenSq === 0) return this;
    const inv = 1 / lenSq;
    this.x = -this.x * inv;
    this.y = -this.y * inv;
    this.z = -this.z * inv;
    this.w = this.w * inv;
    return this;
  }

  /**
   * Set this to the shortest-arc rotation taking unit vector `from` onto unit vector `to`. Handles
   * the antiparallel case (180°) by choosing an arbitrary orthogonal axis.
   */
  public setFromUnitVectors(from: Vec3Like, to: Vec3Like): this {
    let r = from.x * to.x + from.y * to.y + from.z * to.z + 1;
    if (r < EPSILON) {
      // `from` and `to` are opposite; rotate 180° about any orthogonal axis.
      r = 0;
      if (Math.abs(from.x) > Math.abs(from.z)) {
        this.x = -from.y;
        this.y = from.x;
        this.z = 0;
      } else {
        this.x = 0;
        this.y = -from.z;
        this.z = from.y;
      }
    } else {
      this.x = from.y * to.z - from.z * to.y;
      this.y = from.z * to.x - from.x * to.z;
      this.z = from.x * to.y - from.y * to.x;
    }
    this.w = r;
    return this.normalize();
  }

  /** Rotate at most `maxRadians` toward `q` (a clamped {@link slerp} for smooth steering). */
  public rotateTowards(q: QuatLike, maxRadians: number): this {
    const angle = this.angleTo(q);
    if (angle === 0) return this;
    return this.slerp(q, Math.min(1, maxRadians / angle));
  }

  /**
   * Quaternion logarithm. For a unit quaternion the result is the pure quaternion `(θ·axis, 0)` whose
   * vector part is the rotation's scaled axis (half the rotation vector). Building block for
   * {@link pow} and {@link Quat.squadSetup}.
   */
  public log(): this {
    const vLen = Math.hypot(this.x, this.y, this.z);
    const qLen = this.length();
    const lnLen = Math.log(qLen || 1);
    if (vLen < EPSILON) {
      this.x = 0;
      this.y = 0;
      this.z = 0;
      this.w = lnLen;
      return this;
    }
    const angle = Math.acos(clamp(this.w / (qLen || 1), -1, 1));
    const s = angle / vLen;
    this.x *= s;
    this.y *= s;
    this.z *= s;
    this.w = lnLen;
    return this;
  }

  /** Quaternion exponential (inverse of {@link log}); maps a pure quaternion back to a rotation. */
  public exp(): this {
    const vLen = Math.hypot(this.x, this.y, this.z);
    const ew = Math.exp(this.w);
    if (vLen < EPSILON) {
      this.x = 0;
      this.y = 0;
      this.z = 0;
      this.w = ew;
      return this;
    }
    const s = (ew * Math.sin(vLen)) / vLen;
    this.x *= s;
    this.y *= s;
    this.z *= s;
    this.w = ew * Math.cos(vLen);
    return this;
  }

  /** Raise this (unit) quaternion to the real power `t`: `qᵗ = exp(t·log q)`. */
  public pow(t: number): this {
    this.log();
    this.x *= t;
    this.y *= t;
    this.z *= t;
    this.w *= t;
    return this.exp();
  }

  /**
   * Integrate a world-frame angular velocity `ω` (rad/s) over `dt`, advancing this orientation via
   * `q ← normalize(q + ½·(ω,0)⊗q·dt)`. The first-order update physics uses to spin rigid bodies.
   */
  public integrate(angularVelocity: Vec3Like, dt: number): this {
    const wx = angularVelocity.x;
    const wy = angularVelocity.y;
    const wz = angularVelocity.z;
    const { x, y, z, w } = this;
    // (ω, 0) ⊗ q
    const dx = 0.5 * (wx * w + wy * z - wz * y);
    const dy = 0.5 * (-wx * z + wy * w + wz * x);
    const dz = 0.5 * (wx * y - wy * x + wz * w);
    const dw = 0.5 * (-wx * x - wy * y - wz * z);
    this.x = x + dx * dt;
    this.y = y + dy * dt;
    this.z = z + dz * dt;
    this.w = w + dw * dt;
    return this.normalize();
  }

  /** Exact equality. */
  public equals(q: QuatLike): boolean {
    return this.x === q.x && this.y === q.y && this.z === q.z && this.w === q.w;
  }

  /** Approximate equality within `tolerance` (accounts for double-cover sign). */
  public approxEquals(q: QuatLike, tolerance: number = EPSILON): boolean {
    return 1 - Math.abs(this.dot(q)) <= tolerance;
  }

  /** Write into `array` at `offset`. */
  public toArray<T extends { [index: number]: number }>(array: T, offset = 0): T {
    array[offset] = this.x;
    array[offset + 1] = this.y;
    array[offset + 2] = this.z;
    array[offset + 3] = this.w;
    return array;
  }

  /** `out = slerp(a, b, t)`. */
  public static slerp(out: Quat, a: QuatLike, b: QuatLike, t: number): Quat {
    return out.copy(a).slerp(b, t);
  }

  /** `out = a * b` (Hamilton product), safe even when `out` aliases `a` or `b`. */
  public static multiply(out: Quat, a: QuatLike, b: QuatLike): Quat {
    return out.multiplyQuaternions(a, b);
  }

  /**
   * Compute the intermediate SQUAD control quaternion for `cur` given its neighbors `prev`/`next`:
   * `s = cur · exp(−(log(cur⁻¹·next) + log(cur⁻¹·prev)) / 4)`. Feed the results as `s0`/`s1` to
   * {@link Quat.squad} for C¹-continuous (tangent-smooth) rotation splines.
   */
  public static squadSetup(out: Quat, prev: QuatLike, cur: QuatLike, next: QuatLike): Quat {
    const invCur = _sqInv.copy(cur).invert();
    const logNext = _sqA.multiplyQuaternions(invCur, next).log();
    const logPrev = _sqB.multiplyQuaternions(invCur, prev).log();
    _sqC.set(
      -(logNext.x + logPrev.x) / 4,
      -(logNext.y + logPrev.y) / 4,
      -(logNext.z + logPrev.z) / 4,
      -(logNext.w + logPrev.w) / 4,
    );
    _sqC.exp();
    return out.multiplyQuaternions(cur, _sqC);
  }

  /**
   * Spherical cubic ("SQUAD") interpolation between `q0` and `q1` using control quaternions
   * `s0`/`s1` (from {@link Quat.squadSetup}): `slerp(slerp(q0,q1,t), slerp(s0,s1,t), 2t(1−t))`.
   */
  public static squad(
    out: Quat,
    q0: QuatLike,
    s0: QuatLike,
    s1: QuatLike,
    q1: QuatLike,
    t: number,
  ): Quat {
    const a = Quat.slerp(_sqA, q0, q1, t);
    const b = Quat.slerp(_sqB, s0, s1, t);
    return Quat.slerp(out, a, b, 2 * t * (1 - t));
  }
}

// Module-local scratch for SQUAD (not re-entrant; single-threaded use only).
const _sqA = new Quat();
const _sqB = new Quat();
const _sqC = new Quat();
const _sqInv = new Quat();
