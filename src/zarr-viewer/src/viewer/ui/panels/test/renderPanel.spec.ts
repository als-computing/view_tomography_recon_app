import { describe, it, expect } from "vitest";
import { defaultRenderingState } from "../../../RenderingState.js";
import { renderPanelBody } from "../renderPanel.js";

describe("renderPanelBody", () => {
  it("marks the active blend mode and shader config", () => {
    const rendering = defaultRenderingState();
    rendering.blendMode = "mip";
    rendering.shaderConfig = "quality";
    const html = renderPanelBody(rendering);
    const blendIdx = html.indexOf('data-blend="mip"');
    expect(html.slice(blendIdx, blendIdx + 80)).toContain("whud__seg-btn--active");
    const shaderIdx = html.indexOf('data-shader="quality"');
    expect(html.slice(shaderIdx, shaderIdx + 80)).toContain("whud__seg-btn--active");
  });

  it("includes all four blend-mode buttons", () => {
    const html = renderPanelBody(defaultRenderingState());
    for (const b of ["composite", "mip", "minip", "average"]) {
      expect(html).toContain(`data-blend="${b}"`);
    }
  });

  it("reflects sampling/shading slider values", () => {
    const rendering = defaultRenderingState();
    rendering.densityScale = 2.5;
    const html = renderPanelBody(rendering);
    expect(html).toContain('data-slider="density"');
    expect(html).toContain('value="2.5"');
  });
});
