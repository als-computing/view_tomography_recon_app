import { describe, it, expect } from "vitest";
import { finestTargetLevel } from "../volume/volume-geom.js";

describe("finestTargetLevel", () => {
  it("picks the finest level that isn't finer than minDisplayLevel", () => {
    // Ascending levels (0 = finest), as listUploadableLevels returns them.
    expect(finestTargetLevel([0, 1, 2, 3, 4], 2)).toBe(2);
  });

  it("falls back to the coarsest available level when nothing qualifies (a shallow pyramid)", () => {
    // Only levels 3 and 4 exist (e.g. a small mask pyramid) - nothing >= minDisplayLevel=2 is finer
    // than what's already coarsest, so this should still resolve cleanly, not throw/return undefined.
    expect(finestTargetLevel([3, 4], 2)).toBe(3);
  });

  it("returns the only level when the pyramid has just one", () => {
    expect(finestTargetLevel([5], 2)).toBe(5);
  });

  it("returns minDisplayLevel itself when it's exactly present", () => {
    expect(finestTargetLevel([0, 1, 2, 3], 2)).toBe(2);
  });

  it("returns the finest level when minDisplayLevel is 0 (no coarsening requested)", () => {
    expect(finestTargetLevel([0, 1, 2], 0)).toBe(0);
  });
});
