import { describe, expect, it } from "vitest";
import { Mat4 } from "../mat4.js";
import { Quat } from "../quat.js";

/** Build a rigid camera-to-world matrix (rotation + translation, unit scale) - `det` is always
 * exactly 1 for any such transform, regardless of how far `position` is from the origin. */
function rigidTransform(position: [number, number, number], axis: [number, number, number], angleRad: number): Mat4 {
  const [px, py, pz] = position;
  const [ax, ay, az] = axis;
  const q = new Quat().setFromAxisAngle({ x: ax, y: ay, z: az }, angleRad);
  return new Mat4().compose({ x: px, y: py, z: pz }, q, { x: 1, y: 1, z: 1 });
}

describe("Mat4.invert()", () => {
  it("inverts an identity-rotation camera transform at a large (realistic dataset-scale) translation", () => {
    // Regression for a real bug: the old singularity threshold scaled with the LARGEST raw matrix
    // element (dominated by translation for a camera far from the origin), incorrectly treating
    // translation magnitude as if it inflated the determinant - it doesn't, for a rigid transform
    // (det=1 always). A camera at ~20000 world units out (routine for this app's real microscopy
    // datasets, which run camera distances in the thousands to tens of thousands of µm) used to be
    // wrongly rejected as "singular."
    const m = rigidTransform([20000, -15000, 8000], [0, 1, 0], 0);
    const clone = m.clone();
    expect(m.invert()).toBe(true);
    // m * m^-1 should be the identity.
    const product = new Mat4().multiplyMatrices(clone, m);
    const id = new Mat4();
    for (let i = 0; i < 16; i++) {
      expect(product.elements[i]!).toBeCloseTo(id.elements[i]!, 6);
    }
  });

  it("inverts a rotated + translated camera transform at large translation magnitudes", () => {
    const m = rigidTransform([6000, 2000, -14000], [0.3, 1, 0.1], 1.234);
    const clone = m.clone();
    expect(m.invert()).toBe(true);
    const product = new Mat4().multiplyMatrices(clone, m);
    const id = new Mat4();
    for (let i = 0; i < 16; i++) {
      expect(product.elements[i]!).toBeCloseTo(id.elements[i]!, 4);
    }
  });

  it("inverts successfully across a sweep of translation magnitudes up to very large camera distances", () => {
    for (const dist of [100, 1000, 3162, 5000, 10000, 23000, 50000, 100000]) {
      const m = rigidTransform([dist, 0, 0], [0, 1, 0], 0.5);
      expect(m.invert(), `translation magnitude ${dist} should invert`).toBe(true);
    }
  });

  it("leaves the matrix unchanged and returns false for a genuinely singular matrix", () => {
    // A matrix with a zeroed-out row is genuinely non-invertible regardless of translation scale.
    const m = new Mat4();
    m.elements[0] = 0;
    m.elements[5] = 0;
    m.elements[10] = 0;
    // Keep e[15] so it's not trivially degenerate in an unrelated way; this 4x4 has rank < 4 either way.
    const before = m.clone();
    const ok = m.invert();
    expect(ok).toBe(false);
    expect(m.elements).toEqual(before.elements);
  });

  it("round-trips (invert twice) back to the original for a realistic camera pose", () => {
    const m = rigidTransform([-7000, 3000, 12000], [0, 0, 1], 0.7);
    const original = m.clone();
    expect(m.invert()).toBe(true);
    expect(m.invert()).toBe(true);
    for (let i = 0; i < 16; i++) {
      expect(m.elements[i]!).toBeCloseTo(original.elements[i]!, 4);
    }
  });
});
