/**
 * A 4x4 matrix in **column-major** order (matching WGSL/WebGPU). Backed by a `Float64Array` for
 * CPU-side precision; convert to `Float32Array` at the GPU boundary via `@zarr-viewer/math` gpu-layout.
 *
 * Element layout (column-major):
 * ```
 * | e0  e4  e8  e12 |
 * | e1  e5  e9  e13 |
 * | e2  e6  e10 e14 |
 * | e3  e7  e11 e15 |
 * ```
 * Projection helpers produce clip-space depth in `[0, 1]` (WebGPU convention).
 *
 * @packageDocumentation
 */

import type { QuatLike } from "./quat.js";
import type { Vec3, Vec3Like } from "./vec3.js";
import { EPSILON } from "./scalar.js";

/**
 * A column-major 4x4 matrix. Defaults to the identity.
 *
 * @example
 * ```ts
 * const model = new Mat4().compose(position, rotation, scale);
 * const mvp = new Mat4().multiplyMatrices(viewProj, model);
 * ```
 */
export class Mat4 {
  /** The 16 elements in column-major order. */
  public readonly elements: Float64Array;

  /** Create a 4x4 identity matrix. */
  public constructor() {
    const e = new Float64Array(16);
    e[0] = 1;
    e[5] = 1;
    e[10] = 1;
    e[15] = 1;
    this.elements = e;
  }

  /** Reset to the identity matrix. */
  public identity(): this {
    const e = this.elements;
    e.fill(0);
    e[0] = 1;
    e[5] = 1;
    e[10] = 1;
    e[15] = 1;
    return this;
  }

  /** Copy from `m`. */
  public copy(m: Mat4): this {
    this.elements.set(m.elements);
    return this;
  }

  /** Allocate a copy. */
  public clone(): Mat4 {
    return new Mat4().copy(this);
  }

  /** Set all 16 elements from column-major arguments. */
  public setColumnMajor(...values: readonly number[]): this {
    this.elements.set(values);
    return this;
  }

  /** Load from a column-major array-like at `offset`. */
  public fromArray(array: ArrayLike<number>, offset = 0): this {
    for (let i = 0; i < 16; i++) this.elements[i] = array[offset + i]!;
    return this;
  }

  /** Write into `array` (column-major) at `offset`. */
  public toArray<T extends { [index: number]: number }>(array: T, offset = 0): T {
    const e = this.elements;
    for (let i = 0; i < 16; i++) array[offset + i] = e[i]!;
    return array;
  }

  /** Set this matrix to `a * b`. */
  public multiplyMatrices(a: Mat4, b: Mat4): this {
    const ae = a.elements;
    const be = b.elements;
    const te = this.elements;

    const a11 = ae[0]!;
    const a21 = ae[1]!;
    const a31 = ae[2]!;
    const a41 = ae[3]!;
    const a12 = ae[4]!;
    const a22 = ae[5]!;
    const a32 = ae[6]!;
    const a42 = ae[7]!;
    const a13 = ae[8]!;
    const a23 = ae[9]!;
    const a33 = ae[10]!;
    const a43 = ae[11]!;
    const a14 = ae[12]!;
    const a24 = ae[13]!;
    const a34 = ae[14]!;
    const a44 = ae[15]!;

    for (let c = 0; c < 4; c++) {
      const b1 = be[c * 4]!;
      const b2 = be[c * 4 + 1]!;
      const b3 = be[c * 4 + 2]!;
      const b4 = be[c * 4 + 3]!;
      te[c * 4] = a11 * b1 + a12 * b2 + a13 * b3 + a14 * b4;
      te[c * 4 + 1] = a21 * b1 + a22 * b2 + a23 * b3 + a24 * b4;
      te[c * 4 + 2] = a31 * b1 + a32 * b2 + a33 * b3 + a34 * b4;
      te[c * 4 + 3] = a41 * b1 + a42 * b2 + a43 * b3 + a44 * b4;
    }
    return this;
  }

  /** Right-multiply (`this = this * m`). */
  public multiply(m: Mat4): this {
    return this.multiplyMatrices(this, m);
  }

