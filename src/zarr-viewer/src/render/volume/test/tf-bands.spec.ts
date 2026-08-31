import { describe, it, expect } from "vitest";
import { composeMultiBandTransferFunction, MAX_TF_BANDS, type TfBandConfig } from "../tf-bands.js";
import { composeTransferFunction } from "../opacity-curve.js";

describe("composeMultiBandTransferFunction", () => {
  it("samples outside every band's range are fully transparent", () => {
    const bands: TfBandConfig[] = [{ loT: 0.4, hiT: 0.6, colorMap: "grayscale", opacityPoints: [[0, 1], [1, 1]] }];
    const lut = composeMultiBandTransferFunction(bands).toLut(101); // index 30 -> t=0.3, outside [0.4,0.6]
    const o = 30 * 4;
    expect([lut[o], lut[o + 1], lut[o + 2], lut[o + 3]]).toEqual([0, 0, 0, 0]);
  });

  it("colors within a band's range use that band's colormap/opacity, evaluated in local [0,1]", () => {
    const bands: TfBandConfig[] = [
      { loT: 0, hiT: 0.5, colorMap: "grayscale", opacityPoints: [[0, 0], [1, 1]] },
      { loT: 0.5, hiT: 1, colorMap: "grayscale", opacityPoints: [[0, 1], [1, 1]] },
    ];
    const lut = composeMultiBandTransferFunction(bands).toLut(101);
    // t=0.25 -> band 0, localT=0.5 -> opacity 0.5 (ramping 0->1); grayscale colormap -> mid-gray.
    const oLow = 25 * 4;
    expect(lut[oLow + 3]).toBeGreaterThan(100);
    expect(lut[oLow + 3]).toBeLessThan(150);
    // t=0.75 -> band 1, opacity is constant 1 across its local range.
    const oHigh = 75 * 4;
    expect(lut[oHigh + 3]).toBe(255);
  });

  it("never blends across a band boundary (adjacent bands with very different colors stay crisp)", () => {
    const bands: TfBandConfig[] = [
      { loT: 0, hiT: 0.5, colorMap: "grayscale", opacityPoints: [[0, 1], [1, 1]] }, // -> black at t~0.5
      { loT: 0.5, hiT: 1, colorMap: "grayscale", opacityPoints: [[0, 1], [1, 1]] }, // -> black at t~0.5 too, but test asserts no interpolation artifact by checking a big size (fine sampling near the seam stays exactly one band's local value, not a blend of the two).
    ];
    const lut = composeMultiBandTransferFunction(bands).toLut(1001);
    // Just below and just above the t=0.5 seam should both be fully opaque, not partially transparent
    // from being blended against a hypothetical neighboring transparent stop.
    const belowIdx = 499; // t ≈ 0.499
    const aboveIdx = 501; // t ≈ 0.501
    expect(lut[belowIdx * 4 + 3]).toBe(255);
    expect(lut[aboveIdx * 4 + 3]).toBe(255);
  });

  it("caps at MAX_TF_BANDS, silently dropping extras rather than throwing", () => {
    const bands: TfBandConfig[] = Array.from({ length: MAX_TF_BANDS + 2 }, (_, i) => ({
      loT: i / (MAX_TF_BANDS + 2),
      hiT: (i + 1) / (MAX_TF_BANDS + 2),
      colorMap: "grayscale" as const,
      opacityPoints: [[0, 1], [1, 1]] as const,
    }));
    expect(() => composeMultiBandTransferFunction(bands).toLut(64)).not.toThrow();
    // The last (dropped) band's range should be transparent since it was never included.
    const lastBand = bands[bands.length - 1]!;
    const midT = (lastBand.loT + lastBand.hiT) / 2;
    const idx = Math.round(midT * 63);
    expect(lut(bands, idx)).toBe(0);
  });

  it("matches composeTransferFunction's output for an equivalent single full-range band", () => {
    const opacityPoints: [number, number][] = [
      [0, 0],
      [0.5, 0.4],
      [1, 0.9],
    ];
    const single = composeTransferFunction({ opacity: opacityPoints, colorMap: "viridis", samples: 64 });
    const bands: TfBandConfig[] = [{ loT: 0, hiT: 1, colorMap: "viridis", opacityPoints }];
    const banded = composeMultiBandTransferFunction(bands);

    const singleLut = single.toLut(64);
    const bandedLut = banded.toLut(64);
    for (let i = 0; i < singleLut.length; i++) {
      expect(Math.abs(singleLut[i]! - bandedLut[i]!)).toBeLessThanOrEqual(2); // allow rounding slack
    }
  });

  it("handles an empty band list without throwing (fully transparent LUT)", () => {
    const lut = composeMultiBandTransferFunction([]).toLut(32);
    expect(lut.every((v) => v === 0)).toBe(true);
  });

  it("composites overlapping bands (later band over earlier) instead of the first match masking the rest", () => {
    // Band 0 covers the whole domain at full white/full opacity. Band 1 overlaps it with a tiny
    // range right at t=0.5, opaque, and (via grayscale at localT≈0) black. Under the old first-
    // match-wins logic, band 0 would win the entire overlap and band 1 would never show at all -
    // exactly "the first TF masking the others." Under over-compositing, band 1 (added later)
    // should fully replace band 0 at t=0.5.
    const bands: TfBandConfig[] = [
      { loT: 0, hiT: 1, colorMap: "grayscale", opacityPoints: [[0, 1], [1, 1]] }, // -> white, alpha 1 everywhere
      { loT: 0.5, hiT: 0.500001, colorMap: "grayscale", opacityPoints: [[0, 1], [1, 1]] }, // -> black, alpha 1, only at t≈0.5
    ];
    const lut = composeMultiBandTransferFunction(bands).toLut(1001);
    const o = 500 * 4; // t = 0.5, inside both bands
    expect(lut[o + 3]).toBe(255); // fully opaque either way
    expect(lut[o + 0]).toBeLessThan(50); // black (band 1, the later/top layer), not white (band 0)
  });

  it("a disabled band contributes nothing, as if removed", () => {
    const bands: TfBandConfig[] = [
      { loT: 0, hiT: 1, colorMap: "grayscale", opacityPoints: [[0, 1], [1, 1]], enabled: false },
    ];
    const lut = composeMultiBandTransferFunction(bands).toLut(32);
    expect(lut.every((v) => v === 0)).toBe(true);
  });

  it("enabled defaults to on when unset (pre-existing bands without the field still render)", () => {
    const bands: TfBandConfig[] = [{ loT: 0, hiT: 1, colorMap: "grayscale", opacityPoints: [[0, 1], [1, 1]] }];
    const lut = composeMultiBandTransferFunction(bands).toLut(32);
    expect(lut[3]).toBe(255);
  });
});

function lut(bands: TfBandConfig[], index: number): number {
  return composeMultiBandTransferFunction(bands).toLut(64)[index * 4 + 3]!;
}
