/**
 * Tests for the pure crop-drag geometry: face hit-testing, axis-constrained face dragging, and
 * screen-space projection for the wireframe overlay.
 */
import { describe, it, expect } from "vitest";
import { Mat4 } from "@zarr-viewer/math";
import {
  cropWorldBox,
  intersectCropFaces,
  axisScreenProjection,
  dragFaceScreenDelta,
  boxCorners,
  BOX_EDGES,
  worldToScreen,
  padBox,
} from "../crop-drag-geometry.js";

describe("cropWorldBox", () => {
  it("maps full-volume UVW crop [0,1] to the box centered at the origin", () => {
    const box = cropWorldBox([0, 0, 0], [1, 1, 1], { x: 10, y: 20, z: 30 });
    expect(box.min).toEqual([-5, -10, -15]);
    expect(box.max).toEqual([5, 10, 15]);
  });

  it("maps a partial crop to an off-center sub-box", () => {
    const box = cropWorldBox([0.25, 0, 0], [0.75, 1, 1], { x: 10, y: 10, z: 10 });
    expect(box.min[0]).toBeCloseTo(-2.5);
    expect(box.max[0]).toBeCloseTo(2.5);
  });
});

describe("padBox", () => {
  it("inflates each side outward by a fraction of that axis's own span", () => {
    const box = padBox([0, 0, 0], [1, 1, 4], 0.1);
    expect(box.min).toEqual([-0.1, -0.1, -0.4]);
    expect(box.max).toEqual([1.1, 1.1, 4.4]);
  });

  it("doesn't let a thin axis's pad overlap itself just because another axis is much larger", () => {
    // A tightly-cropped x span (0.1) next to a large z span (10): x's own pad must stay small relative
    // to x's own span, not balloon to a fraction of z's span (which would make the two x faces'
    // padded regions overlap and read as "grabs the wrong side").
    const box = padBox([0, 0, 0], [0.1, 1, 10], 0.1);
    expect(box.max[0] - box.min[0]).toBeLessThan(0.1 * 2); // pad on each side < the axis's own span
  });

  it("still pads a fully-collapsed (zero-size) box rather than leaving it zero-thickness", () => {
    const box = padBox([0, 0, 0], [0, 0, 0], 0.1);
    expect(box.min[0]).toBeLessThan(0);
    expect(box.max[0]).toBeGreaterThan(0);
  });
});

describe("intersectCropFaces", () => {
  const boxMin: [number, number, number] = [-1, -1, -1];
  const boxMax: [number, number, number] = [1, 1, 1];

  it("hits the -z face along +z from outside", () => {
    const hit = intersectCropFaces(0, 0, -5, 0, 0, 1, boxMin, boxMax);
    expect(hit).not.toBeNull();
    expect(hit!.axis).toBe(2);
    expect(hit!.side).toBe("min");
    expect(hit!.t).toBeCloseTo(4);
    expect(hit!.point).toEqual([0, 0, -1]);
  });

  it("hits the +x face along -x from outside", () => {
    const hit = intersectCropFaces(5, 0, 0, -1, 0, 0, boxMin, boxMax);
    expect(hit).not.toBeNull();
    expect(hit!.axis).toBe(0);
    expect(hit!.side).toBe("max");
    expect(hit!.point[0]).toBeCloseTo(1);
  });

  it("returns null for a ray that misses the box entirely", () => {
    expect(intersectCropFaces(5, 5, -5, 0, 0, 1, boxMin, boxMax)).toBeNull();
  });

  it("returns null when the box is entirely behind the ray origin", () => {
    expect(intersectCropFaces(0, 0, 5, 0, 0, 1, boxMin, boxMax)).toBeNull();
  });

  it("picks whichever axis actually produced the near intersection at a corner-ish angle", () => {
    // A ray aimed at the box from an oblique angle should still report a single, consistent
    // near face (not throw / not report an axis that the ray didn't actually enter through first).
    const hit = intersectCropFaces(-5, -5, -5, 1, 1, 1, boxMin, boxMax);
    expect(hit).not.toBeNull();
    expect(hit!.side).toBe("min");
    expect([0, 1, 2]).toContain(hit!.axis);
  });
});

