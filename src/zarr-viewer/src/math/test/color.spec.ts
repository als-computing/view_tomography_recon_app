/**
 * Pure-function tests for math/color.ts — the canonical color module other modules
 * (render/color.ts, render/volume/colormaps.ts) are expected to build on rather than duplicate.
 */
import { describe, it, expect } from "vitest";
import {
  rgb,
  rgba,
  isColor3Tuple,
  isColor4Tuple,
  writeColor3,
  writeColor4,
  asColor3,
  asColor4,
  scaleColor3,
  scaleColor4,
  multiplyColor3,
  lerpColor3,
  lerpColor4,
  clampColor3,
  clampColor4,
  colorToCss,
  hexToColor3,
  srgbToLinearChannel,
  linearToSrgbChannel,
  srgbToLinear,
  linearToSrgb,
  hsvToRgb,
} from "../color.js";

describe("color tuple helpers", () => {
  it("rgb/rgba construct tuples verbatim", () => {
    expect(rgb(0.1, 0.2, 0.3)).toEqual([0.1, 0.2, 0.3]);
    expect(rgba(0.1, 0.2, 0.3)).toEqual([0.1, 0.2, 0.3, 1]);
    expect(rgba(0.1, 0.2, 0.3, 0.5)).toEqual([0.1, 0.2, 0.3, 0.5]);
  });

  it("isColor3Tuple / isColor4Tuple discriminate by array length", () => {
    expect(isColor3Tuple([1, 2, 3])).toBe(true);
    expect(isColor3Tuple({ x: 1, y: 2, z: 3 })).toBe(false);
    expect(isColor4Tuple([1, 2, 3, 4])).toBe(true);
    expect(isColor4Tuple([1, 2, 3])).toBe(false);
  });

  it("writeColor3/writeColor4 read from tuples and {x,y,z[,w]} vectors", () => {
    expect(writeColor3([0, 0, 0], [1, 2, 3])).toEqual([1, 2, 3]);
    expect(writeColor3([0, 0, 0], { x: 1, y: 2, z: 3 })).toEqual([1, 2, 3]);
    expect(writeColor4([0, 0, 0, 0], [1, 2, 3, 4])).toEqual([1, 2, 3, 4]);
    expect(writeColor4([0, 0, 0, 0], [1, 2, 3])).toEqual([1, 2, 3, 1]);
    expect(writeColor4([0, 0, 0, 0], { x: 1, y: 2, z: 3, w: 0.5 })).toEqual([1, 2, 3, 0.5]);
    expect(writeColor4([0, 0, 0, 0], { x: 1, y: 2, z: 3 })).toEqual([1, 2, 3, 1]);
  });

  it("asColor3/asColor4 normalize without an explicit out param", () => {
    expect(asColor3({ x: 1, y: 2, z: 3 })).toEqual([1, 2, 3]);
    expect(asColor4({ x: 1, y: 2, z: 3 })).toEqual([1, 2, 3, 1]);
  });
});

