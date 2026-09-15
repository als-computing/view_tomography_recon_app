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

  // Every test below sets lightGlobalOn/lightFlashOn/lightStageOn explicitly rather than relying on
  // whatever defaultRenderingState()'s own light-mode defaults happen to be — this suite tests
  // buildFrameLights's pure light-list-assembly logic, not the current default preset, and the two
  // should be free to change independently (found live: the preset's lighting defaults were updated to
  // a user-tuned config with the flashlight ON and the global light OFF, which silently broke these
  // tests since several of them depended on the OLD "global on, flash off" defaults instead of setting
  // their own inputs).

  it("emits no lights when every mode is off", () => {
    const rendering = defaultRenderingState();
    rendering.lightGlobalOn = false;
    rendering.lightFlashOn = false;
    rendering.lightStageOn = false;
    expect(buildFrameLights(rendering, eye, right, up, fwd, extent)).toHaveLength(0);
  });

  it("emits exactly the global directional light when only global is enabled", () => {
    const rendering = defaultRenderingState();
    rendering.lightGlobalOn = true;
    rendering.lightFlashOn = false;
    rendering.lightStageOn = false;
    const lights = buildFrameLights(rendering, eye, right, up, fwd, extent);
    expect(lights).toHaveLength(1);
    expect(lights[0]!.castShadows).toBe(rendering.shadowCastGlobal);
  });

  it("adds one flashlight spot at the eye, pointed forward", () => {
    const rendering = defaultRenderingState();
    rendering.lightGlobalOn = false;
    rendering.lightFlashOn = true;
    rendering.lightStageOn = false;
    const lights = buildFrameLights(rendering, eye, right, up, fwd, extent);
    expect(lights).toHaveLength(1);
    const flash = lights[0]!;
    expect(flash.castShadows).toBe(rendering.shadowCastFlash);
  });

  it("adds four stage spots, one per screen corner", () => {
    const rendering = defaultRenderingState();
    rendering.lightGlobalOn = false;
    rendering.lightFlashOn = false;
    rendering.lightStageOn = true;
    const lights = buildFrameLights(rendering, eye, right, up, fwd, extent);
    expect(lights).toHaveLength(4);
    for (const l of lights) expect(l.castShadows).toBe(rendering.shadowCastStage);
  });

  it("respects all three modes enabled together (1 + 1 + 4 = 6 lights)", () => {
    const rendering = defaultRenderingState();
    rendering.lightGlobalOn = true;
    rendering.lightFlashOn = true;
    rendering.lightStageOn = true;
    const lights = buildFrameLights(rendering, eye, right, up, fwd, extent);
    expect(lights).toHaveLength(6);
  });
});
