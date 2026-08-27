import { describe, it, expect } from "vitest";
import { units } from "@zarr-viewer/core";
import type { VolumeSource } from "@zarr-viewer/io";
import { dataPanelBody } from "../dataPanel.js";

function fakeSource(overrides: Partial<VolumeSource> = {}): VolumeSource {
  return {
    dimensions: [512, 512, 512],
    spacing: [1, 1, 1],
    dtype: "uint16",
    valueRange: [0, 1000],
    levelCount: 3,
    dimensionsAt: (lv: number) => [512 >> lv, 512 >> lv, 512 >> lv] as [number, number, number],
    spacingAt: () => [1, 1, 1] as [number, number, number],
    readChunk: async () => {
      throw new Error("not used");
    },
    chunks: async function* () {},
    readRegion: async function* () {},
    regionChunkCount: () => 0,
    ...overrides,
  } as VolumeSource;
}

describe("dataPanelBody", () => {
  it("renders one LOD button per level, marking the current level active", () => {
    const html = dataPanelBody({
      source: fakeSource(),
      levels: [0, 1, 2],
      level: 1,
      loading: false,
      maxTex: 2048,
      unit: units.micrometer,
    });
    expect(html).toContain('data-level="0"');
    expect(html).toContain('data-level="1"');
    expect(html).toContain('data-level="2"');
    // The active level's button carries the active class; verify by locating its segment.
    const activeIdx = html.indexOf('data-level="1"');
    const segment = html.slice(activeIdx, activeIdx + 120);
    expect(segment).toContain("whud__seg-btn--active");
  });

  it("disables LOD buttons while loading", () => {
    const html = dataPanelBody({
      source: fakeSource(),
      levels: [0, 1],
      level: 0,
      loading: true,
      maxTex: 2048,
      unit: units.micrometer,
    });
    expect(html).toContain("disabled");
  });

  it("lists levels blocked by the GPU's max texture size, excluding levels already offered", () => {
    const html = dataPanelBody({
      source: fakeSource({ levelCount: 3 }),
      levels: [1, 2], // level 0 (512^3) exceeds maxTex, so it's excluded from `levels`
      level: 1,
      loading: false,
      maxTex: 256,
      unit: units.micrometer,
    });
    expect(html).toContain("L0 needs 512");
    expect(html).toContain("GPU max 256");
  });

  it("omits the blocked-levels hint when every level fits", () => {
    const html = dataPanelBody({
      source: fakeSource({ levelCount: 2 }),
      levels: [0, 1],
      level: 0,
      loading: false,
      maxTex: 4096,
      unit: units.micrometer,
    });
    expect(html).not.toContain("needs");
  });
});
