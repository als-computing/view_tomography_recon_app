import { describe, expect, it } from "vitest";
import { bilateralUpsample, bilateralWeight, type BilateralUpsampleParams } from "../bilateral-upsample.js";

describe("bilateralWeight", () => {
  it("is 1 when depth and normal match exactly", () => {
    expect(bilateralWeight(0.5, 0.5, [0, 1, 0], [0, 1, 0], 0.05, 0.3)).toBeCloseTo(1, 6);
  });

  it("falls off as depth diverges", () => {
    const close = bilateralWeight(0.5, 0.51, [0, 1, 0], [0, 1, 0], 0.05, 0.3);
    const far = bilateralWeight(0.5, 0.9, [0, 1, 0], [0, 1, 0], 0.05, 0.3);
    expect(close).toBeGreaterThan(far);
    expect(far).toBeCloseTo(0, 2);
  });

  it("falls off as normals diverge", () => {
    const same = bilateralWeight(0.5, 0.5, [0, 1, 0], [0, 1, 0], 0.05, 0.3);
    const opposite = bilateralWeight(0.5, 0.5, [0, 1, 0], [0, -1, 0], 0.05, 0.3);
    expect(same).toBeGreaterThan(opposite);
    expect(opposite).toBeCloseTo(0, 3);
  });
});

describe("bilateralUpsample", () => {
  function makeFlatParams(overrides: Partial<BilateralUpsampleParams> = {}): BilateralUpsampleParams {
    const lowWidth = 2;
    const lowHeight = 2;
    const fullWidth = 4;
    const fullHeight = 4;
    return {
      lowColor: new Float32Array([
        1, 0, 0, 1, 0, 1, 0, 1,
        0, 0, 1, 1, 1, 1, 0, 1,
      ]),
      lowDepth: new Float32Array([0.5, 0.5, 0.5, 0.5]),
      lowNormal: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
      lowWidth,
      lowHeight,
      fullDepth: new Float32Array(fullWidth * fullHeight).fill(0.5),
      fullNormal: (() => {
        const n = new Float32Array(fullWidth * fullHeight * 3);
        for (let i = 0; i < fullWidth * fullHeight; i++) n[i * 3 + 1] = 1;
        return n;
      })(),
      fullWidth,
      fullHeight,
      sigmaDepth: 0.05,
      sigmaNormal: 0.3,
      ...overrides,
    };
  }

  it("reduces to a plain bilinear blend over a flat depth/normal region", () => {
    const params = makeFlatParams();
    const out = bilateralUpsample(params);
    // Every full-res pixel has identical depth/normal to every low-res neighbor, so the bilateral
    // weight is uniform (1) everywhere - this is exactly a bilinear upsample. Spot-check the
    // top-left full-res pixel: closest low-res texel is (0,0) = red, so it should read close to red.
    expect(out[0]).toBeGreaterThan(0.5); // red channel dominant near the (0,0) corner
    expect(out.length).toBe(params.fullWidth * params.fullHeight * 4);
  });

  it("produces near-zero cross-edge weight at a sharp depth step (no bleeding)", () => {
    const lowWidth = 2;
    const lowHeight = 1;
    const fullWidth = 4;
    const fullHeight = 1;
    // Low-res: left texel is a thin near feature (depth 0.1), right texel is empty space (depth 1.0).
    const params: BilateralUpsampleParams = {
      lowColor: new Float32Array([1, 1, 1, 1, /* left: white */ 0, 0, 0, 0 /* right: black/empty */]),
      lowDepth: new Float32Array([0.1, 1.0]),
      lowNormal: new Float32Array([0, 1, 0, 0, 1, 0]),
      lowWidth,
      lowHeight,
      // Full-res depth matches the LEFT (near) texel everywhere in this row, simulating a full-res
      // pixel that sits right at the boundary but is actually on the near surface.
      fullDepth: new Float32Array([0.1, 0.1, 0.1, 0.1]),
      fullNormal: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
      fullWidth,
      fullHeight,
      sigmaDepth: 0.05,
      sigmaNormal: 0.3,
    };
    const out = bilateralUpsample(params);
    // A pixel near the boundary (index 2, which bilinearly straddles both low-res texels) should
    // stay close to the near (white) value, not bleed toward the far (black/empty) one, because the
    // bilateral weight against the far texel's very different depth collapses to ~0.
    expect(out[2 * 4]).toBeGreaterThan(0.9);
  });

  it("falls back to a plain bilinear blend instead of propagating NaN when every neighbor's weight underflows", () => {
    const params = makeFlatParams({
      // Every low-res depth is NaN - bilateralWeight against it is NaN everywhere, which the
      // implementation must catch and zero out rather than let corrupt the accumulated sum.
      lowDepth: new Float32Array([NaN, NaN, NaN, NaN]),
    });
    const out = bilateralUpsample(params);
    for (const v of out) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});
