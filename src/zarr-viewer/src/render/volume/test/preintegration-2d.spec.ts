import { describe, expect, it } from "vitest";
import {
  buildGaussianPreintegrationTable,
  gaussianBlur1D,
  sampleBilinear2D,
  trapezoidalIntegrate,
  varianceFromMoments,
} from "../preintegration-2d.js";

/** Mirrors `VolumeRenderer.setTransferFunction`'s `tCurve` construction exactly, for comparison. */
function referenceTCurve(alphaCurve: Float32Array): Float32Array {
  const n = alphaCurve.length;
  const dd = 1 / Math.max(1, n - 1);
  const out = new Float32Array(n);
  let acc = 0;
  let prevA = alphaCurve[0] ?? 0;
  for (let i = 1; i < n; i++) {
    const a = alphaCurve[i] ?? 0;
    acc += 0.5 * (prevA + a) * dd;
    out[i] = acc;
    prevA = a;
  }
  return out;
}

describe("buildGaussianPreintegrationTable", () => {
  it("reproduces today's 1D tCurve exactly at sigma=0", () => {
    const n = 512;
    const alpha = new Float32Array(n).map((_, i) => (i / (n - 1)) ** 2);
    const table = buildGaussianPreintegrationTable(alpha, [0]);
    const expected = referenceTCurve(alpha);
    expect(Array.from(table)).toEqual(Array.from(expected));
  });

  it("spreads a narrow alpha spike forward as sigma increases, without changing total mass", () => {
    const n = 256;
    const alpha = new Float32Array(n);
    const spikeIndex = 128;
    alpha[spikeIndex] = 1;
    const sigmas = [0, 0.01, 0.03, 0.06];
    const table = buildGaussianPreintegrationTable(alpha, sigmas);

    // Just BEFORE the spike, blurring leaks mass earlier — the integrated value there should
    // increase monotonically with sigma (this is the actual anti-aliasing effect: the spike's
    // contribution smears across neighboring depth samples instead of appearing/disappearing
    // abruptly as the camera zooms and sample spacing crosses the spike).
    const beforeIndex = spikeIndex - 6;
    let prevBefore = -Infinity;
    for (let s = 0; s < sigmas.length; s++) {
      const before = table[s * n + beforeIndex]!;
      expect(before).toBeGreaterThanOrEqual(prevBefore);
      if (s > 0) expect(before).toBeGreaterThan(prevBefore);
      prevBefore = before;
    }

    // The integrated value well AFTER the spike (all mass captured either way) should stay
    // ~constant — blurring redistributes mass but the total integral doesn't change.
    const farIndex = n - 1;
    const totals = sigmas.map((_, s) => table[s * n + farIndex]!);
    for (const t of totals) expect(t).toBeCloseTo(totals[0]!, 2);
  });

  it("diverges from integrate-then-blur at a sharp cutoff near density 0", () => {
    const n = 256;
    const alpha = new Float32Array(n);
    // Sharp cutoff: alpha=1 for the first few bins, then 0 — a step function near density 0.
    for (let i = 0; i < 8; i++) alpha[i] = 1;
    const sigma = 0.05;
    const dd = 1 / (n - 1);

    const blurThenIntegrate = trapezoidalIntegrate(gaussianBlur1D(alpha, sigma, dd), dd);
    const integrateThenBlur = gaussianBlur1D(trapezoidalIntegrate(alpha, dd), sigma, dd);

    // These two orderings must produce measurably different results near the boundary — if they ever
    // matched, blur-then-integrate would have silently regressed to the non-commuting other order.
    let maxDiff = 0;
    for (let i = 0; i < n; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(blurThenIntegrate[i]! - integrateThenBlur[i]!));
    }
    expect(maxDiff).toBeGreaterThan(1e-3);
  });

  it("produces one row per sigma bucket, each the correct length", () => {
    const n = 64;
    const alpha = new Float32Array(n).fill(0.5);
    const table = buildGaussianPreintegrationTable(alpha, [0, 0.02, 0.04]);
    expect(table.length).toBe(3 * n);
  });
});

describe("gaussianBlur1D", () => {
  it("is the identity at sigma=0", () => {
    const curve = new Float32Array([0, 0.2, 0.9, 0.1, 0]);
    const blurred = gaussianBlur1D(curve, 0, 0.25);
    expect(Array.from(blurred)).toEqual(Array.from(curve));
  });

  it("preserves total mass (clamp-to-edge aside) for an interior spike", () => {
    const n = 200;
    const curve = new Float32Array(n);
    curve[100] = 1;
    const dd = 1 / (n - 1);
    const blurred = gaussianBlur1D(curve, 0.02, dd);
    let sum = 0;
    for (const v of blurred) sum += v;
    expect(sum).toBeCloseTo(1, 1);
  });
});

describe("trapezoidalIntegrate", () => {
  it("integrates a constant curve linearly", () => {
    const n = 11;
    const curve = new Float32Array(n).fill(2);
    const dd = 1 / (n - 1);
    const out = trapezoidalIntegrate(curve, dd);
    expect(out[0]).toBe(0);
    expect(out[n - 1]).toBeCloseTo(2, 5);
  });
});

describe("varianceFromMoments", () => {
  it("computes variance for well-separated moments", () => {
    // mean=2, meanSq=E[x^2]=8 for a distribution with actual variance 4.
    expect(varianceFromMoments(2, 8)).toBeCloseTo(4, 10);
  });

  it("clamps to 0 instead of going negative near the mean^2 ~ meanSq cancellation boundary", () => {
    expect(varianceFromMoments(0.5, 0.25 - 1e-9)).toBe(0);
  });

  it("returns ~0 for a constant field (mean^2 == meanSq)", () => {
    expect(varianceFromMoments(0.7, 0.49)).toBeCloseTo(0, 10);
  });
});

describe("sampleBilinear2D", () => {
  const width = 4;
  const height = 2;
  // Row-major (sigma=row, density=col): row 0 = [0,1,2,3], row 1 = [10,11,12,13].
  const table = new Float32Array([0, 1, 2, 3, 10, 11, 12, 13]);

  it("returns exact texel values at texel centers", () => {
    expect(sampleBilinear2D(table, width, height, 0, 0)).toBeCloseTo(0, 6);
    expect(sampleBilinear2D(table, width, height, 1, 0)).toBeCloseTo(3, 6);
    expect(sampleBilinear2D(table, width, height, 0, 1)).toBeCloseTo(10, 6);
    expect(sampleBilinear2D(table, width, height, 1, 1)).toBeCloseTo(13, 6);
  });

  it("interpolates between two known texels", () => {
    // Between column 0 (value 0) and column 1 (value 1) at row 0: u chosen so fx = u*(width-1) = 1/3,
    // i.e. 1/3 of the way from texel 0 to texel 1, so the interpolated value is 0*(2/3) + 1*(1/3).
    const u = 1 / 3 / (width - 1);
    expect(sampleBilinear2D(table, width, height, u, 0)).toBeCloseTo(1 / 3, 5);
  });

  it("clamps out-of-range u/v to the texture edge", () => {
    expect(sampleBilinear2D(table, width, height, -1, -1)).toBeCloseTo(0, 6);
    expect(sampleBilinear2D(table, width, height, 2, 2)).toBeCloseTo(13, 6);
  });
});
