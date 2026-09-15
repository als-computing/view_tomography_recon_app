import { describe, it, expect, vi } from "vitest";

(globalThis as unknown as { GPUTextureUsage?: Record<string, number> }).GPUTextureUsage ??= {
  TEXTURE_BINDING: 4,
  COPY_DST: 2,
};

vi.mock("@zarr-viewer/io", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zarr-viewer/io")>();
  return {
    ...actual,
    httpStore: vi.fn(actual.httpStore),
    openOmeZarr: vi.fn(actual.openOmeZarr),
  };
});

import { httpStore, openOmeZarr } from "@zarr-viewer/io";
import { loadMaskFromArray } from "../load-mask.js";
import type { GpuContext } from "@zarr-viewer/render";

function fakeCtx(): GpuContext {
  const device = {
    limits: { maxTextureDimension3D: 2048 },
    createTexture: () => ({ createView: () => ({}) }),
    queue: { writeTexture: vi.fn() },
  } as unknown as GpuContext["device"];
  return { device } as GpuContext;
}

describe("loadMaskFromArray", () => {
  it("uploads directly from the array without calling httpStore or openOmeZarr", async () => {
    const ctx = fakeCtx();
    const data = new Uint8Array([1, 1, 2, 0]);
    const result = await loadMaskFromArray(ctx, data, [2, 2, 1]);

    expect(httpStore).not.toHaveBeenCalled();
    expect(openOmeZarr).not.toHaveBeenCalled();
    expect(result.classCounts[1]).toBe(2);
    expect(result.classCounts[2]).toBe(1);
    expect(result.level).toBeUndefined();
  });
});