describe("color arithmetic", () => {
  it("scaleColor3/scaleColor4 scale every channel including alpha", () => {
    expect(scaleColor3([0, 0, 0], [1, 2, 3], 2)).toEqual([2, 4, 6]);
    expect(scaleColor4([0, 0, 0, 0], [1, 2, 3, 4], 2)).toEqual([2, 4, 6, 8]);
  });

  it("multiplyColor3 is component-wise", () => {
    expect(multiplyColor3([0, 0, 0], [2, 3, 4], [5, 6, 7])).toEqual([10, 18, 28]);
  });

  it("lerpColor3 interpolates each channel independently", () => {
    expect(lerpColor3([0, 0, 0], [0, 0, 0], [10, 20, 30], 0)).toEqual([0, 0, 0]);
    expect(lerpColor3([0, 0, 0], [0, 0, 0], [10, 20, 30], 1)).toEqual([10, 20, 30]);
    expect(lerpColor3([0, 0, 0], [0, 0, 0], [10, 20, 30], 0.5)).toEqual([5, 10, 15]);
  });

  it("lerpColor4 interpolates alpha too", () => {
    expect(lerpColor4([0, 0, 0, 0], [0, 0, 0, 0], [10, 20, 30, 1], 0.5)).toEqual([5, 10, 15, 0.5]);
  });

  it("lerpColor3 does not mutate its inputs even when out aliases neither", () => {
    const a: [number, number, number] = [1, 2, 3];
    const b: [number, number, number] = [9, 8, 7];
    lerpColor3([0, 0, 0], a, b, 0.5);
    expect(a).toEqual([1, 2, 3]);
    expect(b).toEqual([9, 8, 7]);
  });

  it("lerpColor3/lerpColor4/multiplyColor3 are correct when out aliases a or b", () => {
    // These functions read every channel before writing any, so overwriting the input array
    // in place must produce the same result as writing into a separate output array.
    const a3: [number, number, number] = [1, 2, 3];
    const expectedLerp3 = lerpColor3([0, 0, 0], [1, 2, 3], [9, 8, 7], 0.5);
    expect(lerpColor3(a3, a3, [9, 8, 7], 0.5)).toEqual(expectedLerp3);

    const b3: [number, number, number] = [9, 8, 7];
    const expectedLerp3b = lerpColor3([0, 0, 0], [1, 2, 3], [9, 8, 7], 0.5);
    expect(lerpColor3(b3, [1, 2, 3], b3, 0.5)).toEqual(expectedLerp3b);

    const a4: [number, number, number, number] = [1, 2, 3, 0.2];
    const expectedLerp4 = lerpColor4([0, 0, 0, 0], [1, 2, 3, 0.2], [9, 8, 7, 0.8], 0.25);
    expect(lerpColor4(a4, a4, [9, 8, 7, 0.8], 0.25)).toEqual(expectedLerp4);

    const m3: [number, number, number] = [2, 3, 4];
    const expectedMul = multiplyColor3([0, 0, 0], [2, 3, 4], [5, 6, 7]);
    expect(multiplyColor3(m3, m3, [5, 6, 7])).toEqual(expectedMul);
  });

  it("clampColor3/clampColor4 clip channels into [0,1] including alpha", () => {
    expect(clampColor3([0, 0, 0], [-1, 0.5, 2])).toEqual([0, 0.5, 1]);
    expect(clampColor4([0, 0, 0, 0], [-1, 0.5, 2, 1.5])).toEqual([0, 0.5, 1, 1]);
  });
});

describe("CSS / hex / sRGB conversions", () => {
  it("colorToCss rounds to 8-bit and omits alpha when opaque", () => {
    expect(colorToCss([1, 0, 0, 1])).toBe("rgb(255,0,0)");
    expect(colorToCss([1, 0, 0, 0.5])).toBe("rgba(255,0,0,0.5)");
    expect(colorToCss([1, 0, 0], 0.25)).toBe("rgba(255,0,0,0.25)");
  });

  it("hexToColor3 parses 3- and 6-digit hex, with or without '#'", () => {
    expect(hexToColor3("#ff0000")).toEqual([1, 0, 0]);
    expect(hexToColor3("00ff00")).toEqual([0, 1, 0]);
    expect(hexToColor3("#00f")).toEqual([0, 0, 1]);
  });

  it("hexToColor3 falls back to black on malformed input", () => {
    expect(hexToColor3("#zzzzzz")[0]).toBeNaN();
    expect(hexToColor3("#1234")).toEqual([0, 0, 0]);
  });

  it("srgbToLinearChannel / linearToSrgbChannel round-trip", () => {
    for (const v of [0, 0.02, 0.2, 0.5, 0.9, 1]) {
      const roundTripped = linearToSrgbChannel(srgbToLinearChannel(v));
      expect(roundTripped).toBeCloseTo(v, 5);
    }
  });

  it("srgbToLinear/linearToSrgb accept both tuple and (r,g,b) call forms", () => {
    const fromTuple = srgbToLinear([0.5, 0.5, 0.5]);
    const fromScalars = srgbToLinear(0.5, 0.5, 0.5);
    expect(fromTuple).toEqual(fromScalars);
    expect(linearToSrgb(fromTuple)).toEqual(linearToSrgb(fromScalars[0], fromScalars[1], fromScalars[2]));
  });
});

describe("hsvToRgb", () => {
  it("maps primary hues to pure channels at full saturation/value", () => {
    expect(hsvToRgb(0, 1, 1)).toEqual([1, 0, 0]);
    expect(hsvToRgb(1 / 3, 1, 1)).toEqual([0, 1, 0]);
    expect(hsvToRgb(2 / 3, 1, 1)).toEqual([0, 0, 1]);
  });

  it("zero saturation yields a neutral gray at every hue", () => {
    expect(hsvToRgb(0.3, 0, 0.7)).toEqual([0.7, 0.7, 0.7]);
  });
});
