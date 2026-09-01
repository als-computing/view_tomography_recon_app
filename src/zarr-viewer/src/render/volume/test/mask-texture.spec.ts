import { describe, it, expect, vi } from "vitest";
import { asClassIdSamples, uploadMaskArray, MASK_CLASS_COUNT } from "../mask-texture.js";

// GPUTextureUsage is a browser/WebGPU global (bit-flag constants) not present under Node/vitest -
// stub it so ManagedTexture's constructor (called by uploadMaskArray) can read it.
(globalThis as unknown as { GPUTextureUsage?: Record<string, number> }).GPUTextureUsage ??= {
  TEXTURE_BINDING: 4,
  COPY_DST: 2,
};

/** A minimal fake GPUDevice covering only what ManagedTexture/writeTexture actually touch, so
 * uploadMaskArray's pure tally/repack logic is unit-testable without a real WebGPU device. */
function fakeDevice(writeTexture = vi.fn()): GPUDevice {
  return {
    limits: { maxTextureDimension3D: 2048 },
    createTexture: () => ({ createView: () => ({}) }),
    queue: { writeTexture },
  } as unknown as GPUDevice;
}

describe("asClassIdSamples", () => {
  it("passes uint8 data through unchanged (the expected mask dtype)", () => {
    const data = new Uint8Array([0, 1, 254, 255]);
    expect(asClassIdSamples(data, "uint8")).toEqual(data);
  });

  it("rounds and clamps float32 data into [0,255]", () => {
    const data = new Float32Array([-5, 0.4, 3.6, 999]);
    expect(Array.from(asClassIdSamples(data, "float32"))).toEqual([0, 0, 4, 255]);
  });

  it("clamps negative int16 values to 0", () => {
    const data = new Int16Array([-100, 0, 200]);
    expect(Array.from(asClassIdSamples(data, "int16"))).toEqual([0, 0, 200]);
  });

  it("clamps large uint16 values to 255", () => {
    const data = new Uint16Array([0, 500, 65535]);
    expect(Array.from(asClassIdSamples(data, "uint16"))).toEqual([0, 255, 255]);
  });
});

describe("uploadMaskArray", () => {
  it("tallies the exact class-count histogram from the supplied array", () => {
    // 2x2x1: classes [3, 3, 7, 0].
    const data = new Uint8Array([3, 3, 7, 0]);
    const { classCounts } = uploadMaskArray(fakeDevice(), data, [2, 2, 1]);
    expect(classCounts.length).toBe(MASK_CLASS_COUNT);
    expect(classCounts[3]).toBe(2);
    expect(classCounts[7]).toBe(1);
    expect(classCounts[0]).toBe(1);
    expect(classCounts[1]).toBe(0);
  });

  it("tallies correctly even when width needs row padding (bytesPerRow > width)", () => {
    // width=1 forces bytesPerRow to pad up to 256, exercising the row-copy branch, not the fast path.
    const data = new Uint8Array([5, 5, 9]);
    const { classCounts } = uploadMaskArray(fakeDevice(), data, [1, 3, 1]);
    expect(classCounts[5]).toBe(2);
    expect(classCounts[9]).toBe(1);
  });

  it("throws if data.length doesn't match dims, rather than silently truncating/padding", () => {
    expect(() => uploadMaskArray(fakeDevice(), new Uint8Array([1, 2, 3]), [2, 2, 1])).toThrow();
  });

  it("throws if a dimension exceeds the device's maxTextureDimension3D", () => {
    const device = fakeDevice();
    (device.limits as { maxTextureDimension3D: number }).maxTextureDimension3D = 4;
    expect(() => uploadMaskArray(device, new Uint8Array(5 * 5 * 5), [5, 5, 5])).toThrow();
  });

  it("writes exactly one writeTexture call (no chunked/network upload path)", () => {
    const writeTexture = vi.fn();
    uploadMaskArray(fakeDevice(writeTexture), new Uint8Array([1, 2, 3, 4]), [2, 2, 1]);
    expect(writeTexture).toHaveBeenCalledTimes(1);
  });
});
