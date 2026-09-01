/**
 * One-shot packer for `VolumeRenderer`'s per-frame uniform buffer (`frameData`, 136 floats at fixed
 * offsets matching `VOLUME_FRAME_UNIFORM_SIZE`/the WGSL `Frame` struct). Kept as a single flat
 * `write()` function rather than incremental setter-driven mutation, since the buffer's whole point is
 * one contiguous upload per frame — see `volume-raymarch.ts` for the WGSL-side layout this must match
 * field-for-field.
 *
 * @packageDocumentation
 */

import type { Mat4 } from "@zarr-viewer/math";
import { TILE_SIZE } from "../accel/tiles.js";

/**
 * The subset of `VolumeAcceleration`'s shape this packer needs. A structural type (rather than
 * importing the concrete class) keeps this module testable without a GPU device.
 */
export interface VolumeAccelerationLike {
  readonly keyLightDirection: readonly [number, number, number];
  readonly keyLightRadiance: readonly [number, number, number];
  readonly lightCount: number;
  readonly occupancyGrid: readonly [number, number, number];
  readonly visGrid: readonly [number, number, number];
  readonly worldToLight: Float32Array;
  readonly shadowActive: boolean;
}

/** Volume blend / compositing mode (itk-vtk `setImageBlendMode`). */
export type VolumeBlendMode = "composite" | "mip" | "minip" | "average";

/** Primary view mode. */
export type VolumeViewMode = "volume" | "xPlane" | "yPlane" | "zPlane";

const BLEND_MODE_ID: Record<VolumeBlendMode, number> = {
  composite: 0,
  mip: 1,
  minip: 2,
  average: 3,
};

const VIEW_MODE_ID: Record<VolumeViewMode, number> = {
  volume: 0,
  xPlane: 1,
  yPlane: 2,
  zPlane: 3,
};

/** Every `VolumeRenderer` field `writeVolumeFrameUniform` needs, grouped as in the WGSL `Frame` struct. */
export interface VolumeFrameParams {
  eye: { x: number; y: number; z: number };
  /** Resolved `options.clear !== false` — `false` composites with alpha instead of clearing. */
  clear: boolean;
  frameIndex: number;
  boxHalf: readonly [number, number, number];
  maxSteps: number;
  stepSize: number;
  densityScale: number;
  exposure: number;
  masterAmbient: number;
  specularPower: number;
  blendMode: VolumeBlendMode;
  gradientOpacity: number;
  gradientOpacityScale: number;
  lightingStrength: number;
  liquidEnabled: boolean;
  liquidIor: number;
  liquidRoughness: number;
  liquidEnvIntensity: number;
  liquidAbsorptionScale: number;
  cropMin: readonly [number, number, number];
  cropMax: readonly [number, number, number];
  sliceX: number;
  sliceY: number;
  sliceZ: number;
  sliceEnableX: boolean;
  sliceEnableY: boolean;
  sliceEnableZ: boolean;
  showSlicePlanes: boolean;
  viewMode: VolumeViewMode;
  linearOutput: boolean;
  earlyRayTermination: number;
  specStrength: number;
  roughnessL: number;
  shadowEnable: boolean;
  shadowSteps: number;
  shadowStrength: number;
  shadowSoftness: number;
  aoEnable: boolean;
  aoRadius: number;
  aoIntensity: number;
  aoSamples: number;
  measurePlaneEnabled: boolean;
  measurePlaneDepth: number;
  measurePlaneGray: number;
  measurePlaneAlpha: number;
  measureForward: readonly [number, number, number];
  brickMin: readonly [number, number, number];
  brickMax: readonly [number, number, number];
  brickEnabled: boolean;
  brickBlend: number;
  visEnabled: boolean;
  internalWidth: number;
  internalHeight: number;
  reprojectFar: number;
  camRight: readonly [number, number, number];
  camUp: readonly [number, number, number];
  camAspect: number;
  tanHalfFovY: number;
  /** Two independent mask/annotation slots (item 7 Phase B), fixed at exactly two — not generalized
   * to N. Both same-grid as the primary — no separate world box. */
  masks: readonly [MaskSlotParams, MaskSlotParams];
}

