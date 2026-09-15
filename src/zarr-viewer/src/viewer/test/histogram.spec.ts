/**
 * Tests for the auto-contrast helpers: percentile auto-window and contrast-limited equalization.
 */
import { describe, it, expect } from "vitest";
import { autoWindow, buildEqualizeRemap, rebinThroughRemap } from "../histogram.js";

describe("autoWindow", () => {
  it("returns the fallback unchanged when the histogram (excluding bin 0) is empty", () => {
    const hist = new Float32Array(10); // all zero, including bin 0
    expect(autoWindow(hist, [0.1, 0.9])).toEqual([0.1, 0.9]);
  });

  it("ignores bin 0 (background) mass when computing percentiles", () => {
    const n = 100;
    const hist = new Float32Array(n);
    hist[0] = 1_000_000; // huge background mass — must not skew the window
    for (let i = 10; i < 90; i++) hist[i] = 1; // uniform foreground mass
    const [lo, hi] = autoWindow(hist, [0, 1]);
    // 2nd/98th percentile of a uniform [10,90) distribution should land near the ends of that range.
    expect(lo).toBeGreaterThan(0.05);
    expect(lo).toBeLessThan(0.2);
    expect(hi).toBeGreaterThan(0.8);
    expect(hi).toBeLessThan(0.95);
  });

  it("widens a degenerate (near-zero-width) window to at least 0.02", () => {
    const n = 100;
    const hist = new Float32Array(n);
    hist[50] = 1; // all mass in one bin → lo and hi percentile bins coincide
    const [lo, hi] = autoWindow(hist, [0, 1]);
    expect(hi - lo).toBeGreaterThanOrEqual(0.02 - 1e-9);
  });
});

describe("buildEqualizeRemap", () => {
  it("returns the identity ramp when the histogram (excluding bin 0) is empty", () => {
    const n = 8;
    const hist = new Float32Array(n);
    const lut = buildEqualizeRemap(hist, 2);
    for (let i = 0; i < n; i++) expect(lut[i]).toBeCloseTo(i / (n - 1));
  });

  it("produces a monotonically non-decreasing LUT ending at 1", () => {
    const n = 16;
    const hist = new Float32Array(n);
    for (let i = 1; i < n; i++) hist[i] = ((i * 37) % 23) + 1; // deterministic, varied
    const lut = buildEqualizeRemap(hist, 2);
    expect(lut[n - 1]).toBeCloseTo(1, 5);
    for (let i = 1; i < n; i++) expect(lut[i]!).toBeGreaterThanOrEqual(lut[i - 1]!);
  });

  it("clips a dominant bin's contribution relative to an unclipped run", () => {
    const n = 10;
    const hist = new Float32Array(n);
    hist[5] = 1000; // one huge spike
    for (let i = 1; i < n; i++) if (i !== 5) hist[i] = 1;
    const clipped = buildEqualizeRemap(hist, 1.5);
    const unclipped = buildEqualizeRemap(hist, 1000); // effectively no clipping
    // With clipping, the spike's excess mass is redistributed, so bins after it get more separation.
    expect(clipped[6]! - clipped[4]!).toBeLessThan(unclipped[6]! - unclipped[4]!);
  });
});

describe("rebinThroughRemap", () => {
  it("is a no-op under the identity remap", () => {
    const n = 8;
    const hist = Float32Array.from({ length: n }, (_, i) => i + 1);
    const identity = Float32Array.from({ length: n }, (_, i) => i / (n - 1));
    const out = rebinThroughRemap(hist, identity);
    for (let i = 0; i < n; i++) expect(out[i]).toBeCloseTo(hist[i]!);
  });

  it("conserves total mass", () => {
    const n = 8;
    const hist = Float32Array.from({ length: n }, (_, i) => i + 1);
    const remap = Float32Array.from({ length: n }, (_, i) => ((i * 53) % 100) / 100);
    const out = rebinThroughRemap(hist, remap);
    const sum = (a: Float32Array) => Array.from(a).reduce((s, v) => s + v, 0);
    expect(sum(out)).toBeCloseTo(sum(hist), 4);
  });

  it("moves all mass to bin 0 when the remap collapses everything to 0", () => {
    const n = 8;
    const hist = Float32Array.from({ length: n }, (_, i) => i + 1);
    const collapse = new Float32Array(n); // all zeros
    const out = rebinThroughRemap(hist, collapse);
    const total = Array.from(hist).reduce((s, v) => s + v, 0);
    expect(out[0]).toBeCloseTo(total);
    for (let i = 1; i < n; i++) expect(out[i]).toBe(0);
  });
});
