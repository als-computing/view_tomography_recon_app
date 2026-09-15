import { describe, it, expect, vi } from "vitest";
import { BrickAtlas } from "../brick-atlas.js";

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

describe("BrickAtlas", () => {
  it("reports capacity as the product of slot counts", () => {
    const { device } = fakeDevice();
    const atlas = new BrickAtlas(device, 2, 3, 4, 32, "r8uint");
    expect(atlas.capacity).toBe(2 * 3 * 4);
  });

  it("computes slotVoxelOrigin as row-major x-fastest, then y, then z", () => {
    const { device } = fakeDevice();
    const atlas = new BrickAtlas(device, 2, 2, 2, 16, "r8uint");
    expect(atlas.slotVoxelOrigin(0)).toEqual([0, 0, 0]);
    expect(atlas.slotVoxelOrigin(1)).toEqual([16, 0, 0]);
    expect(atlas.slotVoxelOrigin(2)).toEqual([0, 16, 0]);
    expect(atlas.slotVoxelOrigin(3)).toEqual([16, 16, 0]);
    expect(atlas.slotVoxelOrigin(4)).toEqual([0, 0, 16]);
    expect(atlas.slotVoxelOrigin(7)).toEqual([16, 16, 16]);
  });

  it("computes slotVoxelOrigin correctly for non-uniform slot grids", () => {
    const { device } = fakeDevice();
    const atlas = new BrickAtlas(device, 3, 2, 1, 8, "r8uint");
    expect(atlas.slotVoxelOrigin(0)).toEqual([0, 0, 0]);
    expect(atlas.slotVoxelOrigin(2)).toEqual([16, 0, 0]);
    expect(atlas.slotVoxelOrigin(3)).toEqual([0, 8, 0]);
    expect(atlas.slotVoxelOrigin(5)).toEqual([16, 8, 0]);
  });

  it("uploadToSlot writes to the slot's computed origin and extent with correct bytesPerRow", () => {
    const { device, writeTexture } = fakeDevice();
    const atlas = new BrickAtlas(device, 2, 2, 2, 16, "r8uint"); // 1 byte/texel
    const data = new Uint8Array(16 * 16 * 16);
    atlas.uploadToSlot(device, 3, data); // slot 3 -> origin [16,16,0]

    expect(writeTexture).toHaveBeenCalledWith(
      { texture: expect.anything(), origin: { x: 16, y: 16, z: 0 } },
      data,
      { bytesPerRow: 16, rowsPerImage: 16 },
      { width: 16, height: 16, depthOrArrayLayers: 16 },
    );
  });

  it("uploadToSlot scales bytesPerRow by the format's texel size", () => {
    const { device, writeTexture } = fakeDevice();
    const atlas = new BrickAtlas(device, 1, 1, 1, 8, "rgba16float"); // 8 bytes/texel
    const data = new Uint8Array(8 * 8 * 8 * 8);
    atlas.uploadToSlot(device, 0, data);

    expect(writeTexture).toHaveBeenCalledWith(
      expect.anything(),
      data,
      { bytesPerRow: 64, rowsPerImage: 8 },
      expect.anything(),
    );
  });
});
