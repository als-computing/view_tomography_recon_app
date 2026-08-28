import { describe, expect, it } from "vitest";
import { approximateShadingBanner, computeProvenance } from "../volume-provenance.js";

describe("computeProvenance", () => {
  it("reports the real shadow representation and taau frame count for baseline", () => {
    const p = computeProvenance("baseline", "tf-hash", 1, 42, true);
    expect(p.shaderConfig).toBe("baseline");
    expect(p.multiScatterOctaves).toBe(0);
    expect(p.taauFrames).toBe(42);
    expect(p.shadowMode).toBe("light-axis-sweep");
    expect(p.transferFunction).toBe("tf-hash");
    expect(p.renderScale).toBe(1);
  });

  it("reports shadowMode 'none' when shadows are disabled", () => {
    const p = computeProvenance("quality", "tf-hash", 1, 0, false);
    expect(p.shadowMode).toBe("none");
  });

  it("reports multiScatterOctaves from the quality specialization", () => {
    const p = computeProvenance("quality", "tf-hash", 0.5, 10, false);
    expect(p.multiScatterOctaves).toBe(2);
  });

  it("lets extras override computed fields", () => {
    const p = computeProvenance("baseline", "tf-hash", 1, 0, false, { renderScale: 0.75 });
    expect(p.renderScale).toBe(0.75);
  });
});

describe("approximateShadingBanner", () => {
  it("is null for baseline and fast", () => {
    expect(approximateShadingBanner("baseline")).toBeNull();
    expect(approximateShadingBanner("fast")).toBeNull();
  });

  it("describes active approximations for quality", () => {
    expect(approximateShadingBanner("quality")).toBe(
      "Approximate shading: multi-scatter ×2, bent-normal ambient",
    );
  });
});
