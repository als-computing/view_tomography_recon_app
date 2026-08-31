/**
 * Tests for the render loop's pure per-frame math: camera basis extraction, the near/far bracket,
 * measure-plane depth, the edge-ruler scale, and TAAU's jitter projection.
 */
import { describe, it, expect } from "vitest";
import { Mat4 } from "@zarr-viewer/math";
import {
  computeCameraBasis,
  derollCameraBasis,
  computeNearFar,
  computeMeasurePlaneDepth,
  computeRuler,
  applyTaauJitter,
} from "../frameMath.js";

describe("computeCameraBasis", () => {
  it("extracts unit right/up/forward from an identity matrix (camera looking down -Z)", () => {
    const basis = computeCameraBasis(new Mat4().elements);
    expect(basis.right).toEqual([1, 0, 0]);
    expect(basis.up).toEqual([0, 1, 0]);
    expect(basis.forward.map((v) => v + 0)).toEqual([0, 0, -1]); // normalize -0 to 0 for comparison
  });

  it("extracts a normalized basis from a scaled matrix", () => {
    const m = new Mat4();
    // Scale the right/up/forward columns; basis vectors must still come out unit-length.
    m.elements[0] = 2; // right.x
    m.elements[5] = 3; // up.y
    m.elements[10] = 4; // -forward.z (forward = -column2)
    const basis = computeCameraBasis(m.elements);
    for (const v of [basis.right, basis.up, basis.forward]) {
      expect(Math.hypot(v[0], v[1], v[2])).toBeCloseTo(1, 10);
    }
    expect(basis.right).toEqual([1, 0, 0]);
    expect(basis.up).toEqual([0, 1, 0]);
    expect(basis.forward.map((v) => v + 0)).toEqual([0, 0, -1]); // normalize -0 to 0 for comparison
  });
});

describe("derollCameraBasis", () => {
  it("matches the actual basis when there is no roll", () => {
    const forward: [number, number, number] = [0, 0, -1];
    const { right, up } = derollCameraBasis(forward, [1, 0, 0], [0, 1, 0]);
    expect(right[0]).toBeCloseTo(1);
    expect(right[1]).toBeCloseTo(0);
    expect(right[2]).toBeCloseTo(0);
    expect(up[0]).toBeCloseTo(0);
    expect(up[1]).toBeCloseTo(1);
    expect(up[2]).toBeCloseTo(0);
  });

  it("produces the same right/up regardless of the camera's actual roll, for the same forward", () => {
    const forward: [number, number, number] = [0, 0, -1];
    const a = derollCameraBasis(forward, [1, 0, 0], [0, 1, 0]);
    const cos30 = Math.cos(Math.PI / 6);
    const sin30 = Math.sin(Math.PI / 6);
    // A different "actual" (rolled) basis for the identical forward direction - a real trackball
    // camera could report either, depending purely on the drag path taken to get there.
    const rolledRight: [number, number, number] = [cos30, sin30, 0];
    const rolledUp: [number, number, number] = [-sin30, cos30, 0];
    const b = derollCameraBasis(forward, rolledRight, rolledUp);
    expect(b.right[0]).toBeCloseTo(a.right[0]);
    expect(b.right[1]).toBeCloseTo(a.right[1]);
    expect(b.right[2]).toBeCloseTo(a.right[2]);
    expect(b.up[0]).toBeCloseTo(a.up[0]);
    expect(b.up[1]).toBeCloseTo(a.up[1]);
    expect(b.up[2]).toBeCloseTo(a.up[2]);
  });

  it("falls back to the actual basis when looking straight along world-up (degenerate)", () => {
    const forward: [number, number, number] = [0, 1, 0]; // parallel to the default worldUp
    const actualRight: [number, number, number] = [1, 0, 0];
    const actualUp: [number, number, number] = [0, 0, -1];
    const { right, up } = derollCameraBasis(forward, actualRight, actualUp);
    expect(right).toEqual(actualRight);
    expect(up).toEqual(actualUp);
  });

  it("returns an orthonormal basis matching computeCameraBasis's handedness for a tilted view", () => {
    // A camera looking down and to the side, with an already-zero-roll actual basis (hand-derived from
    // computeCameraBasis's own convention) - deroll should reproduce it closely and stay orthonormal.
    const forward: [number, number, number] = [-0.632455532, -0.4472135955, -0.632455532];
    const actualRight: [number, number, number] = [0.7071067812, 0, -0.7071067812];
    const actualUp: [number, number, number] = [-0.316227766, 0.894427191, -0.316227766];
    const { right, up } = derollCameraBasis(forward, actualRight, actualUp);
    expect(Math.hypot(right[0], right[1], right[2])).toBeCloseTo(1);
    expect(Math.hypot(up[0], up[1], up[2])).toBeCloseTo(1);
    expect(right[0] * up[0] + right[1] * up[1] + right[2] * up[2]).toBeCloseTo(0); // right ⊥ up
    expect(right[0] * forward[0] + right[1] * forward[1] + right[2] * forward[2]).toBeCloseTo(0);
    expect(up[0] * forward[0] + up[1] * forward[1] + up[2] * forward[2]).toBeCloseTo(0);
    expect(right[0]).toBeCloseTo(actualRight[0], 3);
    expect(up[1]).toBeCloseTo(actualUp[1], 3);
  });
});

