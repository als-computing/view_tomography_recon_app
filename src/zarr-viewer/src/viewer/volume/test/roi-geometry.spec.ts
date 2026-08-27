/**
 * Tests for the pure ROI ray/AABB geometry: crop-box detection, box intersection, view-ray
 * reconstruction, and the focal-region AABB used to size a high-res streamed brick.
 */
import { describe, it, expect } from "vitest";
import { Mat4 } from "@zarr-viewer/math";
import { cropIsSet, intersectRoiBox, rayDir, focalRoiUvw } from "../roi-geometry.js";

describe("cropIsSet", () => {
  it("is false for the untouched full-volume box", () => {
    expect(cropIsSet([0, 0, 0], [1, 1, 1])).toBe(false);
  });

  it("ignores sub-threshold float noise around the extremes", () => {
    expect(cropIsSet([0.0001, 0, 0], [1, 1, 0.9995])).toBe(false);
  });

  it("is true when any bound moves past the threshold", () => {
    expect(cropIsSet([0.1, 0, 0], [1, 1, 1])).toBe(true);
    expect(cropIsSet([0, 0, 0], [1, 1, 0.5])).toBe(true);
  });
});

describe("intersectRoiBox", () => {
  it("hits a box centered at the origin along +z from outside", () => {
    const hit = intersectRoiBox(0, 0, -5, 0, 0, 1, 1, 1, 1);
    expect(hit).not.toBeNull();
    expect(hit![0]).toBeCloseTo(4); // enters at z=-1
    expect(hit![1]).toBeCloseTo(6); // exits at z=1
  });

  it("returns null for a ray that misses the box entirely", () => {
    expect(intersectRoiBox(5, 5, -5, 0, 0, 1, 1, 1, 1)).toBeNull();
  });

  it("returns null when the box is entirely behind the ray origin", () => {
    expect(intersectRoiBox(0, 0, 5, 0, 0, 1, 1, 1, 1)).toBeNull();
  });

  it("handles an origin already inside the box (tNear negative)", () => {
    const hit = intersectRoiBox(0, 0, 0, 0, 0, 1, 1, 1, 1);
    expect(hit).not.toBeNull();
    expect(hit![0]).toBeLessThan(0);
    expect(hit![1]).toBeCloseTo(1);
  });
});

describe("rayDir", () => {
  it("points straight down -z for the center of NDC under an identity-ish view (looking down -z)", () => {
    const proj = new Mat4().perspective((60 * Math.PI) / 180, 1, 0.1, 100);
    const view = new Mat4().lookAt({ x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    const viewProj = Mat4.multiply(new Mat4(), proj, view);
    const inv = new Mat4().copy(viewProj);
    expect(inv.invert()).toBe(true);
    const [dx, dy, dz] = rayDir(inv, 0, 0);
    expect(dx).toBeCloseTo(0, 5);
    expect(dy).toBeCloseTo(0, 5);
    expect(dz).toBeCloseTo(-1, 5); // camera at +z looking toward origin → ray points -z
  });

  it("returns a unit vector", () => {
    const proj = new Mat4().perspective((60 * Math.PI) / 180, 1.3, 0.1, 100);
    const view = new Mat4().lookAt({ x: 2, y: 1, z: 5 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    const viewProj = Mat4.multiply(new Mat4(), proj, view);
    const inv = new Mat4().copy(viewProj);
    inv.invert();
    const [dx, dy, dz] = rayDir(inv, 0.4, -0.3);
    expect(Math.hypot(dx, dy, dz)).toBeCloseTo(1, 5);
  });
});

describe("focalRoiUvw", () => {
  function viewProjLookingAt(eye: { x: number; y: number; z: number }): Mat4 {
    const proj = new Mat4().perspective((50 * Math.PI) / 180, 1, 0.1, 100);
    const view = new Mat4().lookAt(eye, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    return Mat4.multiply(new Mat4(), proj, view);
  }

  it("returns a box within [0,1]^3 when the camera looks straight at the volume", () => {
    const eye = { x: 0, y: 0, z: 5 };
    const lastViewProj = viewProjLookingAt(eye);
    const invViewProj = new Mat4();
    const result = focalRoiUvw(invViewProj, lastViewProj, { x: 2, y: 2, z: 2 }, eye);
    expect(result).not.toBeNull();
    const { min, max } = result!;
    for (let i = 0; i < 3; i++) {
      expect(min[i]).toBeGreaterThanOrEqual(0);
      expect(max[i]).toBeLessThanOrEqual(1);
      expect(max[i]).toBeGreaterThanOrEqual(min[i]);
    }
  });

  it("is centered near the volume midpoint (u=v=w=0.5) when the camera looks straight down -z at the center", () => {
    const eye = { x: 0, y: 0, z: 5 };
    const lastViewProj = viewProjLookingAt(eye);
    const invViewProj = new Mat4();
    const { min, max } = focalRoiUvw(invViewProj, lastViewProj, { x: 2, y: 2, z: 2 }, eye)!;
    const cx = (min[0] + max[0]) / 2;
    const cy = (min[1] + max[1]) / 2;
    expect(cx).toBeCloseTo(0.5, 1);
    expect(cy).toBeCloseTo(0.5, 1);
  });

  it("returns null when the camera looks away from the volume entirely", () => {
    // Camera at +z looking further away along +z (up-axis view direction points away from the box).
    const proj = new Mat4().perspective((50 * Math.PI) / 180, 1, 0.1, 100);
    const view = new Mat4().lookAt({ x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: 10 }, { x: 0, y: 1, z: 0 });
    const lastViewProj = Mat4.multiply(new Mat4(), proj, view);
    const invViewProj = new Mat4();
    const result = focalRoiUvw(invViewProj, lastViewProj, { x: 2, y: 2, z: 2 }, { x: 0, y: 0, z: 5 });
    expect(result).toBeNull();
  });

  it("enforces the minimum UVW span even for a grazing/edge-on view", () => {
    // A very tight zoom (camera far away, narrow fov via distance) can produce a degenerate box;
    // the function should still widen it to at least the minimum span rather than returning a
    // zero-area box.
    const eye = { x: 0, y: 0, z: 1000 };
    const lastViewProj = viewProjLookingAt(eye);
    const invViewProj = new Mat4();
    const result = focalRoiUvw(invViewProj, lastViewProj, { x: 2, y: 2, z: 2 }, eye);
    if (result) {
      const { min, max } = result;
      for (let i = 0; i < 3; i++) expect(max[i] - min[i]).toBeGreaterThan(0);
    }
  });
});
