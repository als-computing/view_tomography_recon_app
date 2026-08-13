/**
 * A 4-component vector, commonly used for homogeneous coordinates, RGBA colors, and shader data.
 *
 * @packageDocumentation
 */

import type { Mat4 } from "./mat4.js";
import { EPSILON } from "./scalar.js";

/** Anything with numeric `x`, `y`, `z`, `w` fields. */
export interface Vec4Like {
  x: number;
  y: number;
  z: number;
  w: number;
}

/**
 * A mutable 4D vector.
 *
 * @example
 * ```ts
 * const color = new Vec4(1, 0.5, 0.25, 1); // RGBA
 * ```
 */
export class Vec4 implements Vec4Like {
  public x: number;
  public y: number;
  public z: number;
  public w: number;

  /** Create a vector `(x, y, z, w)`, defaulting to `(0, 0, 0, 0)`. */
  public constructor(x = 0, y = 0, z = 0, w = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
  }

  /** A new zero vector. */
  public static zero(): Vec4 {
    return new Vec4(0, 0, 0, 0);
  }

  /** Create from an array-like at `offset`. */
  public static fromArray(array: ArrayLike<number>, offset = 0): Vec4 {
    return new Vec4(array[offset]!, array[offset + 1]!, array[offset + 2]!, array[offset + 3]!);
  }

  /** Set all four components. */
  public set(x: number, y: number, z: number, w: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
    return this;
  }

  /** Copy from `v`. */
  public copy(v: Vec4Like): this {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    this.w = v.w;
    return this;
  }

  /** Allocate a copy. */
  public clone(): Vec4 {
    return new Vec4(this.x, this.y, this.z, this.w);
  }

  /** Add `v`. */
  public add(v: Vec4Like): this {
    this.x += v.x;
    this.y += v.y;
    this.z += v.z;
    this.w += v.w;
    return this;
  }

  /** Subtract `v`. */
  public sub(v: Vec4Like): this {
    this.x -= v.x;
    this.y -= v.y;
    this.z -= v.z;
    this.w -= v.w;
    return this;
  }

  /** Multiply by scalar `s`. */
  public multiplyScalar(s: number): this {
    this.x *= s;
    this.y *= s;
    this.z *= s;
    this.w *= s;
    return this;
  }

  /** Dot product. */
  public dot(v: Vec4Like): number {
    return this.x * v.x + this.y * v.y + this.z * v.z + this.w * v.w;
  }

  /** Length. */
  public length(): number {
    return Math.hypot(this.x, this.y, this.z, this.w);
  }

  /** Squared length. */
  public lengthSq(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w;
  }

  /** Normalize to unit length (zero-length left unchanged). */
  public normalize(): this {
    const len = this.length();
    return len > 0 ? this.multiplyScalar(1 / len) : this;
  }

  /** Linearly interpolate toward `v` by `t`. */
  public lerp(v: Vec4Like, t: number): this {
    this.x += (v.x - this.x) * t;
    this.y += (v.y - this.y) * t;
    this.z += (v.z - this.z) * t;
    this.w += (v.w - this.w) * t;
    return this;
  }

  /** Transform by a column-major 4x4 matrix (full homogeneous transform, no divide). */
  public applyMat4(m: Mat4): this {
    const e = m.elements;
    const { x, y, z, w } = this;
    this.x = e[0]! * x + e[4]! * y + e[8]! * z + e[12]! * w;
    this.y = e[1]! * x + e[5]! * y + e[9]! * z + e[13]! * w;
    this.z = e[2]! * x + e[6]! * y + e[10]! * z + e[14]! * w;
    this.w = e[3]! * x + e[7]! * y + e[11]! * z + e[15]! * w;
    return this;
  }

  /** Exact equality. */
  public equals(v: Vec4Like): boolean {
    return this.x === v.x && this.y === v.y && this.z === v.z && this.w === v.w;
  }

  /** Approximate equality within `tolerance`. */
  public approxEquals(v: Vec4Like, tolerance: number = EPSILON): boolean {
    return (
      Math.abs(this.x - v.x) <= tolerance &&
      Math.abs(this.y - v.y) <= tolerance &&
      Math.abs(this.z - v.z) <= tolerance &&
      Math.abs(this.w - v.w) <= tolerance
    );
  }

  /** Write into `array` at `offset`. */
  public toArray<T extends { [index: number]: number }>(array: T, offset = 0): T {
    array[offset] = this.x;
    array[offset + 1] = this.y;
    array[offset + 2] = this.z;
    array[offset + 3] = this.w;
    return array;
  }

  // ---- static out-parameter forms ----------------------------------------

  /** `out = a + b`. */
  public static add(out: Vec4, a: Vec4Like, b: Vec4Like): Vec4 {
    out.x = a.x + b.x;
    out.y = a.y + b.y;
    out.z = a.z + b.z;
    out.w = a.w + b.w;
    return out;
  }

  /** `out = a - b`. */
  public static sub(out: Vec4, a: Vec4Like, b: Vec4Like): Vec4 {
    out.x = a.x - b.x;
    out.y = a.y - b.y;
    out.z = a.z - b.z;
    out.w = a.w - b.w;
    return out;
  }

  /** `out = a * s`. */
  public static scale(out: Vec4, a: Vec4Like, s: number): Vec4 {
    out.x = a.x * s;
    out.y = a.y * s;
    out.z = a.z * s;
    out.w = a.w * s;
    return out;
  }

  /** `out = lerp(a, b, t)`. */
  public static lerp(out: Vec4, a: Vec4Like, b: Vec4Like, t: number): Vec4 {
    out.x = a.x + (b.x - a.x) * t;
    out.y = a.y + (b.y - a.y) * t;
    out.z = a.z + (b.z - a.z) * t;
    out.w = a.w + (b.w - a.w) * t;
    return out;
  }

  /** Dot product of two vector-likes. */
  public static dot(a: Vec4Like, b: Vec4Like): number {
    return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  }
}
