import { describe, it, expect } from "vitest";
import { padValueRange } from "../volume/zarr/array.js";

describe("padValueRange", () => {
  it("widens both ends by the given fraction of the span", () => {
    expect(padValueRange([0, 100], 0.15)).toEqual([-15, 115]);
  });

  it("defaults to a 15% margin when no fraction is given", () => {
    expect(padValueRange([0, 10])).toEqual([-1.5, 11.5]);
  });

  it("handles a negative-to-positive range", () => {
    expect(padValueRange([-10, 10], 0.1)).toEqual([-12, 12]);
  });

  it("falls back to a span of 1 when min === max (avoids a zero-width pad)", () => {
    expect(padValueRange([5, 5], 0.2)).toEqual([4.8, 5.2]);
  });

  it("a fraction of 0 returns the range unchanged", () => {
    expect(padValueRange([2, 8], 0)).toEqual([2, 8]);
  });
});
