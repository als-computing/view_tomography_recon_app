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

  it("shows the Single mode as active and no band rows when tfBands is unset", () => {
    const rendering = defaultRenderingState();
    const html = tfPanelBody(rendering);
    expect(html).toContain('data-tfmode="single" class="whud__seg-btn whud__seg-btn--active"');
    expect(html).not.toContain("data-band-cmap");
  });

  it("renders one row per band, marks Bands mode active, and hides the flat-TF controls", () => {
    const rendering = defaultRenderingState();
    rendering.tfBands = [
      { loT: 0, hiT: 0.5, colorMap: "bone", opacityPoints: [[0, 1], [1, 1]], opacityScale: 1 },
      { loT: 0.5, hiT: 1, colorMap: "viridis", opacityPoints: [[0, 1], [1, 1]], opacityScale: 1 },
    ];
    const html = tfPanelBody(rendering, 1);
    expect(html).toContain('data-tfmode="bands" class="whud__seg-btn whud__seg-btn--active"');
    expect(html).toContain('data-band-cmap="0"');
    expect(html).toContain('data-band-cmap="1"');
    expect(html).not.toContain('id="cmap"'); // single-mode colormap select is gone in Bands mode
  });

  it("shows a dual-thumb range slider for the active band's [loT, hiT]", () => {
    const rendering = defaultRenderingState();
    rendering.tfBands = [
      { loT: 0.1, hiT: 0.4, colorMap: "bone", opacityPoints: [[0, 1], [1, 1]], opacityScale: 1 },
      { loT: 0.4, hiT: 0.9, colorMap: "viridis", opacityPoints: [[0, 1], [1, 1]], opacityScale: 1 },
    ];
    const html = tfPanelBody(rendering, 1);
    expect(html).toContain('data-range-group="tfBandRange"');
    expect(html).toContain('data-range="tfBandRange:lo"');
    expect(html).toContain('value="0.4"'); // the active (index 1) band's loT
    expect(html).toContain('value="0.9"'); // the active band's hiT
    expect(html).toContain('data-band-range-label="1"');
  });

  it("renders an active eye toggle for an enabled band and an inactive one for a disabled band", () => {
    const rendering = defaultRenderingState();
    rendering.tfBands = [
      { loT: 0, hiT: 0.5, colorMap: "bone", opacityPoints: [[0, 1], [1, 1]], opacityScale: 1 },
      { loT: 0.5, hiT: 1, colorMap: "viridis", opacityPoints: [[0, 1], [1, 1]], opacityScale: 1, enabled: false },
    ];
    const html = tfPanelBody(rendering, 0);
    expect(html).toContain('data-act="toggleTfBand" data-idx="0" class="whud__seg-btn whud__seg-btn--active"');
    const toggle1Idx = html.indexOf('data-act="toggleTfBand" data-idx="1"');
    expect(toggle1Idx).toBeGreaterThan(-1);
    expect(html.slice(toggle1Idx, toggle1Idx + 60)).not.toContain("whud__seg-btn--active");
  });

  it("caps the Add band button once MAX_TF_BANDS is reached", () => {
    const rendering = defaultRenderingState();
    rendering.tfBands = Array.from({ length: 6 }, (_, i) => ({
      loT: i / 6,
      hiT: (i + 1) / 6,
      colorMap: "grayscale" as const,
      opacityPoints: [[0, 1], [1, 1]] as const,
      opacityScale: 1,
    }));
    const html = tfPanelBody(rendering, 0);
    expect(html).not.toContain("addTfBand");
    expect(html).toContain("Max 6 bands");
  });
});
