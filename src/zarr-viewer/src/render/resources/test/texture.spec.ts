import { describe, it, expect } from "vitest";
import { bytesPerTexel, ManagedTexture } from "../texture.js";

(globalThis as unknown as { GPUTextureUsage?: Record<string, number> }).GPUTextureUsage ??= {
  TEXTURE_BINDING: 4,
  RENDER_ATTACHMENT: 16,
  COPY_DST: 2,
};

function fakeDevice() {
  return {
    createTexture: () => ({ destroy: () => {} }),
  } as unknown as GPUDevice;
}

describe("bytesPerTexel", () => {
  it("returns the correct byte count for every format this codebase actually uses", () => {
    expect(bytesPerTexel("r8unorm")).toBe(1);
    expect(bytesPerTexel("r8uint")).toBe(1);
    expect(bytesPerTexel("r16float")).toBe(2);
    expect(bytesPerTexel("r32float")).toBe(4);
    expect(bytesPerTexel("rgba8unorm")).toBe(4);
    expect(bytesPerTexel("rg32float")).toBe(8);
    expect(bytesPerTexel("rgba16float")).toBe(8);
    expect(bytesPerTexel("rgba32float")).toBe(16);
  });

  it("falls back to a reasonable estimate for an unrecognized format instead of throwing", () => {
    expect(bytesPerTexel("bgra8unorm" as GPUTextureFormat)).toBe(4);
  });
});

describe("ManagedTexture.sizeBytes", () => {
  it("computes width*height*depth*bytesPerTexel for a single-mip-level texture", () => {
    const tex = new ManagedTexture(fakeDevice(), {
      size: [64, 32, 1],
      format: "rgba16float",
      usage: 0,
    });
    expect(tex.sizeBytes).toBe(64 * 32 * 1 * 8);
  });

  it("sums the full mip chain when mipLevelCount > 1", () => {
    const tex = new ManagedTexture(fakeDevice(), {
      size: [8, 8, 8],
      format: "r32float",
      dimension: "3d",
      usage: 0,
      mipLevelCount: 4, // 8³ + 4³ + 2³ + 1³
    });
    const expected = (8 * 8 * 8 + 4 * 4 * 4 + 2 * 2 * 2 + 1 * 1 * 1) * 4;
    expect(tex.sizeBytes).toBe(expected);
  });

  it("multiplies by sampleCount for a multisampled target", () => {
    const tex = new ManagedTexture(fakeDevice(), {
      size: [16, 16, 1],
      format: "rgba8unorm",
      usage: 0,
      sampleCount: 4,
    });
    expect(tex.sizeBytes).toBe(16 * 16 * 4 * 4);
  });
});
