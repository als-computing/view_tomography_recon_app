import { describe, it, expect } from "vitest";
import { presetsPanelBody, sanitizeSelectedPreset } from "../presetsPanel.js";

describe("sanitizeSelectedPreset", () => {
  it("clears a selection that no longer exists in the list", () => {
    expect(sanitizeSelectedPreset("gone", ["a", "b"])).toBe("a");
  });

  it("keeps a valid selection unchanged", () => {
    expect(sanitizeSelectedPreset("b", ["a", "b"])).toBe("b");
  });

  it("falls back to empty when the list is empty", () => {
    expect(sanitizeSelectedPreset("anything", [])).toBe("");
  });

  it("picks the first preset when nothing was selected but presets exist", () => {
    expect(sanitizeSelectedPreset("", ["first", "second"])).toBe("first");
  });
});

describe("presetsPanelBody", () => {
  it("shows a placeholder option when there are no presets", () => {
    const html = presetsPanelBody([], "");
    expect(html).toContain("(no presets saved)");
    expect(html).toContain('data-act="applyPreset" class="whud__seg-btn" disabled');
    expect(html).toContain('data-act="deletePreset" class="whud__seg-btn" disabled');
  });

  it("lists presets and marks the selected one, escaping HTML in names", () => {
    const html = presetsPanelBody(['<b>evil</b>', "safe"], "safe");
    expect(html).toContain("&lt;b&gt;evil&lt;/b&gt;");
    expect(html).toContain('value="safe" selected');
    expect(html).not.toContain('data-act="applyPreset" class="whud__seg-btn" disabled');
  });
});
