import { describe, it, expect } from "vitest";
import { DefaultBrickPriorityPolicy, type RankedBin } from "../brick-priority-policy.js";

function bin(x: number, y: number, z: number, priority: number): RankedBin {
  return { x, y, z, priority };
}

describe("DefaultBrickPriorityPolicy.selectSecondary", () => {
  it("picks the next-highest-priority bins after the primary, in rank order", () => {
    const policy = new DefaultBrickPriorityPolicy();
    const ranked = [bin(0, 0, 0, 10), bin(1, 0, 0, 8), bin(2, 0, 0, 5), bin(3, 0, 0, 1)];
    const out = policy.selectSecondary(ranked, { maxCount: 3, primary: { x: 0, y: 0, z: 0 } });
    expect(out).toEqual([bin(1, 0, 0, 8), bin(2, 0, 0, 5), bin(3, 0, 0, 1)]);
  });

  it("caps the result at maxCount even when more positive-priority bins exist", () => {
    const policy = new DefaultBrickPriorityPolicy();
    const ranked = [bin(0, 0, 0, 10), bin(1, 0, 0, 8), bin(2, 0, 0, 5), bin(3, 0, 0, 1)];
    const out = policy.selectSecondary(ranked, { maxCount: 1, primary: { x: 0, y: 0, z: 0 } });
    expect(out).toEqual([bin(1, 0, 0, 8)]);
  });

  it("skips non-positive-priority bins", () => {
    const policy = new DefaultBrickPriorityPolicy();
    const ranked = [bin(0, 0, 0, 10), bin(1, 0, 0, 0), bin(2, 0, 0, -1), bin(3, 0, 0, 3)];
    const out = policy.selectSecondary(ranked, { maxCount: 3, primary: { x: 0, y: 0, z: 0 } });
    expect(out).toEqual([bin(3, 0, 0, 3)]);
  });

  it("with no primary given, still excludes nothing extra — every positive bin up to maxCount qualifies", () => {
    const policy = new DefaultBrickPriorityPolicy();
    const ranked = [bin(0, 0, 0, 10), bin(1, 0, 0, 8)];
    const out = policy.selectSecondary(ranked, { maxCount: 3 });
    expect(out).toEqual(ranked);
  });

  it("degenerate maxCount=0 (N=1-equivalent case) selects nothing, matching pre-9b single-region behavior", () => {
    const policy = new DefaultBrickPriorityPolicy();
    const ranked = [bin(0, 0, 0, 10), bin(1, 0, 0, 8)];
    const out = policy.selectSecondary(ranked, { maxCount: 0, primary: { x: 0, y: 0, z: 0 } });
    expect(out).toEqual([]);
  });

  it("returns nothing for an empty ranked list", () => {
    const policy = new DefaultBrickPriorityPolicy();
    expect(policy.selectSecondary([], { maxCount: 3 })).toEqual([]);
  });
});
