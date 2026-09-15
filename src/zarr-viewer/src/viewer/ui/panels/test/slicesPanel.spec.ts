import { describe, it, expect } from "vitest";
import { defaultRenderingState, defaultCroppingState } from "../../../RenderingState.js";
import { slicesPanelBody } from "../slicesPanel.js";

describe("slicesPanelBody", () => {
  it("prompts to pick an axis view when no slice is active", () => {
    const html = slicesPanelBody({
      rendering: defaultRenderingState(),
      cropping: defaultCroppingState(),
      active: null,
      sliceWorldLabel: "",
      axisVoxelCount: 0,
    });
    expect(html).toContain("Pick an axis view");
  });

  it("shows the axis label, world position, and voxel index when a slice is active", () => {
    const rendering = defaultRenderingState();
    rendering.viewMode = "xPlane";
    const html = slicesPanelBody({
      rendering,
      cropping: defaultCroppingState(),
      active: { axis: "x", value: 0.5 },
      sliceWorldLabel: "12.3 µm",
      axisVoxelCount: 100,
    });
    expect(html).toContain("Slice along X");
    expect(html).toContain("12.3 µm");
    expect(html).toContain("index 50/99");
  });

  it("marks the active view mode button", () => {
    const rendering = defaultRenderingState();
    rendering.viewMode = "zPlane";
    const html = slicesPanelBody({
      rendering,
      cropping: defaultCroppingState(),
      active: { axis: "z", value: 0.5 },
      sliceWorldLabel: "0 µm",
      axisVoxelCount: 10,
    });
    const idx = html.indexOf('data-view="zPlane"');
    expect(html.slice(idx, idx + 80)).toContain("whud__seg-btn--active");
  });

  it("reflects per-axis overlay checkbox state", () => {
    const cropping = defaultCroppingState();
    cropping.enX = true;
    cropping.showPlanes = true;
    const html = slicesPanelBody({
      rendering: defaultRenderingState(),
      cropping,
      active: null,
      sliceWorldLabel: "",
      axisVoxelCount: 0,
    });
    const enXIdx = html.indexOf('data-chk="enX"');
    expect(html.slice(enXIdx, enXIdx + 40)).toContain("checked");
    const enYIdx = html.indexOf('data-chk="enY"');
    expect(html.slice(enYIdx, enYIdx + 40)).not.toContain("checked");
  });
});
