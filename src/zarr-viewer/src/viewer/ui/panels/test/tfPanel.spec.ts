import { describe, it, expect } from "vitest";
import { defaultRenderingState } from "../../../RenderingState.js";
import { tfPanelBody } from "../tfPanel.js";

describe("tfPanelBody", () => {
  it("marks the current colormap selected", () => {
    const rendering = defaultRenderingState();
    rendering.colorMap = "viridis";
    const html = tfPanelBody(rendering);
    expect(html).toContain('value="viridis" selected');
  });

  it("checks the equalize checkbox when equalizeOn is true", () => {
    const rendering = defaultRenderingState();
    rendering.equalizeOn = true;
    const html = tfPanelBody(rendering);
    const idx = html.indexOf('data-chk="equalizeOn"');
    expect(html.slice(idx, idx + 40)).toContain("checked");
  });

  it("reflects colorLo/colorHi in the range slider", () => {
    const rendering = defaultRenderingState();
    rendering.colorLo = 0.2;
    rendering.colorHi = 0.7;
    const html = tfPanelBody(rendering);
    expect(html).toContain('value="0.2"');
    expect(html).toContain('value="0.7"');
  });
});
