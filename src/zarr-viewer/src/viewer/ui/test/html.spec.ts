/**
 * Tests for the pure HUD template-string builders.
 */
import { describe, it, expect } from "vitest";
import { section, segBtn, slider, fmt, colorRow, escAttr, rangeSlider } from "../html.js";

describe("section", () => {
  it("renders open when the id is in openSections, closed otherwise", () => {
    const open = new Set<"tf">(["tf"]);
    expect(section(open, "tf", "TF", "<p>body</p>")).toContain("open");
    const closed = new Set<"tf">();
    expect(section(closed, "tf", "TF", "<p>body</p>")).not.toContain(" open>");
  });

  it("includes the title, section id, and body", () => {
    const html = section(new Set(), "data", "Data", "<p>x</p>");
    expect(html).toContain('data-section="data"');
    expect(html).toContain("<summary>Data</summary>");
    expect(html).toContain("<p>x</p>");
  });
});

describe("segBtn", () => {
  it("marks the active button and omits disabled by default", () => {
    const active = segBtn("data-view", "volume", "Volume", true);
    expect(active).toContain("whud__seg-btn--active");
    expect(active).not.toContain("disabled");
    const inactive = segBtn("data-view", "volume", "Volume", false);
    expect(inactive).not.toContain("whud__seg-btn--active");
  });

  it("adds the disabled attribute when requested", () => {
    expect(segBtn("data-view", "volume", "Volume", false, true)).toContain(" disabled>");
  });
});

describe("slider", () => {
  it("includes the formatted value and min/max/step", () => {
    const html = slider("density", "Density", 1.45, 0, 3, 0.01);
    expect(html).toContain('data-slider="density"');
    expect(html).toContain('min="0"');
    expect(html).toContain('max="3"');
    expect(html).toContain(fmt(1.45));
  });
});

describe("fmt", () => {
  it("uses 2 decimals under magnitude 10, 1 decimal at/above", () => {
    expect(fmt(1.456)).toBe("1.46");
    expect(fmt(9.999)).toBe("10.00");
    expect(fmt(10)).toBe("10.0");
    expect(fmt(-12.34)).toBe("-12.3");
  });
});

describe("colorRow", () => {
  it("embeds the id and value on the color input", () => {
    const html = colorRow("lightGlobalColor", "Global", "#fff2e0");
    expect(html).toContain('data-color="lightGlobalColor"');
    expect(html).toContain('value="#fff2e0"');
  });
});

describe("escAttr", () => {
  it("escapes &, \", <, > for safe attribute/text interpolation", () => {
    expect(escAttr(`a & b "c" <d> e`)).toBe("a &amp; b &quot;c&quot; &lt;d&gt; e");
  });

  it("leaves plain text unchanged", () => {
    expect(escAttr("plain preset name")).toBe("plain preset name");
  });
});

describe("rangeSlider", () => {
  it("positions the fill track from lo/hi and includes formatted labels", () => {
    const html = rangeSlider("color", "Color", 0.15, 0.85);
    expect(html).toContain("left:15%");
    expect(html).toContain("width:70%");
    expect(html).toContain(`${fmt(0.15)} – ${fmt(0.85)}`);
  });

  it("scopes both thumbs to the same group", () => {
    const html = rangeSlider("cropX", "X", 0, 1);
    expect(html).toContain('data-range="cropX:lo"');
    expect(html).toContain('data-range="cropX:hi"');
  });
});
