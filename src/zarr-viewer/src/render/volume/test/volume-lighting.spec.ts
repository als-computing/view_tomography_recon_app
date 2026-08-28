import { describe, expect, it } from "vitest";
import { applyVolumeLighting, type VolumeLightingState } from "../volume-lighting.js";

const DEFAULT: VolumeLightingState = {
  masterAmbient: 0.22,
  specStrength: 0.4,
  roughnessL: 0.6,
  shadowEnable: false,
  shadowSteps: 24,
  shadowStrength: 0.85,
  shadowSoftness: 0,
  aoEnable: false,
  aoRadius: 0.08,
  aoIntensity: 0.7,
  aoSamples: 6,
};

describe("applyVolumeLighting", () => {
  it("keeps unset fields from current state", () => {
    expect(applyVolumeLighting(DEFAULT, {})).toEqual(DEFAULT);
  });

  it("maps `roughness` param onto the `roughnessL` field", () => {
    expect(applyVolumeLighting(DEFAULT, { roughness: 0.9 }).roughnessL).toBe(0.9);
  });

  it("overrides boolean fields, including setting them to false", () => {
    const enabled = applyVolumeLighting(DEFAULT, { shadowEnable: true, aoEnable: true });
    expect(enabled.shadowEnable).toBe(true);
    expect(enabled.aoEnable).toBe(true);
    const disabled = applyVolumeLighting(enabled, { shadowEnable: false, aoEnable: false });
    expect(disabled.shadowEnable).toBe(false);
    expect(disabled.aoEnable).toBe(false);
  });

  it("rounds shadowSteps and aoSamples to a non-negative integer", () => {
    expect(applyVolumeLighting(DEFAULT, { shadowSteps: 5.6 }).shadowSteps).toBe(6);
    expect(applyVolumeLighting(DEFAULT, { shadowSteps: -3 }).shadowSteps).toBe(0);
    expect(applyVolumeLighting(DEFAULT, { aoSamples: 2.4 }).aoSamples).toBe(2);
    expect(applyVolumeLighting(DEFAULT, { aoSamples: -1 }).aoSamples).toBe(0);
  });

  it("overrides scalar strength/intensity fields directly", () => {
    const next = applyVolumeLighting(DEFAULT, {
      masterAmbient: 0.5,
      specStrength: 0.9,
      shadowStrength: 0.1,
      shadowSoftness: 0.5,
      aoRadius: 0.2,
      aoIntensity: 1,
    });
    expect(next.masterAmbient).toBe(0.5);
    expect(next.specStrength).toBe(0.9);
    expect(next.shadowStrength).toBe(0.1);
    expect(next.shadowSoftness).toBe(0.5);
    expect(next.aoRadius).toBe(0.2);
    expect(next.aoIntensity).toBe(1);
  });
});
