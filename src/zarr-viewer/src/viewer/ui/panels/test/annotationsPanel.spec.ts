import { describe, it, expect } from "vitest";
import { annotationsPanelBody, rgbToHex, hexToRgb, type AnnotationSlotView } from "../annotationsPanel.js";
import type { MaskClassState } from "../../../state/mask-classes.js";

const EMPTY_SLOT: AnnotationSlotView = {
  maskUrl: "",
  maskLoading: false,
  maskError: undefined,
  maskLoaded: false,
  classes: [],
};

describe("annotationsPanelBody", () => {
  it("shows Load (not disabled) and no Remove button for an empty slot", () => {
    const html = annotationsPanelBody([EMPTY_SLOT, EMPTY_SLOT]);
    expect(html).toContain('data-act="loadMask"');
    expect(html).not.toContain('data-act="loadMask" data-mask-slot="0" class="whud__seg-btn" disabled');
    expect(html).not.toContain('data-act="removeMask"');
  });

  it("disables Load and shows a loading label while that slot is loading", () => {
    const loading: AnnotationSlotView = { ...EMPTY_SLOT, maskUrl: "https://x/mask.zarr", maskLoading: true };
    const html = annotationsPanelBody([loading, EMPTY_SLOT]);
    expect(html).toContain("Loading…");
    expect(html).toContain('data-act="loadMask" data-mask-slot="0" class="whud__seg-btn" disabled');
  });

  it("shows the error message without clearing the URL field", () => {
    const errored: AnnotationSlotView = {
      ...EMPTY_SLOT,
      maskUrl: "https://x/mask.zarr",
      maskError: "404 not found",
    };
    const html = annotationsPanelBody([errored, EMPTY_SLOT]);
    expect(html).toContain("404 not found");
    expect(html).toContain("https://x/mask.zarr");
  });

  it("shows a Remove button and one row per class once loaded", () => {
    const classes: MaskClassState[] = [
      { id: 3, color: [1, 0, 0], opacity: 0.6, visible: true, voxelCount: 1234 },
      { id: 7, color: [0, 1, 0], opacity: 0.4, visible: false, voxelCount: 5 },
    ];
    const loaded: AnnotationSlotView = {
      maskUrl: "https://x/mask.zarr",
      maskLoading: false,
      maskError: undefined,
      maskLoaded: true,
      classes,
    };
    const html = annotationsPanelBody([loaded, EMPTY_SLOT]);
    expect(html).toContain('data-act="removeMask"');
    expect(html).toContain('data-mask-color="3"');
    expect(html).toContain('data-mask-color="7"');
    expect(html).toContain('data-mask-opacity="3"');
    // Visible class gets the active eye toggle; hidden one doesn't.
    const idx3 = html.indexOf('data-idx="3"');
    const idx7 = html.indexOf('data-idx="7"');
    expect(html.slice(idx3, idx3 + 100)).toContain("whud__seg-btn--active");
    expect(html.slice(idx7, idx7 + 100)).not.toContain("whud__seg-btn--active");
  });

  it("flags an all-background mask (no non-zero classes) once loaded", () => {
    const loaded: AnnotationSlotView = { ...EMPTY_SLOT, maskUrl: "https://x/mask.zarr", maskLoaded: true };
    const html = annotationsPanelBody([loaded, EMPTY_SLOT]);
    expect(html).toContain("nothing to show");
  });

  it("renders two fully independent sections - each slot's state doesn't bleed into the other", () => {
    const classesA: MaskClassState[] = [{ id: 1, color: [1, 0, 0], opacity: 0.5, visible: true, voxelCount: 10 }];
    const classesB: MaskClassState[] = [{ id: 9, color: [0, 0, 1], opacity: 0.9, visible: false, voxelCount: 20 }];
    const slot0: AnnotationSlotView = {
      maskUrl: "https://x/a.zarr",
      maskLoading: true,
      maskError: undefined,
      maskLoaded: true,
      classes: classesA,
    };
    const slot1: AnnotationSlotView = {
      maskUrl: "https://x/b.zarr",
      maskLoading: false,
      maskError: "b failed",
      maskLoaded: false,
      classes: classesB,
    };
    const html = annotationsPanelBody([slot0, slot1]);

    expect(html).toContain("https://x/a.zarr");
    expect(html).toContain("https://x/b.zarr");
    expect(html).toContain("b failed");
    expect(html).toContain('data-mask-color="1" data-mask-slot="0"');
    expect(html).toContain('data-mask-color="9" data-mask-slot="1"');
    // Slot 0 is loading -> its Load button is disabled; slot 1 is not loading -> its isn't.
    expect(html).toContain('data-act="loadMask" data-mask-slot="0" class="whud__seg-btn" disabled');
    expect(html).toContain('data-act="loadMask" data-mask-slot="1" class="whud__seg-btn">Load</button>');
    // Slot 0 is "loaded" (with a class present) -> has a Remove button + no "nothing to show".
    expect(html).toContain('data-act="removeMask" data-mask-slot="0"');
    expect(html).not.toContain('data-act="removeMask" data-mask-slot="1"');
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
