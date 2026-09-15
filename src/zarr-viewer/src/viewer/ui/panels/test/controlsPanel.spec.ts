import { describe, it, expect } from "vitest";
import { defaultRenderingState } from "../../../RenderingState.js";
import { controlsPanelBody } from "../controlsPanel.js";

describe("controlsPanelBody", () => {
  it("checks the invert-X toggle independently of invert-Y", () => {
    const rendering = defaultRenderingState();
    rendering.invertOrbitX = true;
    rendering.invertOrbitY = false;
    const html = controlsPanelBody(rendering);
    const xIdx = html.indexOf('data-chk="invertOrbitX"');
    expect(html.slice(xIdx, xIdx + 40)).toContain("checked");
    const yIdx = html.indexOf('data-chk="invertOrbitY"');
    expect(html.slice(yIdx, yIdx + 40)).not.toContain("checked");
  });
});
