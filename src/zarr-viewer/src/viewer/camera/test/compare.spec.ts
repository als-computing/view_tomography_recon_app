import { describe, it, expect } from "vitest";
import { camsEqual, type CameraPoseLike } from "../compare.js";

function pose(overrides: Partial<CameraPoseLike> = {}): CameraPoseLike {
  return {
    target: [0, 0, 0],
    offset: [0, 0, 5],
    gazeUp: [0, 1, 0],
    distance: 5,
    ...overrides,
  };
}

describe("camsEqual", () => {
  it("is false when either pose is null", () => {
    expect(camsEqual(null, pose())).toBe(false);
    expect(camsEqual(pose(), null)).toBe(false);
    expect(camsEqual(null, null)).toBe(false);
  });

  it("is true for an identical pose", () => {
    const a = pose();
    expect(camsEqual(a, pose())).toBe(true);
  });

  it("tolerates sub-epsilon float noise", () => {
    expect(camsEqual(pose({ distance: 5 }), pose({ distance: 5 + 1e-9 }))).toBe(true);
  });

  it("is false for a distinguishable difference in any single field", () => {
    expect(camsEqual(pose(), pose({ distance: 6 }))).toBe(false);
    expect(camsEqual(pose(), pose({ target: [1, 0, 0] }))).toBe(false);
    expect(camsEqual(pose(), pose({ offset: [0, 0, 6] }))).toBe(false);
    expect(camsEqual(pose(), pose({ gazeUp: [1, 0, 0] }))).toBe(false);
  });

  it("scales its tolerance with coordinate magnitude", () => {
    // At large magnitude, a fixed absolute tolerance would fail; the relative tolerance should pass.
    const big = 1_000_000;
    expect(camsEqual(pose({ distance: big }), pose({ distance: big + 50 }))).toBe(true);
    // But a similarly-scaled relative difference should still fail.
    expect(camsEqual(pose({ distance: big }), pose({ distance: big * 1.01 }))).toBe(false);
  });
});