describe("computeNearFar", () => {
  it("brackets a cube centered at the origin, viewed from along +z", () => {
    const sizeSim = { x: 2, y: 2, z: 2 };
    const eye = { x: 0, y: 0, z: 10 };
    const forward: [number, number, number] = [0, 0, -1]; // looking toward the origin
    const { near, far, centerDepth, extent, halfDepth } = computeNearFar(sizeSim, eye, forward);
    expect(centerDepth).toBeCloseTo(10);
    expect(extent).toBe(2);
    expect(halfDepth).toBeCloseTo(1); // half the cube's depth along z
    expect(near).toBeLessThan(centerDepth);
    expect(far).toBeGreaterThan(centerDepth);
    expect(near).toBeGreaterThan(0);
  });

  it("keeps near positive (a small fraction of far) even when the eye is inside the volume", () => {
    const sizeSim = { x: 4, y: 4, z: 4 };
    const eye = { x: 0, y: 0, z: 0 }; // eye at the box center → centerDepth ~ 0
    const forward: [number, number, number] = [0, 0, -1];
    const { near, far } = computeNearFar(sizeSim, eye, forward);
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(far);
  });

  it("grows the margin (relative to a fixed box) as the eye zooms far out", () => {
    const sizeSim = { x: 2, y: 2, z: 2 };
    const forward: [number, number, number] = [0, 0, -1];
    const near1 = computeNearFar(sizeSim, { x: 0, y: 0, z: 10 }, forward);
    const near2 = computeNearFar(sizeSim, { x: 0, y: 0, z: 10000 }, forward);
    // Far-near range should scale up substantially at extreme zoom-out (margin floor at 5% of depth).
    expect(near2.far - near2.near).toBeGreaterThan((near1.far - near1.near) * 100);
  });
});

describe("computeMeasurePlaneDepth", () => {
  it("returns the front face at fraction 0 and back face at fraction 1", () => {
    const centerDepth = 10;
    const halfDepth = 2;
    const near = 1;
    expect(computeMeasurePlaneDepth(centerDepth, halfDepth, near, 0)).toBeCloseTo(8);
    expect(computeMeasurePlaneDepth(centerDepth, halfDepth, near, 1)).toBeCloseTo(12);
  });

  it("interpolates at the midpoint fraction", () => {
    expect(computeMeasurePlaneDepth(10, 2, 1, 0.5)).toBeCloseTo(10);
  });

  it("clamps the fraction to [0,1]", () => {
    expect(computeMeasurePlaneDepth(10, 2, 1, -1)).toBeCloseTo(8);
    expect(computeMeasurePlaneDepth(10, 2, 1, 5)).toBeCloseTo(12);
  });

  it("clamps the front face to not go closer than `near`", () => {
    // centerDepth - halfDepth = 1, below near=3 → front face clamps to near.
    expect(computeMeasurePlaneDepth(3, 2, 3, 0)).toBeCloseTo(3);
  });
});

describe("computeRuler", () => {
  it("returns null when cssHeight is non-positive", () => {
    expect(
      computeRuler({
        measureDist: 10,
        fovY: Math.PI / 4,
        cssHeight: 0,
        worldPerPxToDisplay: (w) => w,
        unitSymbol: "µm",
      }),
    ).toBeNull();
  });

  it("returns null when measureDist is not finite/positive", () => {
    expect(
      computeRuler({
        measureDist: -1,
        fovY: Math.PI / 4,
        cssHeight: 600,
        worldPerPxToDisplay: (w) => w,
        unitSymbol: "µm",
      }),
    ).toBeNull();
  });

  it("returns a ruler with a nice major value and matching label", () => {
    const ruler = computeRuler({
      measureDist: 10,
      fovY: Math.PI / 4,
      cssHeight: 600,
      worldPerPxToDisplay: (w) => w * 1000, // pretend sim units are mm, display in µm
      unitSymbol: "µm",
    });
    expect(ruler).not.toBeNull();
    expect(ruler!.unitLabel).toBe("µm");
    expect(ruler!.minorPerMajor).toBe(5);
    expect(ruler!.majorPx).toBeGreaterThan(0);
  });
});

describe("applyTaauJitter", () => {
  it("offsets the projection matrix's jitter terms and multiplies through view", () => {
    const proj = new Mat4();
    const view = new Mat4();
    const jitterProj = new Mat4();
    const jitterViewProj = new Mat4();
    applyTaauJitter(jitterProj, jitterViewProj, proj, view, [1, 2], 800, 600);
    expect(jitterProj.elements[8]).toBeCloseTo((2 * 1) / 800);
    expect(jitterProj.elements[9]).toBeCloseTo((2 * 2) / 600);
    // jitterViewProj = jitterProj * view; with view = identity, it should equal jitterProj.
    for (let i = 0; i < 16; i++) {
      expect(jitterViewProj.elements[i]).toBeCloseTo(jitterProj.elements[i]!);
    }
  });

  it("leaves the source proj/view matrices untouched", () => {
    const proj = new Mat4();
    const view = new Mat4();
    const projBefore = Array.from(proj.elements);
    const viewBefore = Array.from(view.elements);
    applyTaauJitter(new Mat4(), new Mat4(), proj, view, [3, -1], 800, 600);
    expect(Array.from(proj.elements)).toEqual(projBefore);
    expect(Array.from(view.elements)).toEqual(viewBefore);
  });
});
