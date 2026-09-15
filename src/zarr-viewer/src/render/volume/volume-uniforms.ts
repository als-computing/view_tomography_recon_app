/**
 * One-shot packer for `VolumeRenderer`'s per-frame uniform buffer (`frameData`, 188 floats at fixed
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

/** Primary view mode. `"oblique"` slices along an arbitrary world-space plane (`Frame.obliqueNormal`)
 * instead of an axis-aligned one — unlike the other 3 plane modes, its plane is set by the caller
 * (`VolumeFrameParams.obliqueNormal`/`obliqueOffset`), not implied by which mode is active. */
export type VolumeViewMode = "volume" | "xPlane" | "yPlane" | "zPlane" | "oblique";

const BLEND_MODE_ID: Record<VolumeBlendMode, number> = {
  composite: 0,
  mip: 1,
  minip: 2,
  average: 3,
};

// 3 bits (0-7) packed into Frame.slices.w bits 4-6 — was 2 bits (4 values, exactly volume/x/y/z) before
// "oblique" needed a 5th. Bit 7 is still free for a future 6th-8th mode.
const VIEW_MODE_ID: Record<VolumeViewMode, number> = {
  volume: 0,
  xPlane: 1,
  yPlane: 2,
  zPlane: 3,
  oblique: 4,
};

/** Every `VolumeRenderer` field `writeVolumeFrameUniform` needs, grouped as in the WGSL `Frame` struct. */
export interface VolumeFrameParams {
  eye: { x: number; y: number; z: number };
  /** Resolved `options.clear !== false` — `false` composites with alpha instead of clearing. */
  clear: boolean;
  frameIndex: number;
  boxHalf: readonly [number, number, number];
  /** The box's own projected depth along the CURRENT view direction (i.e. the longest possible ray
   * chord through the box for this exact camera orientation — a box's support-function value along
   * `forward`, always ≤ the box's fixed 3D diagonal). Used as the worst-case distance the iteration
   * budget must be able to cross (see `writeVolumeFrameUniform`'s own comment) — NOT the static 3D
   * diagonal, which overstates the needed range for any view direction not aligned with the box's own
   * long diagonal, forcing an unnecessarily coarse step everywhere. */
  viewDepth: number;
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
  /** Show the oblique-plane overlay/highlight (independent of `viewMode` — like `sliceEnableX/Y/Z`,
   * this can be on even while `viewMode` is `"volume"`, e.g. for a tri-planar-style overview). */
  sliceEnableOblique: boolean;
  /** World-space unit normal of the oblique cut plane. Only meaningful when `viewMode === "oblique"`
   * or `sliceEnableOblique` is true. */
  obliqueNormal: readonly [number, number, number];
  /** Signed plane offset: the plane is every world point `p` where `dot(p, obliqueNormal) ===
   * obliqueOffset`. */
  obliqueOffset: number;
  showSlicePlanes: boolean;
  /** Green wireframe-box indicator (independent of everything else here — not part of the crop/slice
   * system at all): highlights an arbitrary axis-aligned uvw `[0,1]^3` box, e.g. so a "context" pane can
   * show exactly what region a linked "detail" pane is cropped to. Deliberately its own flag/fields, not
   * reusing `cropMin`/`cropMax` — those drive the crop system's own AABB test and must stay `[0,1]`
   * (uncropped) on a pane that shows this indicator while remaining un-cropped itself. */
  overlayBoxEnabled: boolean;
  overlayBoxMin: readonly [number, number, number];
  overlayBoxMax: readonly [number, number, number];
  viewMode: VolumeViewMode;
  linearOutput: boolean;
  earlyRayTermination: number;
  /** Phase 1a hardening: true while a separate half-res LightingPass will compute AO/shadow/multi-
   * scatter this frame — forces the main march's own `heavy` gate off (see
   * VolumeRenderer.setDeferLighting()'s doc comment). Packed into `Frame.composite.w`, previously
   * unused padding. */
  deferLighting: boolean;
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
  /** Up to 4 simultaneously-resident ROI brick slots (item 9 multi-brick residency; stage 9b wires
   * a real shared `BrickAtlas` behind `brickTex` — each slot's `atlasOrigin` locates its data within
   * that one texture). Each slot's `worldMin`/`worldMax` are the world (sim-unit) box its portion
   * of the atlas maps onto. */
  bricks: readonly [BrickSlotParams, BrickSlotParams, BrickSlotParams, BrickSlotParams];
  /** Voxels per axis of one atlas slot (all slots are equal-size cubes) — lets the shader convert a
   * slot-local `[0,1]³` sample into the atlas's own texel coordinates via `atlasOrigin`. Shared by all
   * 4 slots (one atlas, one slot size, chosen once at atlas construction). */
  brickSlotSize: number;
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
  /** Phase 1e hardening: `min(0.01, lowest density at which the current TF is non-transparent)` —
   * the raymarch's empty-space skip only ever discards densities below this, so a TF with an opaque
   * feature under the old fixed 0.01 threshold is never silently dropped. Computed CPU-side from the
   * baked TF LUT (see `VolumeRenderer.setTransferFunction`). */
  lowDensitySkipThreshold: number;
}

