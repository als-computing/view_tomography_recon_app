import { describe, it, expect } from "vitest";
import { defaultRenderingState, mergeDefined } from "../RenderingState.js";

describe("WebGpuRenderingState.tfBands", () => {
  it("defaults to unset (off) so existing single-TF behavior is unchanged for old/serialized state", () => {
    const state = defaultRenderingState();
    expect(state.tfBands).toBeUndefined();
  });

  it("mergeDefined leaves tfBands untouched when the patch omits it", () => {
    const state = defaultRenderingState();
    mergeDefined(state, { colorMap: "viridis" });
    expect(state.tfBands).toBeUndefined();
    expect(state.colorMap).toBe("viridis");
  });

  it("mergeDefined can set tfBands when a patch (e.g. from a share-link) provides it", () => {
    const state = defaultRenderingState();
    const bands = [{ loT: 0, hiT: 1, colorMap: "bone" as const, opacityPoints: [[0, 1], [1, 1]] as const }];
    mergeDefined(state, { tfBands: bands });
    expect(state.tfBands).toEqual(bands);
  });
});
