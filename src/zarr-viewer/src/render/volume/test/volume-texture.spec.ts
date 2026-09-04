import { describe, it, expect } from "vitest";
import { asFloatSamples } from "../volume-texture.js";
import type { VolumeDType } from "@zarr-viewer/io";

describe("asFloatSamples", () => {
  it("reads every VolumeDType at its correct element size and value (was silently misreading int8/int16/uint32/int32 as raw uint8 bytes)", () => {
    const cases: Array<{ dtype: VolumeDType; make: () => ArrayBufferView; expected: number[] }> = [
      { dtype: "uint8", make: () => Uint8Array.of(0, 128, 255), expected: [0, 128, 255] },
      { dtype: "int8", make: () => Int8Array.of(-128, 0, 127), expected: [-128, 0, 127] },
      { dtype: "uint16", make: () => Uint16Array.of(0, 40000, 65535), expected: [0, 40000, 65535] },
      { dtype: "int16", make: () => Int16Array.of(-32768, 0, 32767), expected: [-32768, 0, 32767] },
      { dtype: "uint32", make: () => Uint32Array.of(0, 1_000_000, 4_000_000_000), expected: [0, 1_000_000, 4_000_000_000] },
      { dtype: "int32", make: () => Int32Array.of(-2_000_000_000, 0, 2_000_000_000), expected: [-2_000_000_000, 0, 2_000_000_000] },
      { dtype: "float32", make: () => Float32Array.of(-1.5, 0, 2.5), expected: [-1.5, 0, 2.5] },
      { dtype: "float64", make: () => Float64Array.of(-1.5, 0, 2.5), expected: [-1.5, 0, 2.5] },
    ];
    for (const { dtype, make, expected } of cases) {
      const out = asFloatSamples(make(), dtype);
      expect(out.length).toBe(expected.length);
      for (let i = 0; i < expected.length; i++) {
        const exp = expected[i]!;
        // uint32/int32 magnitudes beyond float32's 24-bit integer range round on the way to Float32Array
        // (an accepted, documented characteristic of this dtype - not exact-value preservation); use a
        // relative tolerance there instead of exact equality. Every other dtype's full range is exactly
        // representable in float32.
        if (dtype === "uint32" || dtype === "int32") {
          expect(Math.abs(out[i]! - exp)).toBeLessThan(Math.max(1, Math.abs(exp)) * 1e-6);
        } else {
          expect(out[i]).toBe(exp);
        }
      }
    }
  });

  it("returns the input array directly for float32 (no copy) but a fresh array for narrower dtypes", () => {
    const f32 = Float32Array.of(1, 2, 3);
    expect(asFloatSamples(f32, "float32")).toBe(f32);
    const u16 = Uint16Array.of(1, 2, 3);
    expect(asFloatSamples(u16, "uint16")).not.toBe(u16);
  });
});