/** One mask slot's frame-uniform inputs. */
export interface MaskSlotParams {
  enabled: boolean;
  /** This slot's mask texture's own voxel dimensions (may differ from the primary's *currently
   * displayed* level even though both share the same physical grid) — needed to convert a uvw sample
   * into an exact mask voxel index for `textureLoad`. */
  dims: readonly [number, number, number];
}

/**
 * Pack one frame's worth of uniforms into `d` (136 floats, fixed offsets — see inline comments for
 * each named group). Does not upload to the GPU; the caller writes `d` to the uniform buffer.
 * `invViewProj` must already be the inverted view-projection for this frame.
 */
export function writeVolumeFrameUniform(
  d: Float32Array,
  invViewProj: Mat4,
  accel: VolumeAccelerationLike,
  p: VolumeFrameParams,
): void {
  // Key light for the procedural studio env (background / dielectric): the first directional in
  // the light list, or a sensible default when none is set.
  const keyDir = accel.keyLightDirection;
  const keyRad = accel.keyLightRadiance;
  const klen = Math.hypot(keyDir[0], keyDir[1], keyDir[2]) || 1;

  let flags = 0;
  if (p.sliceEnableX) flags |= 1;
  if (p.sliceEnableY) flags |= 2;
  if (p.sliceEnableZ) flags |= 4;
  if (p.showSlicePlanes) flags |= 8;
  flags |= (VIEW_MODE_ID[p.viewMode] & 3) << 4;

  const alphaComposite = p.clear ? 0 : 1;

  invViewProj.toArray(d, 0);
  d[16] = p.eye.x;
  d[17] = p.eye.y;
  d[18] = p.eye.z;
  d[19] = p.frameIndex;
  // Never let the step be so fine that the hard iteration cap can't cross the volume — otherwise the
  // far side is left unsampled and the volume appears to vanish. Floor the step at the budget-limited
  // minimum (diagonal / usable steps) so the ray always reaches the far face; a requested step finer
  // than that is clamped up (as fine as the budget allows). This makes any caller-set step (e.g. the
  // fine ROI-brick step) safe regardless of box size / sample-distance.
  const diagonal = 2 * Math.hypot(p.boxHalf[0], p.boxHalf[1], p.boxHalf[2]);
  const minStep = diagonal / Math.max(p.maxSteps - 8, 1);
  const effStep = Math.max(p.stepSize, minStep, 5e-4);
  d[20] = effStep;
  d[21] = p.densityScale;
  const neededSteps = Math.ceil(diagonal / effStep) + 8;
  d[22] = Math.min(p.maxSteps, neededSteps);
  d[23] = p.exposure;
  d[24] = keyDir[0] / klen;
  d[25] = keyDir[1] / klen;
  d[26] = keyDir[2] / klen;
  d[27] = p.masterAmbient;
  d[28] = keyRad[0];
  d[29] = keyRad[1];
  d[30] = keyRad[2];
  d[31] = p.specularPower;
  d[32] = p.boxHalf[0];
  d[33] = p.boxHalf[1];
  d[34] = p.boxHalf[2];
  d[35] = BLEND_MODE_ID[p.blendMode];
  d[36] = p.gradientOpacity;
  d[37] = p.gradientOpacityScale;
  d[38] = p.lightingStrength;
  d[39] = p.liquidEnabled ? 1 : 0;
  d[40] = p.cropMin[0];
  d[41] = p.cropMin[1];
  d[42] = p.cropMin[2];
  d[43] = 0;
  d[44] = p.cropMax[0];
  d[45] = p.cropMax[1];
  d[46] = p.cropMax[2];
  d[47] = 0;
  d[48] = p.sliceX;
  d[49] = p.sliceY;
  d[50] = p.sliceZ;
  d[51] = flags;
  d[52] = p.liquidIor;
  d[53] = p.liquidRoughness;
  d[54] = p.liquidEnvIntensity;
  d[55] = p.liquidAbsorptionScale;
  d[56] = alphaComposite;
  d[57] = p.linearOutput ? 1 : 0; // Frame.composite.y → linear-HDR output flag
  d[58] = p.earlyRayTermination;
  d[59] = 0;
  // lightCtl0: numLights, masterAmbient, specStrength, roughness
  d[60] = accel.lightCount;
  d[61] = p.masterAmbient;
  d[62] = p.specStrength;
  d[63] = p.roughnessL;
  // lightCtl1: shadowEnable, shadowSteps, shadowStrength, shadowSoftness
  d[64] = p.shadowEnable ? 1 : 0;
  d[65] = p.shadowSteps;
  d[66] = p.shadowStrength;
  d[67] = p.shadowSoftness;
  // lightCtl2: aoEnable, aoRadius, aoIntensity, aoSamples
  d[68] = p.aoEnable ? 1 : 0;
  d[69] = p.aoRadius;
  d[70] = p.aoIntensity;
  d[71] = p.aoSamples;
  // measurePlane: enable, depth (world along view axis), gray, alpha
  d[72] = p.measurePlaneEnabled ? 1 : 0;
  d[73] = p.measurePlaneDepth;
  d[74] = p.measurePlaneGray;
  d[75] = p.measurePlaneAlpha;
  // measureFwd: camera forward (world, unit)
  d[76] = p.measureForward[0];
  d[77] = p.measureForward[1];
  d[78] = p.measureForward[2];
  d[79] = 0;
  // brickMin: ROI brick world min, w = enable
  d[80] = p.brickMin[0];
  d[81] = p.brickMin[1];
  d[82] = p.brickMin[2];
  d[83] = p.brickEnabled ? 1 : 0;
  // brickMax: ROI brick world max, w = brickBlend fade weight
  d[84] = p.brickMax[0];
  d[85] = p.brickMax[1];
  d[86] = p.brickMax[2];
  d[87] = p.brickBlend;
  const occ = accel.occupancyGrid;
  d[88] = occ[0];
  d[89] = occ[1];
  d[90] = occ[2];
  d[91] = 0;
  const visGrid = accel.visGrid;
  d[92] = visGrid[0];
  d[93] = visGrid[1];
  d[94] = visGrid[2];
  d[95] = p.visEnabled ? 1 : 0;
  d[96] = p.internalWidth;
  d[97] = p.internalHeight;
  d[98] = TILE_SIZE;
  d[99] = 0;
  // worldToLight mat4 (Milestone 7.1) at floats 100..115, then shadowCtl at 116.
  const worldToLight = accel.worldToLight;
  for (let k = 0; k < 16; k++) d[100 + k] = worldToLight[k]!;
  d[116] = accel.shadowActive ? 1 : 0;
  d[117] = p.reprojectFar; // shadowCtl.y → depth-centroid normalization (TAAU)
  d[118] = 0;
  d[119] = 0;
  // camRight: camera right axis (world, unit), w = tan(halfFovY) * aspect (horizontal half-extent)
  d[120] = p.camRight[0];
  d[121] = p.camRight[1];
  d[122] = p.camRight[2];
  d[123] = p.tanHalfFovY * p.camAspect;
  // camUp: camera up axis (world, unit), w = tan(halfFovY) (vertical half-extent)
  d[124] = p.camUp[0];
  d[125] = p.camUp[1];
  d[126] = p.camUp[2];
  d[127] = p.tanHalfFovY;
  // mask0Ctl / mask1Ctl: enable, mask voxel dims (xyz), one vec4 per slot — item 7 Phase B.
  const [mask0, mask1] = p.masks;
  d[128] = mask0.enabled ? 1 : 0;
  d[129] = mask0.dims[0];
  d[130] = mask0.dims[1];
  d[131] = mask0.dims[2];
  d[132] = mask1.enabled ? 1 : 0;
  d[133] = mask1.dims[0];
  d[134] = mask1.dims[1];
  d[135] = mask1.dims[2];
}
