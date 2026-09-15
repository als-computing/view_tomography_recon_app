import { describe, it, expect } from "vitest";
import { defaultRenderingState } from "../../../RenderingState.js";
import { postfxPanelBody } from "../postfxPanel.js";

describe("postfxPanelBody", () => {
  it("marks the current tonemap operator selected", () => {
    const rendering = defaultRenderingState();
    rendering.fxOperator = "reinhard";
    const html = postfxPanelBody(rendering);
    expect(html).toContain('value="reinhard" selected');
  });

  it("checks bloom/fxaa/sharpen/vignette independently", () => {
    const rendering = defaultRenderingState();
    rendering.fxBloom = true;
    rendering.fxFxaa = false;
    const html = postfxPanelBody(rendering);
    const bloomIdx = html.indexOf('data-chk="fxBloom"');
    expect(html.slice(bloomIdx, bloomIdx + 40)).toContain("checked");
    const fxaaIdx = html.indexOf('data-chk="fxFxaa"');
    expect(html.slice(fxaaIdx, fxaaIdx + 40)).not.toContain("checked");
  });
});