/** One resident ROI brick slot's frame-uniform inputs (item 9; `atlasOrigin` added in stage 9b once
 * `brickTex` became a real shared `BrickAtlas` instead of a dedicated per-slot texture). */
export interface BrickSlotParams {
  enabled: boolean;
  worldMin: readonly [number, number, number];
  worldMax: readonly [number, number, number];
  /** Fade weight [0,1] for this slot (drives smooth zoom-out) — independent per slot. */
  blend: number;
  /** This slot's voxel origin within the shared atlas texture (`BrickAtlas.slotVoxelOrigin`) — lets
   * the shader offset a slot-local `[0,1]³` sample into the atlas's own texel coordinates. */
  atlasOrigin: readonly [number, number, number];
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
 * Pack one frame's worth of uniforms into `d` (196 floats, fixed offsets — see inline comments for
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
  // 3 bits (was 2, room for 4 modes - "oblique" needed a 5th) at bits 4-6.
  flags |= (VIEW_MODE_ID[p.viewMode] & 7) << 4;
  if (p.sliceEnableOblique) flags |= 128; // bit 7
  if (p.overlayBoxEnabled) flags |= 256; // bit 8 — green wireframe-box indicator

  const alphaComposite = p.clear ? 0 : 1;

  invViewProj.toArray(d, 0);
  d[16] = p.eye.x;
  d[17] = p.eye.y;
  d[18] = p.eye.z;
  d[19] = p.frameIndex;
  // Never let the step be so fine that the hard iteration cap can't cross the volume — otherwise the
  // far side is left unsampled and the volume appears to vanish. Floor the step at the budget-limited
  // minimum (viewDepth / usable steps) so the ray always reaches the far face; a requested step finer
  // than that is clamped up (as fine as the budget allows). This makes any caller-set step (e.g. the
  // fine ROI-brick step) safe regardless of box size / sample-distance.
  //
  // Uses `p.viewDepth` (the box's own projected depth along the CURRENT view direction), not the box's
  // static 3D diagonal — found live: the diagonal is the worst case only for a ray that happens to run
  // corner-to-corner along the box's own long diagonal; for any other view direction it overstates how
  // far a ray actually needs to travel, inflating `minStep` (and so `effStep`) well past what's needed —
  // most visible looking nearly end-on down a strongly elongated volume's long axis, or along the short
  // axis of a flat/wide one, where the true per-ray distance is much less than the full diagonal but the
  // old fixed-diagonal floor still forced the coarsest possible step everywhere. `viewDepth` is exactly
  // the box's support-function value along `forward` (always ≤ the diagonal, equal to it only when
  // looking exactly down the box's own long diagonal), so this is a tighter, still fully correct bound
  // on the worst-case chord length for THIS frame's actual camera orientation.
  const viewDepth = p.viewDepth;
  const minStep = viewDepth / Math.max(p.maxSteps - 8, 1);
  const effStep = Math.max(p.stepSize, minStep, 5e-4);
  d[20] = effStep;
  d[21] = p.densityScale;
  const neededSteps = Math.ceil(viewDepth / effStep) + 8;
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
  d[59] = p.deferLighting ? 1 : 0; // Frame.composite.w → defer heavy lighting to the half-res pass
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
  // brickWorldMin[0..3] / brickWorldMax[0..3] (item 9, stage 9a): per-slot world min (w = enabled)
  // then world max (w = blend fade weight), 4 slots x 2 vec4 = floats 80..111.
  for (let i = 0; i < 4; i++) {
    const b = p.bricks[i]!;
    d[80 + i * 4] = b.worldMin[0];
    d[81 + i * 4] = b.worldMin[1];
    d[82 + i * 4] = b.worldMin[2];
    d[83 + i * 4] = b.enabled ? 1 : 0;
    d[96 + i * 4] = b.worldMax[0];
    d[97 + i * 4] = b.worldMax[1];
    d[98 + i * 4] = b.worldMax[2];
    d[99 + i * 4] = b.blend;
  }
  const occ = accel.occupancyGrid;
  d[112] = occ[0];
  d[113] = occ[1];
  d[114] = occ[2];
  d[115] = 0;
  const visGrid = accel.visGrid;
  d[116] = visGrid[0];
  d[117] = visGrid[1];
  d[118] = visGrid[2];
  d[119] = p.visEnabled ? 1 : 0;
  d[120] = p.internalWidth;
  d[121] = p.internalHeight;
  d[122] = TILE_SIZE;
  d[123] = 0;
  // worldToLight mat4 (Milestone 7.1) at floats 124..139, then shadowCtl at 140.
  const worldToLight = accel.worldToLight;
  for (let k = 0; k < 16; k++) d[124 + k] = worldToLight[k]!;
  d[140] = accel.shadowActive ? 1 : 0;
  d[141] = p.reprojectFar; // shadowCtl.y → depth-centroid normalization (TAAU)
  d[142] = 0;
  d[143] = 0;
  // camRight: camera right axis (world, unit), w = tan(halfFovY) * aspect (horizontal half-extent)
  d[144] = p.camRight[0];
  d[145] = p.camRight[1];
  d[146] = p.camRight[2];
  d[147] = p.tanHalfFovY * p.camAspect;
  // camUp: camera up axis (world, unit), w = tan(halfFovY) (vertical half-extent)
  d[148] = p.camUp[0];
  d[149] = p.camUp[1];
  d[150] = p.camUp[2];
  d[151] = p.tanHalfFovY;
  // mask0Ctl / mask1Ctl: enable, mask voxel dims (xyz), one vec4 per slot — item 7 Phase B.
  const [mask0, mask1] = p.masks;
  d[152] = mask0.enabled ? 1 : 0;
  d[153] = mask0.dims[0];
  d[154] = mask0.dims[1];
  d[155] = mask0.dims[2];
  d[156] = mask1.enabled ? 1 : 0;
  d[157] = mask1.dims[0];
  d[158] = mask1.dims[1];
  d[159] = mask1.dims[2];
  // skipCtl: lowDensitySkipThreshold (Phase 1e hardening), yzw unused.
  d[160] = p.lowDensitySkipThreshold;
  d[161] = 0;
  d[162] = 0;
  d[163] = 0;
  // brickAtlasOrigin[0..3] (item 9 stage 9b): per-slot voxel origin within the shared BrickAtlas
  // texture, xyz + w unused, floats 164..179.
  for (let i = 0; i < 4; i++) {
    const b = p.bricks[i]!;
    d[164 + i * 4] = b.atlasOrigin[0];
    d[165 + i * 4] = b.atlasOrigin[1];
    d[166 + i * 4] = b.atlasOrigin[2];
    d[167 + i * 4] = 0;
  }
  // brickSlotSize: voxels per axis of one atlas slot (shared by all 4 slots), yzw unused.
  d[180] = p.brickSlotSize;
  d[181] = 0;
  d[182] = 0;
  d[183] = 0;
  // obliqueNormal: world-space unit normal (xyz) of the oblique cut plane, w = signed plane offset
  // (dot(worldPos, normal) === offset defines the plane).
  d[184] = p.obliqueNormal[0];
  d[185] = p.obliqueNormal[1];
  d[186] = p.obliqueNormal[2];
  d[187] = p.obliqueOffset;
  // overlayBoxMin/overlayBoxMax: uvw-space [0,1]^3 box for the green wireframe-box indicator, w unused.
  d[188] = p.overlayBoxMin[0];
  d[189] = p.overlayBoxMin[1];
  d[190] = p.overlayBoxMin[2];
  d[191] = 0;
  d[192] = p.overlayBoxMax[0];
  d[193] = p.overlayBoxMax[1];
  d[194] = p.overlayBoxMax[2];
  d[195] = 0;
}