  /** Left-multiply (`this = m * this`). */
  public premultiply(m: Mat4): this {
    return this.multiplyMatrices(m, this);
  }

  /** Compose a TRS matrix from position, rotation quaternion, and scale. */
  public compose(position: Vec3Like, quaternion: QuatLike, scale: Vec3Like): this {
    const te = this.elements;
    const { x, y, z, w } = quaternion;
    const x2 = x + x;
    const y2 = y + y;
    const z2 = z + z;
    const xx = x * x2;
    const xy = x * y2;
    const xz = x * z2;
    const yy = y * y2;
    const yz = y * z2;
    const zz = z * z2;
    const wx = w * x2;
    const wy = w * y2;
    const wz = w * z2;
    const sx = scale.x;
    const sy = scale.y;
    const sz = scale.z;

    te[0] = (1 - (yy + zz)) * sx;
    te[1] = (xy + wz) * sx;
    te[2] = (xz - wy) * sx;
    te[3] = 0;
    te[4] = (xy - wz) * sy;
    te[5] = (1 - (xx + zz)) * sy;
    te[6] = (yz + wx) * sy;
    te[7] = 0;
    te[8] = (xz + wy) * sz;
    te[9] = (yz - wx) * sz;
    te[10] = (1 - (xx + yy)) * sz;
    te[11] = 0;
    te[12] = position.x;
    te[13] = position.y;
    te[14] = position.z;
    te[15] = 1;
    return this;
  }

  /**
   * Decompose this matrix into `position`, `quaternion`, and `scale`. Assumes an affine TRS matrix.
   */
  public decompose(position: Vec3, quaternion: import("./quat.js").Quat, scale: Vec3): void {
    const te = this.elements;
    let sx = Math.hypot(te[0]!, te[1]!, te[2]!);
    const sy = Math.hypot(te[4]!, te[5]!, te[6]!);
    const sz = Math.hypot(te[8]!, te[9]!, te[10]!);

    // A negative determinant means one axis is flipped.
    if (this.determinant() < 0) sx = -sx;

    position.set(te[12]!, te[13]!, te[14]!);
    scale.set(sx, sy, sz);

    const invSx = 1 / sx;
    const invSy = 1 / sy;
    const invSz = 1 / sz;
    const re = _decomposeRot.elements;
    re[0] = te[0]! * invSx;
    re[1] = te[1]! * invSx;
    re[2] = te[2]! * invSx;
    re[3] = 0;
    re[4] = te[4]! * invSy;
    re[5] = te[5]! * invSy;
    re[6] = te[6]! * invSy;
    re[7] = 0;
    re[8] = te[8]! * invSz;
    re[9] = te[9]! * invSz;
    re[10] = te[10]! * invSz;
    re[11] = 0;
    re[12] = 0;
    re[13] = 0;
    re[14] = 0;
    re[15] = 1;
    quaternion.setFromRotationMatrix(_decomposeRot);
  }

  /** Determinant of the matrix. */
  public determinant(): number {
    const e = this.elements;
    const m00 = e[0]!;
    const m01 = e[4]!;
    const m02 = e[8]!;
    const m03 = e[12]!;
    const m10 = e[1]!;
    const m11 = e[5]!;
    const m12 = e[9]!;
    const m13 = e[13]!;
    const m20 = e[2]!;
    const m21 = e[6]!;
    const m22 = e[10]!;
    const m23 = e[14]!;
    const m30 = e[3]!;
    const m31 = e[7]!;
    const m32 = e[11]!;
    const m33 = e[15]!;

    const b00 = m00 * m11 - m01 * m10;
    const b01 = m00 * m12 - m02 * m10;
    const b02 = m00 * m13 - m03 * m10;
    const b03 = m01 * m12 - m02 * m11;
    const b04 = m01 * m13 - m03 * m11;
    const b05 = m02 * m13 - m03 * m12;
    const b06 = m20 * m31 - m21 * m30;
    const b07 = m20 * m32 - m22 * m30;
    const b08 = m20 * m33 - m23 * m30;
    const b09 = m21 * m32 - m22 * m31;
    const b10 = m21 * m33 - m23 * m31;
    const b11 = m22 * m33 - m23 * m32;

    return b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  }

