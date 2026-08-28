import { describe, expect, it } from "vitest";
import { Mat4 } from "@zarr-viewer/math";
import {
  writeVolumeFrameUniform,
  type VolumeAccelerationLike,
  type VolumeFrameParams,
} from "../volume-uniforms.js";

const FAKE_ACCEL: VolumeAccelerationLike = {
  keyLightDirection: [0, 1, 0],
  keyLightRadiance: [1, 1, 1],
  lightCount: 2,
  occupancyGrid: [4, 5, 6],
  visGrid: [7, 8, 9],
  worldToLight: new Float32Array(16).map((_, i) => i),
  shadowActive: true,
};

const BASE_PARAMS: VolumeFrameParams = {
  eye: { x: 1, y: 2, z: 3 },
  clear: true,
  frameIndex: 42,
  boxHalf: [0.5, 0.5, 0.5],
  maxSteps: 4096,
  stepSize: 1 / 260,
  densityScale: 1.35,
  exposure: 1.15,
  masterAmbient: 0.22,
  specularPower: 48,
  blendMode: "composite",
  gradientOpacity: 0,
  gradientOpacityScale: 0.15,
  lightingStrength: 1,
  liquidEnabled: false,
  liquidIor: 1.333,
  liquidRoughness: 0.04,
  liquidEnvIntensity: 1.2,
  liquidAbsorptionScale: 2.5,
  cropMin: [0, 0, 0],
  cropMax: [1, 1, 1],
  sliceX: 0.5,
  sliceY: 0.5,
  sliceZ: 0.5,
  sliceEnableX: false,
  sliceEnableY: false,
  sliceEnableZ: false,
  showSlicePlanes: false,
  viewMode: "volume",
  linearOutput: false,
  earlyRayTermination: 0.995,
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
  measurePlaneEnabled: false,
  measurePlaneDepth: 0,
  measurePlaneGray: 0.5,
  measurePlaneAlpha: 0.35,
  measureForward: [0, 0, 1],
  brickMin: [0, 0, 0],
  brickMax: [0, 0, 0],
  brickEnabled: false,
  brickBlend: 1,
  visEnabled: false,
  internalWidth: 800,
  internalHeight: 600,
  reprojectFar: 1,
  camRight: [1, 0, 0],
  camUp: [0, 1, 0],
  camAspect: 800 / 600,
  tanHalfFovY: Math.tan((42 * Math.PI) / 180 / 2),
};

function pack(overrides: Partial<VolumeFrameParams> = {}): Float32Array {
  const d = new Float32Array(128);
  writeVolumeFrameUniform(d, new Mat4(), FAKE_ACCEL, { ...BASE_PARAMS, ...overrides });
  return d;
}

describe("writeVolumeFrameUniform", () => {
  it("writes the inverted view-projection into floats 0-15", () => {
    const d = pack();
    // Mat4() defaults to identity; toArray writes column-major straight through.
    expect(Array.from(d.slice(0, 16))).toEqual([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ]);
  });

  it("writes eye position and frame index", () => {
    const d = pack();
    expect(d[16]).toBe(1);
    expect(d[17]).toBe(2);
    expect(d[18]).toBe(3);
    expect(d[19]).toBe(42);
  });

  it("floors the step size so the ray always crosses the box within maxSteps", () => {
    // stepSize far finer than the box/maxSteps budget allows — should be clamped up, not honored.
    const d = pack({ stepSize: 1e-9, boxHalf: [10, 10, 10], maxSteps: 100 });
    const diagonal = 2 * Math.hypot(10, 10, 10);
    const minStep = diagonal / (100 - 8);
    expect(d[20]).toBeCloseTo(minStep, 6);
    expect(d[22]).toBeLessThanOrEqual(100);
  });

  it("packs blend mode and view mode as their integer ids", () => {
    expect(pack({ blendMode: "composite" })[35]).toBe(0);
    expect(pack({ blendMode: "mip" })[35]).toBe(1);
    expect(pack({ blendMode: "minip" })[35]).toBe(2);
    expect(pack({ blendMode: "average" })[35]).toBe(3);
  });

  it("packs slice-enable/show-planes/view-mode into the flags bitfield", () => {
    const none = pack();
    expect(none[51]).toBe(0); // volume mode, id 0, no flags set

    const allSlices = pack({
      sliceEnableX: true,
      sliceEnableY: true,
      sliceEnableZ: true,
      showSlicePlanes: true,
      viewMode: "xPlane",
    });
    // bits 0-3 set (1+2+4+8=15), view mode id 1 shifted into bits 4-5 (1<<4=16) → 31
    expect(allSlices[51]).toBe(31);
  });

  it("reads light data through the acceleration accessor", () => {
    const d = pack();
    expect(d[24]).toBeCloseTo(0); // keyDir normalized x (dir is [0,1,0])
    expect(d[25]).toBeCloseTo(1); // keyDir normalized y
    expect(d[28]).toBe(1); // keyRad
    expect(d[60]).toBe(2); // lightCount
    const occ = FAKE_ACCEL.occupancyGrid;
    expect([d[88], d[89], d[90]]).toEqual(occ);
    const vis = FAKE_ACCEL.visGrid;
    expect([d[92], d[93], d[94]]).toEqual(vis);
    for (let k = 0; k < 16; k++) expect(d[100 + k]).toBe(k);
    expect(d[116]).toBe(1); // shadowActive
  });

  it("packs the alpha-composite flag from `clear`", () => {
    expect(pack({ clear: true })[56]).toBe(0);
    expect(pack({ clear: false })[56]).toBe(1);
  });

  it("packs camera basis with fov half-extents in the w components", () => {
    const d = pack({ camAspect: 2, tanHalfFovY: 0.5 });
    expect(d[123]).toBeCloseTo(1); // tanHalfFovY * aspect
    expect(d[127]).toBeCloseTo(0.5);
  });
});
