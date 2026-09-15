import { describe, expect, it } from "vitest";
import { TransferFunction, windowLevelTransferFunction, normalizeWindowLevel } from "../transfer-function.js";

describe("TransferFunction.toLut — low-density visibility", () => {
  it("makes a low-density value visible when the TF opacity there is 1", () => {
    // Scientific-correctness regression: visibility must come from the TF-mapped alpha at a given
    // density, not from the raw density magnitude — a volume value of 0.005 is "low density" but
    // fully opaque under a TF that maps it to alpha=1.
    const tf = new TransferFunction([
      { position: 0, color: [1, 1, 1, 0] },
      { position: 0.005, color: [1, 1, 1, 1] },
      { position: 1, color: [1, 1, 1, 1] },
    ]);
    const size = 512;
    const lut = tf.toLut(size);
    const index = Math.round(0.005 * (size - 1));
    expect(lut[index * 4 + 3]).toBe(255);
  });

  it("leaves a value invisible when the TF opacity there is 0, regardless of density magnitude", () => {
    const tf = new TransferFunction([
      { position: 0, color: [1, 1, 1, 0] },
      { position: 1, color: [1, 1, 1, 0] },
    ]);
    const lut = tf.toLut(256);
    // Even a high-density sample (position near 1) stays invisible under an all-zero-alpha TF.
    expect(lut[255 * 4 + 3]).toBe(0);
  });

  it("linearly interpolates alpha between stops", () => {
    const tf = new TransferFunction([
      { position: 0, color: [0, 0, 0, 0] },
      { position: 1, color: [0, 0, 0, 1] },
    ]);
    const lut = tf.toLut(101); // index 50 -> t = 0.5
    expect(lut[50 * 4 + 3]).toBeCloseTo(128, -1);
  });

  it("clamps to the first/last stop outside the stop range", () => {
    const tf = new TransferFunction([
      { position: 0.25, color: [0, 0, 0, 0.4] },
      { position: 0.75, color: [0, 0, 0, 0.9] },
    ]);
    const lut = tf.toLut(101);
    expect(lut[0 * 4 + 3]).toBe(Math.round(0.4 * 255));
    expect(lut[100 * 4 + 3]).toBe(Math.round(0.9 * 255));
  });
});

describe("windowLevelTransferFunction / normalizeWindowLevel", () => {
  it("maps a data-space window into normalized center/width", () => {
    const { center, width } = normalizeWindowLevel(20, 60, [0, 100]);
    expect(center).toBeCloseTo(0.4, 5);
    expect(width).toBeCloseTo(0.4, 5);
  });

  it("produces peak opacity at the window center", () => {
    const tf = windowLevelTransferFunction({ center: 0.5, width: 0.3, opacity: 0.7 });
    const lut = tf.toLut(512);
    const centerIndex = Math.round(0.5 * 511);
    expect(lut[centerIndex * 4 + 3]).toBeCloseTo(Math.round(0.7 * 255), -1);
  });

  it("is fully transparent well outside the window", () => {
    const tf = windowLevelTransferFunction({ center: 0.5, width: 0.1, opacity: 0.8 });
    const lut = tf.toLut(512);
    expect(lut[0 * 4 + 3]).toBe(0);
    expect(lut[511 * 4 + 3]).toBe(0);
  });
});
