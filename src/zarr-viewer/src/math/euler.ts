/**
 * Euler angles (radians) with an explicit rotation order. Convenient for authoring; convert to
 * {@link Quat} for composition to avoid gimbal issues.
 *
 * @packageDocumentation
 */

import { Mat4 } from "./mat4.js";
import { Quat, type EulerOrder } from "./quat.js";
import { clamp } from "./scalar.js";

const scratchMat = new Mat4();

/**
 * Euler angles in radians.
 *
 * @example
 * ```ts
 * const e = new Euler(0, Math.PI / 2, 0, "XYZ");
 * const q = e.toQuat();
 * ```
 */
export class Euler {
  /** Create Euler angles (radians) about each axis, applied in `order` (default `XYZ`). */
  public constructor(
    public x = 0,
    public y = 0,
    public z = 0,
    public order: EulerOrder = "XYZ",
  ) {}

  /** Set all angles and (optionally) order. */
  public set(x: number, y: number, z: number, order: EulerOrder = this.order): this {
    this.x = x;
    this.y = y;
    this.z = z;
    this.order = order;
    return this;
  }

  /** Convert to a quaternion (allocates unless `out` provided). */
  public toQuat(out: Quat = new Quat()): Quat {
    return out.setFromEuler(this.x, this.y, this.z, this.order);
  }

  /** Set these angles from a unit quaternion, using this instance's `order`. */
  public setFromQuaternion(q: Quat, order: EulerOrder = this.order): this {
    scratchMat.makeRotationFromQuaternion(q);
    return this.setFromRotationMatrix(scratchMat, order);
  }

  /** Set these angles from the rotation part of a column-major 4x4 matrix. */
  public setFromRotationMatrix(m: Mat4, order: EulerOrder = this.order): this {
    const e = m.elements;
    const m11 = e[0]!;
    const m21 = e[1]!;
    const m31 = e[2]!;
    const m12 = e[4]!;
    const m22 = e[5]!;
    const m32 = e[6]!;
    const m13 = e[8]!;
    const m23 = e[9]!;
    const m33 = e[10]!;
    this.order = order;

    switch (order) {
      case "XYZ":
        this.y = Math.asin(clamp(m13, -1, 1));
        if (Math.abs(m13) < 0.9999999) {
          this.x = Math.atan2(-m23, m33);
          this.z = Math.atan2(-m12, m11);
        } else {
          this.x = Math.atan2(m32, m22);
          this.z = 0;
        }
        break;
      case "YXZ":
        this.x = Math.asin(-clamp(m23, -1, 1));
        if (Math.abs(m23) < 0.9999999) {
          this.y = Math.atan2(m13, m33);
          this.z = Math.atan2(m21, m22);
        } else {
          this.y = Math.atan2(-m31, m11);
          this.z = 0;
        }
        break;
      case "ZXY":
        this.x = Math.asin(clamp(m32, -1, 1));
        if (Math.abs(m32) < 0.9999999) {
          this.y = Math.atan2(-m31, m33);
          this.z = Math.atan2(-m12, m22);
        } else {
          this.y = 0;
          this.z = Math.atan2(m21, m11);
        }
        break;
      case "ZYX":
        this.y = Math.asin(-clamp(m31, -1, 1));
        if (Math.abs(m31) < 0.9999999) {
          this.x = Math.atan2(m32, m33);
          this.z = Math.atan2(m21, m11);
        } else {
          this.x = 0;
          this.z = Math.atan2(-m12, m22);
        }
        break;
      case "YZX":
        this.z = Math.asin(clamp(m21, -1, 1));
        if (Math.abs(m21) < 0.9999999) {
          this.x = Math.atan2(-m23, m22);
          this.y = Math.atan2(-m31, m11);
        } else {
          this.x = 0;
          this.y = Math.atan2(m13, m33);
        }
        break;
      case "XZY":
        this.z = Math.asin(-clamp(m12, -1, 1));
        if (Math.abs(m12) < 0.9999999) {
          this.x = Math.atan2(m32, m22);
          this.y = Math.atan2(m13, m11);
        } else {
          this.x = Math.atan2(-m23, m33);
          this.y = 0;
        }
        break;
    }
    return this;
  }
}
