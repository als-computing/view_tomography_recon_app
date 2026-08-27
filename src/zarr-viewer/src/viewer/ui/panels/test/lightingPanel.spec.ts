import { describe, it, expect } from "vitest";
import { defaultRenderingState } from "../../../RenderingState.js";
import { lightingPanelBody } from "../lightingPanel.js";

describe("lightingPanelBody", () => {
  it("hides the ROI progress bar when no stream is in flight", () => {
    const html = lightingPanelBody({
      rendering: defaultRenderingState(),
      roiEnabled: false,
      roiProgress: null,
    });
    const idx = html.indexOf('id="roiProgressWrap"');
    expect(html.slice(idx, idx + 60)).toContain("display:none");
  });

  it("shows the ROI progress bar with loaded/total counts while streaming", () => {
    const html = lightingPanelBody({
      rendering: defaultRenderingState(),
      roiEnabled: true,
      roiProgress: { loaded: 3, total: 10 },
    });
    expect(html).toContain("3/10 chunks");
    expect(html).toContain("width:30%");
  });

  it("checks the shadow/AO toggles independently of light-mode toggles", () => {
    const rendering = defaultRenderingState();
    rendering.shadowOn = true;
    rendering.aoOn = false;
    const html = lightingPanelBody({ rendering, roiEnabled: false, roiProgress: null });
    const shadowIdx = html.indexOf('data-chk="shadowOn"');
    expect(html.slice(shadowIdx, shadowIdx + 40)).toContain("checked");
    const aoIdx = html.indexOf('data-chk="aoOn"');
    expect(html.slice(aoIdx, aoIdx + 40)).not.toContain("checked");
  });
});