  /** Invert in place. Leaves the matrix unchanged and returns `false` if singular. */
  public invert(): boolean {
    const e = this.elements;
    const m00 = e[0]!;
    const m01 = e[4]!;
    const m02 = e[8]!;
    const m03 = e[12]!;
    const m10 = e[1]!;
    const m11 = e[5]!;
    const m12 = e[9]!;
    const m13 = e[13]!;
    const m20 = e[2]!;
    const m21 = e[6]!;
    const m22 = e[10]!;
    const m23 = e[14]!;
    const m30 = e[3]!;
    const m31 = e[7]!;
    const m32 = e[11]!;
    const m33 = e[15]!;

    const b00 = m00 * m11 - m01 * m10;
    const b01 = m00 * m12 - m02 * m10;
    const b02 = m00 * m13 - m03 * m10;
    const b03 = m01 * m12 - m02 * m11;
    const b04 = m01 * m13 - m03 * m11;
    const b05 = m02 * m13 - m03 * m12;
    const b06 = m20 * m31 - m21 * m30;
    const b07 = m20 * m32 - m22 * m30;
    const b08 = m20 * m33 - m23 * m30;
    const b09 = m21 * m32 - m22 * m31;
    const b10 = m21 * m33 - m23 * m31;
    const b11 = m22 * m33 - m23 * m32;

    const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    // Magnitude-aware singularity test: a 4×4 determinant scales as (element magnitude)⁴, so use a
    // relative threshold rather than the absolute Number.EPSILON.
    let scale = 0;
    for (let k = 0; k < 16; k++) {
      const v = Math.abs(e[k]!);
      if (v > scale) scale = v;
    }
    if (Math.abs(det) <= 1e-14 * scale * scale * scale * scale) return false;
    const invDet = 1 / det;

    e[0] = (m11 * b11 - m12 * b10 + m13 * b09) * invDet;
    e[1] = (m12 * b08 - m10 * b11 - m13 * b07) * invDet;
    e[2] = (m10 * b10 - m11 * b08 + m13 * b06) * invDet;
    e[3] = (m11 * b07 - m10 * b09 - m12 * b06) * invDet;
    e[4] = (m02 * b10 - m01 * b11 - m03 * b09) * invDet;
    e[5] = (m00 * b11 - m02 * b08 + m03 * b07) * invDet;
    e[6] = (m01 * b08 - m00 * b10 - m03 * b06) * invDet;
    e[7] = (m00 * b09 - m01 * b07 + m02 * b06) * invDet;
    e[8] = (m31 * b05 - m32 * b04 + m33 * b03) * invDet;
    e[9] = (m32 * b02 - m30 * b05 - m33 * b01) * invDet;
    e[10] = (m30 * b04 - m31 * b02 + m33 * b00) * invDet;
    e[11] = (m31 * b01 - m30 * b03 - m32 * b00) * invDet;
    e[12] = (m22 * b04 - m21 * b05 - m23 * b03) * invDet;
    e[13] = (m20 * b05 - m22 * b02 + m23 * b01) * invDet;
    e[14] = (m21 * b02 - m20 * b04 - m23 * b00) * invDet;
    e[15] = (m20 * b03 - m21 * b01 + m22 * b00) * invDet;
    return true;
  }

  /** Transpose in place. */
  public transpose(): this {
    const e = this.elements;
    const swap = (i: number, j: number): void => {
      const t = e[i]!;
      e[i] = e[j]!;
      e[j] = t;
    };
    swap(1, 4);
    swap(2, 8);
    swap(3, 12);
    swap(6, 9);
    swap(7, 13);
    swap(11, 14);
    return this;
  }

  /** Set to a pure translation. */
  public makeTranslation(x: number, y: number, z: number): this {
    this.identity();
    const e = this.elements;
    e[12] = x;
    e[13] = y;
    e[14] = z;
    return this;
  }

  /** Set to a pure scale. */
  public makeScale(x: number, y: number, z: number): this {
    this.identity();
    const e = this.elements;
    e[0] = x;
    e[5] = y;
    e[10] = z;
    return this;
  }

