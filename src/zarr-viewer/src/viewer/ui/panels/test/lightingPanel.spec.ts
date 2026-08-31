import { describe, it, expect } from "vitest";
import { defaultRenderingState } from "../../../RenderingState.js";
import { lightingPanelBody } from "../lightingPanel.js";

describe("lightingPanelBody", () => {
  it("checks the shadow/AO toggles independently of light-mode toggles", () => {
    const rendering = defaultRenderingState();
    rendering.shadowOn = true;
    rendering.aoOn = false;
    const html = lightingPanelBody({ rendering });
    const shadowIdx = html.indexOf('data-chk="shadowOn"');
    expect(html.slice(shadowIdx, shadowIdx + 40)).toContain("checked");
    const aoIdx = html.indexOf('data-chk="aoOn"');
    expect(html.slice(aoIdx, aoIdx + 40)).not.toContain("checked");
  });
});
