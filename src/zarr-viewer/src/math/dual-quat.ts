/**
 * A unit dual quaternion representing a rigid transform (rotation + translation) as two
 * quaternions: a `real` part (the rotation) and a `dual` part (encoding the translation). Dual
 * quaternions compose rigid motions like quaternions compose rotations, and — unlike matrix or
 * separate quat+vector linear blending — they interpolate as screw motions, which is what makes
 * **dual-quaternion linear blend skinning** free of the candy-wrapper collapse that plagues LBS.
 *
 * @packageDocumentation
 */

import { Quat, type QuatLike } from "./quat.js";
import { Vec3, type Vec3Like } from "./vec3.js";

/**
 * A dual quaternion `real + ε·dual`. Defaults to the identity rigid transform.
 *
 * @example
 * ```ts
 * const dq = DualQuat.fromRotationTranslation(new DualQuat(), rotation, new Vec3(1, 2, 3));
 * const moved = dq.transformPoint(new Vec3(0, 0, 0), new Vec3()); // ~ (1, 2, 3)
 * ```
 */
export class DualQuat {
  /** Rotation part (unit quaternion). */
  public readonly real: Quat;
  /** Dual part (encodes translation). */
  public readonly dual: Quat;

  /** Create from `real`/`dual` parts (defaults to the identity transform). */
  public constructor(real?: Quat, dual?: Quat) {
    this.real = real ?? new Quat(0, 0, 0, 1);
    this.dual = dual ?? new Quat(0, 0, 0, 0);
  }

  /** Copy from `other`. */
  public copy(other: DualQuat): this {
    this.real.copy(other.real);
    this.dual.copy(other.dual);
    return this;
  }

  /** Allocate a copy. */
  public clone(): DualQuat {
    return new DualQuat(this.real.clone(), this.dual.clone());
  }

  /**
   * Set `out` from a rotation `q` (assumed unit) and a translation `t`:
   * `real = q`, `dual = ½·(t,0)⊗q`.
   */
  public static fromRotationTranslation(out: DualQuat, q: QuatLike, t: Vec3Like): DualQuat {
    out.real.copy(q);
    // dual = 0.5 * (tx,ty,tz,0) ⊗ q
    const tx = t.x;
    const ty = t.y;
    const tz = t.z;
    const { x, y, z, w } = q;
    out.dual.set(
      0.5 * (tx * w + ty * z - tz * y),
      0.5 * (-tx * z + ty * w + tz * x),
      0.5 * (tx * y - ty * x + tz * w),
      0.5 * (-tx * x - ty * y - tz * z),
    );
    return out;
  }

  /** Write the rotation part into `out`. */
  public getRotation(out: Quat): Quat {
    return out.copy(this.real);
  }

  /** Write the translation vector into `out`: `t = 2·(dual ⊗ real*)` (vector part). */
  public getTranslation(out: Vec3): Vec3 {
    const { x: rx, y: ry, z: rz, w: rw } = this.real;
    const { x: dx, y: dy, z: dz, w: dw } = this.dual;
    // dual ⊗ conjugate(real); conjugate negates the real vector part.
    const cx = -rx;
    const cy = -ry;
    const cz = -rz;
    const tx = dw * cx + dx * rw + dy * cz - dz * cy;
    const ty = dw * cy - dx * cz + dy * rw + dz * cx;
    const tz = dw * cz + dx * cy - dy * cx + dz * rw;
    return out.set(2 * tx, 2 * ty, 2 * tz);
  }

  /**
   * Compose two rigid transforms: `out = a · b` (apply `b` then `a`).
   * `real = aʳ·bʳ`, `dual = aʳ·bᵈ + aᵈ·bʳ`.
   */
  public static multiply(out: DualQuat, a: DualQuat, b: DualQuat): DualQuat {
    // real = a.real * b.real
    _q0.multiplyQuaternions(a.real, b.real);
    // dual = a.real * b.dual + a.dual * b.real
    _q1.multiplyQuaternions(a.real, b.dual);
    _q2.multiplyQuaternions(a.dual, b.real);
    out.real.copy(_q0);
    out.dual.set(_q1.x + _q2.x, _q1.y + _q2.y, _q1.z + _q2.z, _q1.w + _q2.w);
    return out;
  }

  /** Transform point `p` by this rigid motion, written into `out` (rotate then translate). */
  public transformPoint(p: Vec3Like, out: Vec3): Vec3 {
    out.set(p.x, p.y, p.z).applyQuat(this.real);
    this.getTranslation(_tv);
    return out.add(_tv);
  }

  /**
   * Normalize so the real part is unit length (dividing both parts by `|real|`). Required after
   * blending; the standard dual-quaternion linear-blend-skinning normalization.
   */
  public normalize(): this {
    const len = this.real.length();
    if (len === 0) return this;
    const inv = 1 / len;
    this.real.x *= inv;
    this.real.y *= inv;
    this.real.z *= inv;
    this.real.w *= inv;
    this.dual.x *= inv;
    this.dual.y *= inv;
    this.dual.z *= inv;
    this.dual.w *= inv;
    return this;
  }

  /**
   * Accumulate `s·other` into this dual quaternion (component-wise). For dual-quaternion linear
   * blend skinning: seed with zero, add each bone's weighted dual quaternion, then
   * {@link normalize}. Pass a `reference` (e.g. the first bone) to flip antipodal quaternions so the
   * blend takes the short way around.
   */
  public addScaled(other: DualQuat, s: number, reference?: DualQuat): this {
    let sign = s;
    if (reference && reference.real.dot(other.real) < 0) sign = -s;
    this.real.x += sign * other.real.x;
    this.real.y += sign * other.real.y;
    this.real.z += sign * other.real.z;
    this.real.w += sign * other.real.w;
    this.dual.x += sign * other.dual.x;
    this.dual.y += sign * other.dual.y;
    this.dual.z += sign * other.dual.z;
    this.dual.w += sign * other.dual.w;
    return this;
  }

  /** Reset to all-zero parts (a valid accumulator start for {@link addScaled}). */
  public setZero(): this {
    this.real.set(0, 0, 0, 0);
    this.dual.set(0, 0, 0, 0);
    return this;
  }
}

// Module-local scratch (not re-entrant; single-threaded use only).
const _q0 = new Quat();
const _q1 = new Quat();
const _q2 = new Quat();
const _tv = new Vec3();
