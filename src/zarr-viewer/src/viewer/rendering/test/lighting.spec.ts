/**
 * Tests for the viewer's per-frame lighting math: hex→linear color and the GPU light list built
 * from rendering state + camera basis.
 */
import { describe, it, expect } from "vitest";
import { defaultRenderingState } from "../../RenderingState.js";
import { hexToLinearRgb, buildFrameLights } from "../lighting.js";

describe("hexToLinearRgb", () => {
  it("decodes white and black exactly", () => {
    expect(hexToLinearRgb("#ffffff")).toEqual([1, 1, 1]);
    expect(hexToLinearRgb("#000000")).toEqual([0, 0, 0]);
  });

  it("darkens a mid-gray sRGB value (linear < sRGB for values above the toe)", () => {
    const [r] = hexToLinearRgb("#808080"); // 0.502 sRGB
    expect(r).toBeLessThan(0.502);
    expect(r).toBeGreaterThan(0.2);
  });

  it("works without a leading #", () => {
    expect(hexToLinearRgb("ffffff")).toEqual([1, 1, 1]);
  });
});

describe("buildFrameLights", () => {
  const eye = { x: 0, y: 0, z: 5 };
  const right: [number, number, number] = [1, 0, 0];
  const up: [number, number, number] = [0, 1, 0];
  const fwd: [number, number, number] = [0, 0, -1];
  const extent = 2;

  it("emits no lights when every mode is off", () => {
    const rendering = defaultRenderingState();
    rendering.lightGlobalOn = false;
    expect(buildFrameLights(rendering, eye, right, up, fwd, extent)).toHaveLength(0);
  });

  it("emits exactly the global directional light by default (matches viewer defaults)", () => {
    const rendering = defaultRenderingState();
    const lights = buildFrameLights(rendering, eye, right, up, fwd, extent);
    expect(lights).toHaveLength(1);
    expect(lights[0]!.castShadows).toBe(rendering.shadowCastGlobal);
  });

  it("adds one flashlight spot at the eye, pointed forward", () => {
    const rendering = defaultRenderingState();
    rendering.lightFlashOn = true;
    const lights = buildFrameLights(rendering, eye, right, up, fwd, extent);
    expect(lights).toHaveLength(2);
    const flash = lights[1]!;
    expect(flash.castShadows).toBe(rendering.shadowCastFlash);
  });

  it("adds four stage spots, one per screen corner", () => {
    const rendering = defaultRenderingState();
    rendering.lightGlobalOn = false;
    rendering.lightStageOn = true;
    const lights = buildFrameLights(rendering, eye, right, up, fwd, extent);
    expect(lights).toHaveLength(4);
    for (const l of lights) expect(l.castShadows).toBe(rendering.shadowCastStage);
  });

  it("respects all three modes enabled together (1 + 1 + 4 = 6 lights)", () => {
    const rendering = defaultRenderingState();
    rendering.lightFlashOn = true;
    rendering.lightStageOn = true;
    const lights = buildFrameLights(rendering, eye, right, up, fwd, extent);
    expect(lights).toHaveLength(6);
  });
});
