import { describe, it, expect } from "vitest";
import { defaultCroppingState } from "../../../RenderingState.js";
import { cropPanelBody } from "../cropPanel.js";

describe("cropPanelBody", () => {
  it("reflects each axis's crop min/max", () => {
    const cropping = defaultCroppingState();
    cropping.cropMin = [0.1, 0.2, 0.3];
    cropping.cropMax = [0.9, 0.8, 0.7];
    const html = cropPanelBody(cropping, false);
    expect(html).toContain('data-range="cropX:lo"');
    expect(html).toContain('data-range="cropX:hi"');
    expect(html).toContain("left:10%"); // cropMin[0] * 100
  });

  it("includes a reset-crop button", () => {
    const html = cropPanelBody(defaultCroppingState(), false);
    expect(html).toContain('data-act="resetCrop"');
  });

  it("checks the crop-drag-mode toggle when active", () => {
    const html = cropPanelBody(defaultCroppingState(), true);
    const idx = html.indexOf('data-chk="cropDragMode"');
    expect(html.slice(idx, idx + 40)).toContain("checked");
  });
});
