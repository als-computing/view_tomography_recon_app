import { describe, it, expect } from "vitest";
import { asClassIdSamples } from "../mask-texture.js";

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
