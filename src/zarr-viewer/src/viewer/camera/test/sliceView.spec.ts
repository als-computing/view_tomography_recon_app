/**
 * Tests for slice-view camera framing and active-slice read/write. `frameSliceCamera`/`enterViewMode`
 * are tested against lightweight structural fakes for `OrbitControls`/`Node` (real `OrbitControls`
 * attaches DOM listeners in its constructor, which isn't available under Vitest's "node" environment)
 * — only the `target.set`/`position.set`/`syncFromNode`/`update` surface `CameraContext` actually uses.
 */
import { describe, it, expect, vi } from "vitest";
import { Vec3 } from "@zarr-viewer/math";
import { defaultRenderingState, defaultCroppingState } from "../../RenderingState.js";
import {
  frameSliceCamera,
  enterViewMode,
  activeSlice,
  setActiveSlice,
  type CameraContext,
} from "../sliceView.js";

function fakeContext(sizeSim = { x: 2, y: 4, z: 6 }): CameraContext & {
  controls: { target: Vec3; syncFromNode: () => void; update: (dt: number) => void };
  camera: { position: Vec3 };
} {
  return {
    controls: {
      target: new Vec3(0, 0, 0),
      syncFromNode: vi.fn(),
      update: vi.fn(),
    },
    camera: { position: new Vec3(0, 0, 0) },
    sizeSim,
  } as unknown as CameraContext & {
    controls: { target: Vec3; syncFromNode: () => void; update: (dt: number) => void };
    camera: { position: Vec3 };
  };
}

describe("frameSliceCamera", () => {
  it("frames the full volume view with the standard 3/4 angle", () => {
    const ctx = fakeContext({ x: 2, y: 2, z: 2 });
    frameSliceCamera(ctx, "volume", { x: 0.5, y: 0.5, z: 0.5 });
    expect(ctx.controls.target.x).toBe(0);
    expect(ctx.controls.target.y).toBe(0);
    expect(ctx.controls.target.z).toBe(0);
    const extent = 2;
    expect(ctx.camera.position.x).toBeCloseTo(extent * 1.2);
    expect(ctx.camera.position.y).toBeCloseTo(extent * 0.85);
    expect(ctx.camera.position.z).toBeCloseTo(extent * 1.2);
  });

  it("targets the slice plane's world position for xPlane", () => {
    const ctx = fakeContext({ x: 2, y: 4, z: 6 });
    frameSliceCamera(ctx, "xPlane", { x: 0.75, y: 0.5, z: 0.5 });
    const expectedPx = (0.75 - 0.5) * 2; // 0.5
    expect(ctx.controls.target.x).toBeCloseTo(expectedPx);
    expect(ctx.controls.target.y).toBe(0);
    expect(ctx.controls.target.z).toBe(0);
    // Camera sits off to the side along +x from the target.
    expect(ctx.camera.position.x).toBeGreaterThan(expectedPx);
  });

  it("calls syncFromNode and update to commit the new pose", () => {
    const ctx = fakeContext();
    frameSliceCamera(ctx, "volume", { x: 0.5, y: 0.5, z: 0.5 });
    expect(ctx.controls.syncFromNode).toHaveBeenCalledOnce();
    expect(ctx.controls.update).toHaveBeenCalledWith(0);
  });
});

describe("enterViewMode", () => {
  it("sets rendering.viewMode and calls applyRender", () => {
    const ctx = fakeContext();
    const rendering = defaultRenderingState();
    const cropping = defaultCroppingState();
    const applyRender = vi.fn();
    enterViewMode(ctx, "xPlane", rendering, cropping, applyRender, false);
    expect(rendering.viewMode).toBe("xPlane");
    expect(applyRender).toHaveBeenCalledOnce();
  });

  it("enables the matching slice axis + overlay for a plane mode", () => {
    const ctx = fakeContext();
    const rendering = defaultRenderingState();
    const cropping = defaultCroppingState();
    enterViewMode(ctx, "yPlane", rendering, cropping, vi.fn(), false);
    expect(cropping.enY).toBe(true);
    expect(cropping.showPlanes).toBe(true);
    expect(cropping.enX).toBe(false);
    expect(cropping.enZ).toBe(false);
  });

  it("does not touch slice enables for volume mode", () => {
    const ctx = fakeContext();
    const rendering = defaultRenderingState();
    const cropping = defaultCroppingState();
    enterViewMode(ctx, "volume", rendering, cropping, vi.fn(), false);
    expect(cropping.enX).toBe(false);
    expect(cropping.enY).toBe(false);
    expect(cropping.enZ).toBe(false);
    expect(cropping.showPlanes).toBe(false);
  });

  it("reframes the camera only when reframe is true", () => {
    const ctx = fakeContext();
    const rendering = defaultRenderingState();
    const cropping = defaultCroppingState();
    enterViewMode(ctx, "zPlane", rendering, cropping, vi.fn(), false);
    expect(ctx.controls.syncFromNode).not.toHaveBeenCalled();
    enterViewMode(ctx, "zPlane", rendering, cropping, vi.fn(), true);
    expect(ctx.controls.syncFromNode).toHaveBeenCalledOnce();
  });
});

describe("activeSlice / setActiveSlice", () => {
  it("returns null in volume mode", () => {
    const rendering = defaultRenderingState();
    const cropping = defaultCroppingState();
    expect(activeSlice(rendering, cropping)).toBeNull();
  });

  it("returns the axis + value for a plane mode", () => {
    const rendering = defaultRenderingState();
    rendering.viewMode = "yPlane";
    const cropping = defaultCroppingState();
    cropping.sliceY = 0.3;
    expect(activeSlice(rendering, cropping)).toEqual({ axis: "y", value: 0.3 });
  });

  it("setActiveSlice writes the axis matching the current view mode, clamped to [0,1]", () => {
    const rendering = defaultRenderingState();
    rendering.viewMode = "xPlane";
    const cropping = defaultCroppingState();
    const applyRender = vi.fn();
    setActiveSlice(1.5, rendering, cropping, applyRender);
    expect(cropping.sliceX).toBe(1);
    expect(applyRender).toHaveBeenCalledOnce();
  });

  it("setActiveSlice is a no-op in volume mode", () => {
    const rendering = defaultRenderingState();
    const cropping = defaultCroppingState();
    const applyRender = vi.fn();
    setActiveSlice(0.9, rendering, cropping, applyRender);
    expect(applyRender).not.toHaveBeenCalled();
  });
});
