/**
 * A 2-component vector. Follows the same in-place-instance / static-out-parameter convention as
 * {@link Vec3}.
 *
 * @packageDocumentation
 */

import { clamp as clampScalar, EPSILON } from "./scalar.js";

/** Anything with numeric `x`, `y` fields. */
export interface Vec2Like {
  x: number;
  y: number;
}

/**
 * A mutable 2D vector.
 *
 * @example
 * ```ts
 * const p = new Vec2(3, 4);
 * p.length(); // 5
 * ```
 */
export class Vec2 implements Vec2Like {
  public x: number;
  public y: number;

  /** Create a vector `(x, y)`, defaulting to the origin `(0, 0)`. */
  public constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  /** A new zero vector. */
  public static zero(): Vec2 {
    return new Vec2(0, 0);
  }

  /** A new vector of ones. */
  public static one(): Vec2 {
    return new Vec2(1, 1);
  }

  /** Create from an array-like at `offset`. */
  public static fromArray(array: ArrayLike<number>, offset = 0): Vec2 {
    return new Vec2(array[offset]!, array[offset + 1]!);
  }

  /** Set both components. */
  public set(x: number, y: number): this {
    this.x = x;
    this.y = y;
    return this;
  }

  /** Copy from `v`. */
  public copy(v: Vec2Like): this {
    this.x = v.x;
    this.y = v.y;
    return this;
  }

  /** Allocate a copy. */
  public clone(): Vec2 {
    return new Vec2(this.x, this.y);
  }

  /** Add `v`. */
  public add(v: Vec2Like): this {
    this.x += v.x;
    this.y += v.y;
    return this;
  }

  /** Add `v * s`. */
  public addScaledVector(v: Vec2Like, s: number): this {
    this.x += v.x * s;
    this.y += v.y * s;
    return this;
  }

  /** Subtract `v`. */
  public sub(v: Vec2Like): this {
    this.x -= v.x;
    this.y -= v.y;
    return this;
  }

  /** Multiply by scalar `s`. */
  public multiplyScalar(s: number): this {
    this.x *= s;
    this.y *= s;
    return this;
  }

  /** Divide by scalar `s`. */
  public divideScalar(s: number): this {
    return this.multiplyScalar(1 / s);
  }

  /** Negate. */
  public negate(): this {
    this.x = -this.x;
    this.y = -this.y;
    return this;
  }

  /** Dot product. */
  public dot(v: Vec2Like): number {
    return this.x * v.x + this.y * v.y;
  }

  /** 2D cross product (z-component of the 3D cross), i.e. the signed parallelogram area. */
  public cross(v: Vec2Like): number {
    return this.x * v.y - this.y * v.x;
  }

  /** Length. */
  public length(): number {
    return Math.hypot(this.x, this.y);
  }

  /** Squared length. */
  public lengthSq(): number {
    return this.x * this.x + this.y * this.y;
  }

  /** Distance to `v`. */
  public distanceTo(v: Vec2Like): number {
    return Math.hypot(this.x - v.x, this.y - v.y);
  }

  /** Normalize to unit length (zero-length left unchanged). */
  public normalize(): this {
    const len = this.length();
    return len > 0 ? this.multiplyScalar(1 / len) : this;
  }

  /** Angle of this vector from +X, in radians, in `(-pi, pi]`. */
  public angle(): number {
    return Math.atan2(this.y, this.x);
  }

  /** Rotate by `radians` about the origin. */
  public rotate(radians: number): this {
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    const { x, y } = this;
    this.x = x * c - y * s;
    this.y = x * s + y * c;
    return this;
  }

  /** Perpendicular vector (90 degrees CCW). */
  public perp(): this {
    const x = this.x;
    this.x = -this.y;
    this.y = x;
    return this;
  }

  /** Linearly interpolate toward `v` by `t`. */
  public lerp(v: Vec2Like, t: number): this {
    this.x += (v.x - this.x) * t;
    this.y += (v.y - this.y) * t;
    return this;
  }

  /** Component-wise clamp. */
  public clamp(min: Vec2Like, max: Vec2Like): this {
    this.x = clampScalar(this.x, min.x, max.x);
    this.y = clampScalar(this.y, min.y, max.y);
    return this;
  }

  /** Exact equality. */
  public equals(v: Vec2Like): boolean {
    return this.x === v.x && this.y === v.y;
  }

  /** Approximate equality within `tolerance`. */
  public approxEquals(v: Vec2Like, tolerance: number = EPSILON): boolean {
    return Math.abs(this.x - v.x) <= tolerance && Math.abs(this.y - v.y) <= tolerance;
  }

  /** Write into `array` at `offset`. */
  public toArray<T extends { [index: number]: number }>(array: T, offset = 0): T {
    array[offset] = this.x;
    array[offset + 1] = this.y;
    return array;
  }

  /** `out = a + b`. */
  public static add(out: Vec2, a: Vec2Like, b: Vec2Like): Vec2 {
    out.x = a.x + b.x;
    out.y = a.y + b.y;
    return out;
  }

  /** `out = a - b`. */
  public static sub(out: Vec2, a: Vec2Like, b: Vec2Like): Vec2 {
    out.x = a.x - b.x;
    out.y = a.y - b.y;
    return out;
  }

  /** `out = a * s`. */
  public static scale(out: Vec2, a: Vec2Like, s: number): Vec2 {
    out.x = a.x * s;
    out.y = a.y * s;
    return out;
  }

  /** `out = a + b * s` (fused multiply-add). */
  public static addScaled(out: Vec2, a: Vec2Like, b: Vec2Like, s: number): Vec2 {
    out.x = a.x + b.x * s;
    out.y = a.y + b.y * s;
    return out;
  }

  /** `out = -a`. */
  public static negate(out: Vec2, a: Vec2Like): Vec2 {
    out.x = -a.x;
    out.y = -a.y;
    return out;
  }

  /** `out = a / |a|` (unit vector; `a` copied unchanged when zero-length). */
  public static normalize(out: Vec2, a: Vec2Like): Vec2 {
    const len = Math.sqrt(a.x * a.x + a.y * a.y);
    if (len === 0) {
      out.x = a.x;
      out.y = a.y;
      return out;
    }
    const inv = 1 / len;
    out.x = a.x * inv;
    out.y = a.y * inv;
    return out;
  }

  /** `out = lerp(a, b, t)`. */
  public static lerp(out: Vec2, a: Vec2Like, b: Vec2Like, t: number): Vec2 {
    out.x = a.x + (b.x - a.x) * t;
    out.y = a.y + (b.y - a.y) * t;
    return out;
  }

  /** Dot product of two vector-likes. */
  public static dot(a: Vec2Like, b: Vec2Like): number {
    return a.x * b.x + a.y * b.y;
  }

  /** 2D cross product (signed parallelogram area) of two vector-likes. */
  public static cross(a: Vec2Like, b: Vec2Like): number {
    return a.x * b.y - a.y * b.x;
  }

  /** Distance between two vector-likes. */
  public static distance(a: Vec2Like, b: Vec2Like): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
}
