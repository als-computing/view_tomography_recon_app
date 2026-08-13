/**
 * A 3x3 matrix in **column-major** order. Used for normal matrices and 2D affine transforms.
 *
 * @packageDocumentation
 */

import type { Mat4 } from "./mat4.js";

/**
 * A column-major 3x3 matrix. Defaults to the identity.
 *
 * @example
 * ```ts
 * const normalMatrix = new Mat3().normalFromMat4(modelView);
 * ```
 */
export class Mat3 {
  /** The 9 elements in column-major order. */
  public readonly elements: Float64Array;

  /** Create a 3x3 identity matrix. */
  public constructor() {
    const e = new Float64Array(9);
    e[0] = 1;
    e[4] = 1;
    e[8] = 1;
    this.elements = e;
  }

  /** Reset to identity. */
  public identity(): this {
    const e = this.elements;
    e.fill(0);
    e[0] = 1;
    e[4] = 1;
    e[8] = 1;
    return this;
  }

  /** Copy from `m`. */
  public copy(m: Mat3): this {
    this.elements.set(m.elements);
    return this;
  }

  /** Allocate a copy. */
  public clone(): Mat3 {
    return new Mat3().copy(this);
  }

  /** Extract the upper-left 3x3 of a 4x4 matrix. */
  public fromMat4(m: Mat4): this {
    const me = m.elements;
    const e = this.elements;
    e[0] = me[0]!;
    e[1] = me[1]!;
    e[2] = me[2]!;
    e[3] = me[4]!;
    e[4] = me[5]!;
    e[5] = me[6]!;
    e[6] = me[8]!;
    e[7] = me[9]!;
    e[8] = me[10]!;
    return this;
  }

  /** Set this matrix to `a * b`. */
  public multiplyMatrices(a: Mat3, b: Mat3): this {
    const ae = a.elements;
    const be = b.elements;
    const te = this.elements;
    for (let c = 0; c < 3; c++) {
      const b0 = be[c * 3]!;
      const b1 = be[c * 3 + 1]!;
      const b2 = be[c * 3 + 2]!;
      te[c * 3] = ae[0]! * b0 + ae[3]! * b1 + ae[6]! * b2;
      te[c * 3 + 1] = ae[1]! * b0 + ae[4]! * b1 + ae[7]! * b2;
      te[c * 3 + 2] = ae[2]! * b0 + ae[5]! * b1 + ae[8]! * b2;
    }
    return this;
  }

  /** Determinant. */
  public determinant(): number {
    const e = this.elements;
    const a = e[0]!;
    const b = e[1]!;
    const c = e[2]!;
    const d = e[3]!;
    const f = e[4]!;
    const g = e[5]!;
    const h = e[6]!;
    const i = e[7]!;
    const j = e[8]!;
    return a * (f * j - g * i) - d * (b * j - c * i) + h * (b * g - c * f);
  }

  /** Invert in place; returns `false` if singular. */
  public invert(): boolean {
    const e = this.elements;
    const a = e[0]!;
    const b = e[1]!;
    const c = e[2]!;
    const d = e[3]!;
    const f = e[4]!;
    const g = e[5]!;
    const h = e[6]!;
    const i = e[7]!;
    const j = e[8]!;

    const A = f * j - g * i;
    const B = g * h - d * j;
    const C = d * i - f * h;
    const det = a * A + b * B + c * C;
    // Magnitude-aware singularity test: the determinant of a 3×3 scales as (element magnitude)³, so
    // compare against a relative threshold rather than the absolute Number.EPSILON (which only ever
    // rejected exactly-singular matrices and let badly ill-conditioned ones through).
    let scale = 0;
    for (let k = 0; k < 9; k++) {
      const v = Math.abs(e[k]!);
      if (v > scale) scale = v;
    }
    if (Math.abs(det) <= 1e-14 * scale * scale * scale) return false;
    const inv = 1 / det;

    e[0] = A * inv;
    e[1] = (c * i - b * j) * inv;
    e[2] = (b * g - c * f) * inv;
    e[3] = B * inv;
    e[4] = (a * j - c * h) * inv;
    e[5] = (c * d - a * g) * inv;
    e[6] = C * inv;
    e[7] = (b * h - a * i) * inv;
    e[8] = (a * f - b * d) * inv;
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
    swap(1, 3);
    swap(2, 6);
    swap(5, 7);
    return this;
  }

  /**
   * Build the normal matrix (inverse-transpose of the upper-left 3x3) of a model matrix, for
   * correctly transforming normals under non-uniform scale.
   */
  public normalFromMat4(m: Mat4): this {
    this.fromMat4(m);
    this.invert();
    this.transpose();
    return this;
  }

  /** Write into `array` (column-major) at `offset`. */
  public toArray<T extends { [index: number]: number }>(array: T, offset = 0): T {
    const e = this.elements;
    for (let i = 0; i < 9; i++) array[offset + i] = e[i]!;
    return array;
  }
}