  /** Set to a rotation from a unit quaternion. */
  public makeRotationFromQuaternion(q: QuatLike): this {
    return this.compose({ x: 0, y: 0, z: 0 }, q, { x: 1, y: 1, z: 1 });
  }

  /**
   * Build a right-handed **view** matrix looking from `eye` toward `center` with `up`.
   * (This is the inverse camera transform, ready to multiply positions into view space.)
   */
  public lookAt(eye: Vec3Like, center: Vec3Like, up: Vec3Like): this {
    let zx = eye.x - center.x;
    let zy = eye.y - center.y;
    let zz = eye.z - center.z;
    let zl = Math.hypot(zx, zy, zz);
    if (zl === 0) {
      zz = 1;
      zl = 1;
    }
    zx /= zl;
    zy /= zl;
    zz /= zl;

    let xx = up.y * zz - up.z * zy;
    let xy = up.z * zx - up.x * zz;
    let xz = up.x * zy - up.y * zx;
    const xl = Math.hypot(xx, xy, xz);
    if (xl === 0) {
      xx = 0;
      xy = 0;
      xz = 0;
    } else {
      xx /= xl;
      xy /= xl;
      xz /= xl;
    }

    const yx = zy * xz - zz * xy;
    const yy = zz * xx - zx * xz;
    const yz = zx * xy - zy * xx;

    const e = this.elements;
    e[0] = xx;
    e[1] = yx;
    e[2] = zx;
    e[3] = 0;
    e[4] = xy;
    e[5] = yy;
    e[6] = zy;
    e[7] = 0;
    e[8] = xz;
    e[9] = yz;
    e[10] = zz;
    e[11] = 0;
    e[12] = -(xx * eye.x + xy * eye.y + xz * eye.z);
    e[13] = -(yx * eye.x + yy * eye.y + yz * eye.z);
    e[14] = -(zx * eye.x + zy * eye.y + zz * eye.z);
    e[15] = 1;
    return this;
  }

  /**
   * Right-handed perspective projection with clip-space depth in `[0, 1]` (WebGPU).
   *
   * @param fovY - Vertical field of view in radians.
   * @param aspect - Width / height.
   * @param near - Near plane distance (> 0).
   * @param far - Far plane distance, or `Infinity`.
   */
  public perspective(fovY: number, aspect: number, near: number, far: number): this {
    const f = 1 / Math.tan(fovY / 2);
    const e = this.elements;
    e.fill(0);
    e[0] = f / aspect;
    e[5] = f;
    e[11] = -1;
    if (far === Infinity) {
      e[10] = -1;
      e[14] = -near;
    } else {
      const nf = 1 / (near - far);
      e[10] = far * nf;
      e[14] = far * near * nf;
    }
    return this;
  }

  /** Right-handed orthographic projection with clip-space depth in `[0, 1]` (WebGPU). */
  public orthographic(
    left: number,
    right: number,
    bottom: number,
    top: number,
    near: number,
    far: number,
  ): this {
    const lr = 1 / (left - right);
    const bt = 1 / (bottom - top);
    const nf = 1 / (near - far);
    const e = this.elements;
    e.fill(0);
    e[0] = -2 * lr;
    e[5] = -2 * bt;
    e[10] = nf;
    e[12] = (left + right) * lr;
    e[13] = (top + bottom) * bt;
    e[14] = near * nf;
    e[15] = 1;
    return this;
  }

  /** Approximate element-wise equality within `tolerance`. */
  public approxEquals(m: Mat4, tolerance: number = EPSILON): boolean {
    const a = this.elements;
    const b = m.elements;
    for (let i = 0; i < 16; i++) {
      if (Math.abs(a[i]! - b[i]!) > tolerance) return false;
    }
    return true;
  }

  /** `out = a * b`. */
  public static multiply(out: Mat4, a: Mat4, b: Mat4): Mat4 {
    return out.multiplyMatrices(a, b);
  }
}

/** Scratch rotation matrix for {@link Mat4.decompose} (avoids per-call allocation). */
const _decomposeRot = new Mat4();
