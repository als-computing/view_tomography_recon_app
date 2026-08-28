import { describe, expect, it } from "vitest";
import { asColor3 } from "@zarr-viewer/math";
import {
  applyLiquidShading,
  applyMeasurePlane,
  applyLegacyLight,
  type LiquidShadingState,
  type LegacyLightState,
} from "../volume-shading-params.js";

const LIQUID_DEFAULT: LiquidShadingState = {
  enabled: false,
  ior: 1.333,
  roughness: 0.04,
  envIntensity: 1.2,
  absorptionScale: 2.5,
};

describe("applyLiquidShading", () => {
  it("keeps unset fields from current state", () => {
    const next = applyLiquidShading(LIQUID_DEFAULT, {});
    expect(next).toEqual(LIQUID_DEFAULT);
  });

  it("sets enabled directly", () => {
    expect(applyLiquidShading(LIQUID_DEFAULT, { enabled: true }).enabled).toBe(true);
  });

  it("clamps ior to [1.0, 3.5]", () => {
    expect(applyLiquidShading(LIQUID_DEFAULT, { ior: 0.1 }).ior).toBe(1.0);
    expect(applyLiquidShading(LIQUID_DEFAULT, { ior: 10 }).ior).toBe(3.5);
    expect(applyLiquidShading(LIQUID_DEFAULT, { ior: 1.5 }).ior).toBe(1.5);
  });

  it("clamps roughness to [0.012, 1]", () => {
    expect(applyLiquidShading(LIQUID_DEFAULT, { roughness: 0 }).roughness).toBe(0.012);
    expect(applyLiquidShading(LIQUID_DEFAULT, { roughness: 5 }).roughness).toBe(1);
  });

  it("clamps envIntensity to >= 0", () => {
    expect(applyLiquidShading(LIQUID_DEFAULT, { envIntensity: -1 }).envIntensity).toBe(0);
  });

  it("clamps absorptionScale to >= 0.05", () => {
    expect(applyLiquidShading(LIQUID_DEFAULT, { absorptionScale: 0 }).absorptionScale).toBe(0.05);
  });
});

describe("applyMeasurePlane", () => {
  it("fully replaces state from params", () => {
    const next = applyMeasurePlane({
      enabled: true,
      depth: 3.5,
      gray: 0.2,
      alpha: 0.9,
      forward: [0, 0, -1],
    });
    expect(next).toEqual({ enabled: true, depth: 3.5, gray: 0.2, alpha: 0.9, forward: [0, 0, -1] });
  });

  it("copies the forward tuple rather than aliasing the input array", () => {
    const forward: [number, number, number] = [1, 0, 0];
    const next = applyMeasurePlane({ enabled: false, depth: 0, gray: 0, alpha: 0, forward });
    next.forward[0] = 9;
    expect(forward[0]).toBe(1);
  });
});

describe("applyLegacyLight", () => {
  const current: LegacyLightState = {
    ambient: 0.22,
    specularPower: 48,
    lightDirection: [0.45, 0.85, 0.35],
    lightColor: asColor3([1, 0.96, 0.9]),
  };

  it("keeps unset fields from current state", () => {
    expect(applyLegacyLight(current, {})).toEqual(current);
  });

  it("overrides ambient/specularPower directly", () => {
    const next = applyLegacyLight(current, { ambient: 0.5, specularPower: 10 });
    expect(next.ambient).toBe(0.5);
    expect(next.specularPower).toBe(10);
  });

  it("copies lightDirection rather than aliasing the input array", () => {
    const dir: [number, number, number] = [1, 0, 0];
    const next = applyLegacyLight(current, { lightDirection: dir });
    next.lightDirection[0] = 9;
    expect(dir[0]).toBe(1);
  });

  it("converts lightColor via asColor3", () => {
    const next = applyLegacyLight(current, { lightColor: [0, 0, 0] });
    expect(next.lightColor).toEqual(asColor3([0, 0, 0]));
  });
});
