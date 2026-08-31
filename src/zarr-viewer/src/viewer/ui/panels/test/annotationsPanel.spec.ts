import { describe, it, expect } from "vitest";
import { annotationsPanelBody, rgbToHex, hexToRgb } from "../annotationsPanel.js";
import type { MaskClassState } from "../../../state/mask-classes.js";

describe("annotationsPanelBody", () => {
  it("shows Load (not disabled) and no Remove button when nothing is loaded", () => {
    const html = annotationsPanelBody({
      maskUrl: "",
      maskLoading: false,
      maskError: undefined,
      maskLoaded: false,
      classes: [],
    });
    expect(html).toContain('data-act="loadMask"');
    expect(html).not.toContain('data-act="loadMask" class="whud__seg-btn" disabled');
    expect(html).not.toContain('data-act="removeMask"');
  });

  it("disables Load and shows a loading label while loading", () => {
    const html = annotationsPanelBody({
      maskUrl: "https://x/mask.zarr",
      maskLoading: true,
      maskError: undefined,
      maskLoaded: false,
      classes: [],
    });
    expect(html).toContain("Loading…");
    expect(html).toContain('data-act="loadMask" class="whud__seg-btn" disabled');
  });

  it("shows the error message without clearing the URL field", () => {
    const html = annotationsPanelBody({
      maskUrl: "https://x/mask.zarr",
      maskLoading: false,
      maskError: "404 not found",
      maskLoaded: false,
      classes: [],
    });
    expect(html).toContain("404 not found");
    expect(html).toContain("https://x/mask.zarr");
  });

  it("shows a Remove button and one row per class once loaded", () => {
    const classes: MaskClassState[] = [
      { id: 3, color: [1, 0, 0], opacity: 0.6, visible: true, voxelCount: 1234 },
      { id: 7, color: [0, 1, 0], opacity: 0.4, visible: false, voxelCount: 5 },
    ];
    const html = annotationsPanelBody({
      maskUrl: "https://x/mask.zarr",
      maskLoading: false,
      maskError: undefined,
      maskLoaded: true,
      classes,
    });
    expect(html).toContain('data-act="removeMask"');
    expect(html).toContain('data-mask-color="3"');
    expect(html).toContain('data-mask-color="7"');
    expect(html).toContain('data-mask-opacity="3"');
    // Visible class gets the active eye toggle; hidden one doesn't.
    const idx3 = html.indexOf('data-idx="3"');
    const idx7 = html.indexOf('data-idx="7"');
    expect(html.slice(idx3, idx3 + 80)).toContain("whud__seg-btn--active");
    expect(html.slice(idx7, idx7 + 80)).not.toContain("whud__seg-btn--active");
  });

  it("flags an all-background mask (no non-zero classes) once loaded", () => {
    const html = annotationsPanelBody({
      maskUrl: "https://x/mask.zarr",
      maskLoading: false,
      maskError: undefined,
      maskLoaded: true,
      classes: [],
    });
    expect(html).toContain("nothing to show");
  });
});

describe("rgbToHex / hexToRgb", () => {
  it("round-trips a color through hex", () => {
    const rgb: [number, number, number] = [1, 0, 0.5];
    const hex = rgbToHex(rgb);
    const back = hexToRgb(hex);
    expect(back[0]).toBeCloseTo(1, 1);
    expect(back[1]).toBeCloseTo(0, 1);
    expect(back[2]).toBeCloseTo(0.5, 1);
  });

  it("hexToRgb falls back to white for an invalid string", () => {
    expect(hexToRgb("not-a-color")).toEqual([1, 1, 1]);
  });
});
