import { describe, expect, it } from "vitest";
import { Mat4 } from "@zarr-viewer/math";
import { aabbScreenBbox } from "../volume-math.js";

function viewProjFor(distance: number, w: number, h: number): Mat4 {
  const view = new Mat4().lookAt(
    { x: 0, y: 0, z: distance },
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
  );
  const proj = new Mat4().perspective(Math.PI / 3, w / h, 0.1, 100);
  return new Mat4().multiplyMatrices(proj, view);
}

describe("aabbScreenBbox", () => {
  it("returns a box centered on screen for a centered unit cube", () => {
    const w = 800;
    const h = 600;
    const viewProj = viewProjFor(5, w, h);
    const box = aabbScreenBbox(viewProj, w, h, [0.5, 0.5, 0.5], 0);
    expect(box).not.toBeNull();
    const cx = (box!.minX + box!.maxX) / 2;
    const cy = (box!.minY + box!.maxY) / 2;
    expect(cx).toBeCloseTo(w / 2, 0);
    expect(cy).toBeCloseTo(h / 2, 0);
    expect(box!.maxX).toBeGreaterThan(box!.minX);
    expect(box!.maxY).toBeGreaterThan(box!.minY);
  });

  it("pads the box by `pad` on each side", () => {
    const w = 800;
    const h = 600;
    const viewProj = viewProjFor(5, w, h);
    const unpadded = aabbScreenBbox(viewProj, w, h, [0.5, 0.5, 0.5], 0)!;
    const padded = aabbScreenBbox(viewProj, w, h, [0.5, 0.5, 0.5], 10)!;
    expect(padded.minX).toBeLessThanOrEqual(unpadded.minX);
    expect(padded.minY).toBeLessThanOrEqual(unpadded.minY);
    expect(padded.maxX).toBeGreaterThanOrEqual(unpadded.maxX);
    expect(padded.maxY).toBeGreaterThanOrEqual(unpadded.maxY);
  });

  it("clamps to the viewport bounds", () => {
    const w = 100;
    const h = 100;
    // A box wide/tall relative to a close camera, but thin in depth so every corner stays in
    // front of the camera — blows past the viewport on every side without triggering the
    // behind-camera null case.
    const viewProj = viewProjFor(1, w, h);
    const box = aabbScreenBbox(viewProj, w, h, [50, 50, 0.05], 0)!;
    expect(box.minX).toBe(0);
    expect(box.minY).toBe(0);
    expect(box.maxX).toBe(w);
    expect(box.maxY).toBe(h);
  });

  it("returns null when a corner is at/behind the camera", () => {
    // Camera sits at z=0.3 looking toward -z; the box's z=+0.5 corners are behind it.
    const viewProj = viewProjFor(0.3, 800, 600);
    const box = aabbScreenBbox(viewProj, 800, 600, [0.5, 0.5, 0.5], 0);
    expect(box).toBeNull();
  });
});
