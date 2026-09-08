import { describe, it, expect, vi } from "vitest";
import type { VolumeChunk, VolumeSource } from "@zarr-viewer/io";
import { BrickAtlas } from "../../accel/brick-atlas.js";
import { chooseAtlasBrickRegion, uploadRegionToAtlasSlot } from "../upload-to-atlas.js";

(globalThis as unknown as { GPUTextureUsage?: Record<string, number> }).GPUTextureUsage ??= {
  TEXTURE_BINDING: 4,
  COPY_DST: 2,
};

function fakeDevice() {
  const writeTexture = vi.fn();
  const device = {
    createTexture: () => ({ destroy: () => {} }),
    queue: { writeTexture },
  } as unknown as GPUDevice;
  return { device, writeTexture };
}

/** A 2-level fake pyramid: level 0 is 1024^3, level 1 is 512^3 — big enough that only level 1 (or
 * coarser) fits a small atlas slot. */
function fakeSource(opts: { chunks?: VolumeChunk[] } = {}): VolumeSource {
  return {
    dimensions: [1024, 1024, 1024],
    spacing: [1e-6, 1e-6, 1e-6],
    dtype: "uint16",
    valueRange: [0, 1000],
    levelCount: 2,
    dimensionsAt: (level) => (level === 0 ? [1024, 1024, 1024] : [512, 512, 512]),
    spacingAt: () => [1e-6, 1e-6, 1e-6],
    readChunk: () => {
      throw new Error("not used in this test");
    },
    chunks: async function* () {},
    readRegion: async function* () {
      for (const c of opts.chunks ?? []) yield c;
    },
    regionChunkCount: () => opts.chunks?.length ?? 0,
  };
}

describe("chooseAtlasBrickRegion", () => {
  it("picks the finest level whose box fits within slotSize, sized exactly to slotSize per axis", () => {
    const source = fakeSource();
    const region = chooseAtlasBrickRegion(source, [0.4, 0.4, 0.4], [0.6, 0.6, 0.6], 256);
    expect(region).not.toBeNull();
    // Level 0's [0.4,0.6] box is 205 voxels/axis (< 256, fits) — finer than level 1, so level 0 wins.
    expect(region!.level).toBe(0);
    for (let a = 0; a < 3; a++) {
      expect(region!.voxelMax[a] - region!.voxelMin[a]).toBe(256);
    }
  });

  it("clamps the placed region into the volume when centered near an edge", () => {
    const source = fakeSource();
    const region = chooseAtlasBrickRegion(source, [0.0, 0.0, 0.0], [0.05, 0.05, 0.05], 256);
    expect(region).not.toBeNull();
    expect(region!.voxelMin).toEqual([0, 0, 0]);
    expect(region!.voxelMax).toEqual([256, 256, 256]);
  });

  it("returns null when even the coarsest level doesn't fit within slotSize", () => {
    const source = fakeSource();
    // Whole-volume box at both levels exceeds a 16-voxel slot.
    const region = chooseAtlasBrickRegion(source, [0, 0, 0], [1, 1, 1], 16);
    expect(region).toBeNull();
  });

  it("snaps the region center to the grid so sub-voxel drift doesn't change the result", () => {
    const source = fakeSource();
    const a = chooseAtlasBrickRegion(source, [0.4, 0.4, 0.4], [0.6, 0.6, 0.6], 256, { gridSnap: 32 });
    const b = chooseAtlasBrickRegion(source, [0.4001, 0.4001, 0.4001], [0.6001, 0.6001, 0.6001], 256, {
      gridSnap: 32,
    });
    expect(a).toEqual(b);
  });
});

describe("uploadRegionToAtlasSlot", () => {
  it("packs fetched chunks and writes exactly one slotSize^3 buffer to the atlas at the slot's origin", async () => {
    const { device, writeTexture } = fakeDevice();
    const atlas = new BrickAtlas(device, 2, 1, 1, 4, "r16float"); // 2 slots, 4^3 voxels each
    const chunk: VolumeChunk = {
      origin: [0, 0, 0],
      shape: [4, 4, 4],
      data: new Uint16Array(4 * 4 * 4).fill(500), // mid-range of [0,1000] -> normalized 0.5
    };
    const source = fakeSource({ chunks: [chunk] });
    await uploadRegionToAtlasSlot(device, atlas, 1, source, 0, [0, 0, 0], [4, 4, 4]);

    expect(writeTexture).toHaveBeenCalledTimes(1);
    const [dest, data, layout, extent] = writeTexture.mock.calls[0]!;
    expect(dest.origin).toEqual({ x: 4, y: 0, z: 0 }); // slot 1's origin
    expect(extent).toEqual({ width: 4, height: 4, depthOrArrayLayers: 4 });
    expect(layout).toEqual({ bytesPerRow: 4 * 2, rowsPerImage: 4 });
    expect((data as Uint8Array).length).toBe(4 * 2 * 4 * 4); // slotSize^3, r16float = 2 bytes/texel
  });

  it("throws if the requested region exceeds the atlas's slot size", async () => {
    const { device } = fakeDevice();
    const atlas = new BrickAtlas(device, 1, 1, 1, 4, "r16float");
    const source = fakeSource();
    await expect(
      uploadRegionToAtlasSlot(device, atlas, 0, source, 0, [0, 0, 0], [8, 4, 4]),
    ).rejects.toThrow(/exceeds slot size/);
  });
});
