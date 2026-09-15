import { describe, it, expect } from "vitest";
import { discoverMaskClasses, defaultClassColor, buildMaskPalette, type MaskClassState } from "../mask-classes.js";
import { MASK_CLASS_COUNT } from "@zarr-viewer/render";

describe("discoverMaskClasses", () => {
  it("excludes class 0 (background convention) even when present", () => {
    const counts = new Uint32Array(256);
    counts[0] = 1_000_000;
    counts[3] = 500;
    const classes = discoverMaskClasses(counts);
    expect(classes.map((c) => c.id)).toEqual([3]);
  });

  it("only lists classes with a nonzero voxel count", () => {
    const counts = new Uint32Array(256);
    counts[5] = 10;
    counts[10] = 0;
    counts[200] = 1;
    const classes = discoverMaskClasses(counts);
    expect(classes.map((c) => c.id).sort((a, b) => a - b)).toEqual([5, 200]);
  });

  it("defaults every discovered class to visible with a distinct color", () => {
    const counts = new Uint32Array(256);
    counts[1] = 10;
    counts[2] = 10;
    const [a, b] = discoverMaskClasses(counts);
    expect(a!.visible).toBe(true);
    expect(b!.visible).toBe(true);
    expect(a!.color).not.toEqual(b!.color);
  });
});

describe("defaultClassColor", () => {
  it("returns black for id 0 or negative ids", () => {
    expect(defaultClassColor(0)).toEqual([0, 0, 0]);
    expect(defaultClassColor(-1)).toEqual([0, 0, 0]);
  });

  it("is deterministic (same id -> same color every call)", () => {
    expect(defaultClassColor(42)).toEqual(defaultClassColor(42));
  });

  it("produces valid [0,1] RGB components", () => {
    for (const id of [1, 2, 50, 255]) {
      const [r, g, b] = defaultClassColor(id);
      for (const v of [r, g, b]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("buildMaskPalette", () => {
  it("writes color+opacity at the class's own index and leaves everything else transparent", () => {
    const classes: MaskClassState[] = [{ id: 5, color: [1, 0, 0], opacity: 0.5, visible: true, voxelCount: 10 }];
    const palette = buildMaskPalette(classes);
    expect(palette.length).toBe(MASK_CLASS_COUNT * 4);
    const o = 5 * 4;
    expect([palette[o], palette[o + 1], palette[o + 2], palette[o + 3]]).toEqual([255, 0, 0, 128]);
    // Every other entry stays fully transparent.
    expect(palette[4 * 4 + 3]).toBe(0);
    expect(palette[6 * 4 + 3]).toBe(0);
  });

  it("zeroes alpha for a disabled (visible: false) class, regardless of its stored opacity", () => {
    const classes: MaskClassState[] = [{ id: 9, color: [0, 1, 0], opacity: 0.9, visible: false, voxelCount: 1 }];
    const palette = buildMaskPalette(classes);
    expect(palette[9 * 4 + 3]).toBe(0);
  });

  it("ignores out-of-range ids without throwing", () => {
    const classes: MaskClassState[] = [{ id: 999, color: [1, 1, 1], opacity: 1, visible: true, voxelCount: 1 }];
    expect(() => buildMaskPalette(classes)).not.toThrow();
  });
});