describe("axisScreenProjection / dragFaceScreenDelta", () => {
  function viewProjLookingAt(eye: { x: number; y: number; z: number }): Mat4 {
    const proj = new Mat4().perspective((60 * Math.PI) / 180, 1, 0.1, 100);
    const view = new Mat4().lookAt(eye, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    return Mat4.multiply(new Mat4(), proj, view);
  }

  it("returns null when the axis projects to a point (camera looking straight down it)", () => {
    // Looking down -z from directly above the anchor along z: probing along z moves purely in depth,
    // which projects to (near enough) the same screen point.
    const vp = viewProjLookingAt({ x: 0, y: 0, z: 5 });
    const p = axisScreenProjection(vp, [0, 0, 0], 2, 200, 100); // axis 2 = z, the view axis itself
    expect(p).toBeNull();
  });

  it("finds a well-defined screen direction for an axis roughly perpendicular to the view", () => {
    const vp = viewProjLookingAt({ x: 0, y: 0, z: 5 });
    const p = axisScreenProjection(vp, [0, 0, 0], 0, 200, 100); // axis 0 = x, perpendicular to view
    expect(p).not.toBeNull();
    expect(Math.hypot(p!.dir[0], p!.dir[1])).toBeCloseTo(1); // unit direction
    expect(p!.worldPerPixel).toBeGreaterThan(0);
  });

  it("dragFaceScreenDelta follows the mouse in the axis's own screen direction, not inverted", () => {
    // A screen-space move of exactly `worldPerPixel` pixels along the axis's own direction must move
    // the reported world coordinate by exactly 1 world unit in the positive direction - by
    // construction (this is a direct linear read of axisScreenProjection's own calibration), so this
    // mainly locks in that dragFaceScreenDelta doesn't accidentally negate anything.
    const vp = viewProjLookingAt({ x: 0, y: 0, z: 5 });
    const projection = axisScreenProjection(vp, [0, 0, 0], 0, 200, 100)!;
    const start: [number, number] = [50, 50];
    const moved: [number, number] = [
      start[0] + projection.dir[0] / projection.worldPerPixel,
      start[1] + projection.dir[1] / projection.worldPerPixel,
    ];
    const x = dragFaceScreenDelta(projection, 0, start, moved);
    expect(x).toBeCloseTo(1);
  });

  it("moving the mouse the opposite way moves the face the opposite way", () => {
    const vp = viewProjLookingAt({ x: 0, y: 0, z: 5 });
    const projection = axisScreenProjection(vp, [0, 0, 0], 0, 200, 100)!;
    const start: [number, number] = [50, 50];
    const movedBack: [number, number] = [
      start[0] - projection.dir[0] / projection.worldPerPixel,
      start[1] - projection.dir[1] / projection.worldPerPixel,
    ];
    const x = dragFaceScreenDelta(projection, 0, start, movedBack);
    expect(x).toBeCloseTo(-1);
  });
});

describe("boxCorners / BOX_EDGES", () => {
  it("produces 8 corners spanning min/max on every axis", () => {
    const corners = boxCorners([-1, -2, -3], [1, 2, 3]);
    expect(corners).toHaveLength(8);
    expect(corners).toContainEqual([-1, -2, -3]);
    expect(corners).toContainEqual([1, 2, 3]);
    expect(corners).toContainEqual([1, -2, 3]);
  });

  it("every edge connects two corners differing in exactly one coordinate", () => {
    const corners = boxCorners([0, 0, 0], [1, 1, 1]);
    for (const [a, b] of BOX_EDGES) {
      const ca = corners[a]!;
      const cb = corners[b]!;
      const diffCount = ca.filter((v, i) => v !== cb[i]).length;
      expect(diffCount).toBe(1);
    }
    expect(BOX_EDGES).toHaveLength(12);
  });
});

describe("worldToScreen", () => {
  function viewProjLookingAt(eye: { x: number; y: number; z: number }): Mat4 {
    const proj = new Mat4().perspective((60 * Math.PI) / 180, 1, 0.1, 100);
    const view = new Mat4().lookAt(eye, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    return Mat4.multiply(new Mat4(), proj, view);
  }

  it("projects the world origin to the center of the screen when looking straight at it", () => {
    const vp = viewProjLookingAt({ x: 0, y: 0, z: 5 });
    const p = worldToScreen(vp, 0, 0, 0, 200, 100);
    expect(p).not.toBeNull();
    expect(p![0]).toBeCloseTo(100, 0);
    expect(p![1]).toBeCloseTo(50, 0);
  });

  it("returns null for a point behind the camera", () => {
    const vp = viewProjLookingAt({ x: 0, y: 0, z: 5 });
    const p = worldToScreen(vp, 0, 0, 20, 200, 100); // behind the eye at z=5 looking toward -z
    expect(p).toBeNull();
  });

  it("moves a world point off-center in a fixed, locked-in direction as it moves along Y", () => {
    // Locks in worldToScreen's Y-sign choice (see its own doc comment - empirically matched to the
    // live renderer's actual camera.worldMatrix()-derived view matrix, not derived from a documented
    // NDC convention, since this test harness's Mat4.lookAt-built matrix isn't provably the same
    // convention as the runtime Node/OrbitControls camera transform). This test doesn't assert which
    // direction is "correct" - only that a regression (accidentally flipping the sign back) is caught.
    const vp = viewProjLookingAt({ x: 0, y: 0, z: 5 });
    const center = worldToScreen(vp, 0, 0, 0, 200, 100)!;
    const above = worldToScreen(vp, 0, 1, 0, 200, 100)!;
    expect(above[1]).toBeGreaterThan(center[1]);
  });
});
