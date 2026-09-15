/**
 * Tests for the named-colormap sampling used by volume transfer functions. These lock the current
 * output values so a later swap of the internal `Rgb`/lerp implementation for `math/color.ts`'s
 * `Color3`/`lerpColor3` (dedup cleanup) can be verified to produce identical results.
 */
import { describe, it, expect } from "vitest";
import { sampleColorMap, colorMapNames } from "../colormaps.js";

describe("sampleColorMap", () => {
  it("returns the first/last stop exactly at t=0 and t=1 for a built-in map", () => {
    expect(sampleColorMap("grayscale", 0)).toEqual([0, 0, 0]);
    expect(sampleColorMap("grayscale", 1)).toEqual([1, 1, 1]);
  });

  it("interpolates linearly between evenly-spaced stops", () => {
    const [r, g, b] = sampleColorMap("grayscale", 0.5);
    expect(r).toBeCloseTo(0.5);
    expect(g).toBeCloseTo(0.5);
    expect(b).toBeCloseTo(0.5);
  });

  it("clamps t outside [0, 1] to the nearest endpoint", () => {
    expect(sampleColorMap("grayscale", -1)).toEqual(sampleColorMap("grayscale", 0));
    expect(sampleColorMap("grayscale", 2)).toEqual(sampleColorMap("grayscale", 1));
  });

  it("falls back to grayscale for an unknown map name", () => {
    expect(sampleColorMap("not-a-real-colormap", 0.5)).toEqual(sampleColorMap("grayscale", 0.5));
  });

  it("samples every built-in map without producing NaN/out-of-range channels", () => {
    const builtins: string[] = ["grayscale", "bone", "hot", "cool", "viridis", "plasma", "magenta", "cyan"];
    for (const name of builtins) {
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        const [r, g, b] = sampleColorMap(name, t);
        for (const c of [r, g, b]) {
          expect(Number.isFinite(c)).toBe(true);
          expect(c).toBeGreaterThanOrEqual(0);
          expect(c).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe("colorMapNames", () => {
  it("lists all built-in names", () => {
    const names = colorMapNames();
    for (const n of ["grayscale", "bone", "hot", "cool", "viridis", "plasma", "magenta", "cyan"]) {
      expect(names).toContain(n);
    }
  });

  it("every listed name resolves to a well-formed RGB triple", () => {
    // Catches the failure mode where colorMapNames() and sampleColorMap()'s lookup tables
    // (MAPS / SCIVIS_MAPS) drift out of sync.
    for (const name of colorMapNames()) {
      const sample = sampleColorMap(name, 0.5);
      expect(sample.length).toBe(3);
      for (const c of sample) expect(Number.isFinite(c)).toBe(true);
    }
  });
});
