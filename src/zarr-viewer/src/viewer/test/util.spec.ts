/**
 * Tests for the viewer's small closure-free helpers: matrix transform and scale-bar rounding.
 * (zarrUrlFromQuery/pickZarrStore depend on `window`/File System Access API and aren't covered here —
 * this suite runs under Vitest's "node" environment.)
 */
import { describe, it, expect } from "vitest";
import { Mat4 } from "@zarr-viewer/math";
import { mulMat4Vec4, niceFloor125 } from "../util.js";

describe("mulMat4Vec4", () => {
  it("leaves a vector unchanged under the identity matrix", () => {
    const m = new Mat4();
    expect(mulMat4Vec4(m, 1, 2, 3, 1)).toEqual([1, 2, 3, 1]);
  });

  it("applies a translation matrix to a point (w=1)", () => {
    const m = new Mat4();
    m.elements[12] = 5; // translate x
    m.elements[13] = -2; // translate y
    m.elements[14] = 0.5; // translate z
    const [x, y, z, w] = mulMat4Vec4(m, 1, 1, 1, 1);
    expect([x, y, z, w]).toEqual([6, -1, 1.5, 1]);
  });

  it("does not apply translation to a direction (w=0)", () => {
    const m = new Mat4();
    m.elements[12] = 5;
    m.elements[13] = -2;
    m.elements[14] = 0.5;
    const [x, y, z, w] = mulMat4Vec4(m, 1, 1, 1, 0);
    expect([x, y, z, w]).toEqual([1, 1, 1, 0]);
  });

  it("applies a uniform scale", () => {
    const m = new Mat4();
    m.elements[0] = 2;
    m.elements[5] = 2;
    m.elements[10] = 2;
    expect(mulMat4Vec4(m, 3, 4, 5, 1)).toEqual([6, 8, 10, 1]);
  });
});

describe("niceFloor125", () => {
  it("rounds down to the nearest 1/2/5 x 10^n", () => {
    expect(niceFloor125(1)).toBe(1);
    expect(niceFloor125(1.9)).toBe(1);
    expect(niceFloor125(2)).toBe(2);
    expect(niceFloor125(4.9)).toBe(2);
    expect(niceFloor125(5)).toBe(5);
    expect(niceFloor125(9.9)).toBe(5);
    expect(niceFloor125(10)).toBe(10);
  });

  it("works across orders of magnitude", () => {
    expect(niceFloor125(37)).toBe(20);
    expect(niceFloor125(370)).toBe(200);
    expect(niceFloor125(0.037)).toBeCloseTo(0.02, 10);
  });
});
