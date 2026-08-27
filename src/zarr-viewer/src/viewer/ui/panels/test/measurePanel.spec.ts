import { describe, it, expect } from "vitest";
import { units } from "@zarr-viewer/core";
import { defaultRenderingState } from "../../../RenderingState.js";
import { measurePanelBody } from "../measurePanel.js";

describe("measurePanelBody", () => {
  it("omits pick details when nothing has been picked", () => {
    const html = measurePanelBody({
      rendering: defaultRenderingState(),
      pickMode: false,
      pickStatus: "",
      lastPick: undefined,
      u3: units.micrometer.pow(3),
    });
    expect(html).not.toContain("Seed voxel");
  });

  it("shows pick status text when set", () => {
    const html = measurePanelBody({
      rendering: defaultRenderingState(),
      pickMode: false,
      pickStatus: "No feature under cursor",
      lastPick: undefined,
      u3: units.micrometer.pow(3),
    });
    expect(html).toContain("No feature under cursor");
  });

  it("checks the pick-mode checkbox when active", () => {
    const html = measurePanelBody({
      rendering: defaultRenderingState(),
      pickMode: true,
      pickStatus: "",
      lastPick: undefined,
      u3: units.micrometer.pow(3),
    });
    const idx = html.indexOf('data-chk="pickMode"');
    expect(html.slice(idx, idx + 40)).toContain("checked");
  });
});
