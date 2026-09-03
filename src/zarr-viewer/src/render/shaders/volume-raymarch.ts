/**
 * High-quality WGSL direct volume ray-marcher for {@link "../volume/volume-renderer".VolumeRenderer}.
 *
 * Supports composite / MIP / MinIP / average blend modes, crop AABB, axis slice planes / plane
 * views, gradient-modulated opacity, and dielectric liquid shading (Fresnel / env / Beer / GGX).
 *
 * @packageDocumentation
 */

import { LIGHT_STRUCT_WGSL } from "./lights.js";
import { PREINTEGRATION_SIGMA_MAX } from "../volume/preintegration-2d.js";
import { VOLUME_LIGHTING_SHARED_WGSL } from "./volume-lighting-shared.js";
import { MASK_BINDING_BASE } from "../volume/volume-bindings.js";

/** Byte size of the volume frame uniform block (mat4 + 24 × vec4 + shadow mat4 + shadowCtl + camRight/
 * camUp + 4-slot brick arrays — item 9 stage 9a grew this from 560 by 96 bytes replacing the old
 * single brickMin/brickMax vec4 pair with 4-slot brickWorldMin/brickWorldMax arrays). */
export const VOLUME_FRAME_UNIFORM_SIZE = 656;

/** Compile-time specialization for {@link volumeRaymarchWgsl}. */
export interface VolumeRaymarchSpec {
  /** Occupancy-grid HDDA + Chebyshev skip + majorant step (Milestone 4). */
  occupancy: boolean;
  /** Instanced tile quads instead of a fullscreen triangle (Milestone 4.5). */
  tiles: boolean;
  /** Multi-scatter octaves (Milestone 7.3), quality-only (0 = off). */
  multiScatterOctaves?: number;
  /** Bent-normal directional ambient (Milestone 7.2), quality-only. */
  bentNormalAmbient?: boolean;
  /** Analytic pre-integration (Milestone 3.1), quality-only. */
  preIntegrate?: boolean;
}

/**
 * High-quality volume ray-march WGSL (vertex + fragment), specialized for a named shader config.
 *
 * Once occupancy makes the march-loop iteration count data-dependent, every texture sample inside
 * the loop must be `textureSampleLevel` or `textureLoad` — never implicit-derivative `textureSample`.
 */
export function volumeRaymarchWgsl(spec: VolumeRaymarchSpec = { occupancy: false, tiles: false }): string {
  const OCC = spec.occupancy ? 1 : 0;
  const TILE = spec.tiles ? 1 : 0;
  const MS_OCTAVES = Math.max(0, Math.floor(spec.multiScatterOctaves ?? 0));
  const BENT = spec.bentNormalAmbient ? 1 : 0;
  const PREINT = spec.preIntegrate ? 1 : 0;
  return /* wgsl */ `
const OCCUPANCY: u32 = ${OCC}u;
const TILE_INSTANCED: u32 = ${TILE}u;
const MS_OCTAVES: u32 = ${MS_OCTAVES}u;
const BENT_NORMAL_AMBIENT: u32 = ${BENT}u;
const PRE_INTEGRATE: u32 = ${PREINT}u;
// Milestone 3.2: must match preintegration-2d.ts's PREINTEGRATION_SIGMA_MAX exactly - this is the
// sigma value the pre-integration table's top row represents, so v = sigma / SIGMA_MAX picks the
// right row via hardware bilinear sampling.
const SIGMA_MAX: f32 = ${PREINTEGRATION_SIGMA_MAX};
const VIS_SCALE: f32 = 128.0;
const SHADE_ALPHA_EPS: f32 = 1e-4;
const TARGET_SEGMENT_OPACITY: f32 = 0.25;

struct Frame {
  invViewProj: mat4x4<f32>,
  eye: vec4<f32>,            // xyz = camera, w = frame index
  params: vec4<f32>,         // x = stepSize, y = densityScale, z = maxSteps, w = exposure
  light: vec4<f32>,          // xyz = key light dir, w = ambient
  shade: vec4<f32>,          // xyz = key light color, w = specular power
  boxHalf: vec4<f32>,        // xyz = AABB half-extents, w = blendMode (0..3)
  quality: vec4<f32>,        // x = gradOpacity, y = gradScale, z = lightingStrength, w = dielectric (0/1)
  cropMin: vec4<f32>,        // xyz = crop min in uvw [0,1]
  cropMax: vec4<f32>,        // xyz = crop max in uvw [0,1]
  slices: vec4<f32>,         // xyz = slice positions in uvw [0,1], w = packed flags
  liquid: vec4<f32>,         // x = ior, y = roughness, z = envIntensity, w = absorptionScale
  composite: vec4<f32>,      // x = alphaComposite, y = linear-HDR, z = ERT threshold, w = deferLighting
  lightCtl0: vec4<f32>,      // x = numLights, y = masterAmbient, z = specStrength, w = roughness
  lightCtl1: vec4<f32>,      // x = shadowEnable, y = shadowSteps, z = shadowStrength, w = shadowSoftness
  lightCtl2: vec4<f32>,      // x = aoEnable, y = aoRadius (uvw frac), z = aoIntensity, w = aoSamples
  measurePlane: vec4<f32>,   // x = enable, y = depth (world, along view axis), z = gray, w = alpha
  measureFwd: vec4<f32>,     // xyz = camera forward (world, unit); marks the measure plane in depth
  // Item 9 stage 9a: up to 4 simultaneously-resident ROI brick slots (was a single brickMin/brickMax
  // vec4 pair). Only slot 0 is ever populated by the CPU side today — slots 1-3 are always disabled,
  // so this is byte-for-byte the old single-brick model in degenerate form.
  brickWorldMin: array<vec4<f32>, 4>, // per-slot world min, w = enable (1 = composite this slot)
  brickWorldMax: array<vec4<f32>, 4>, // per-slot world max, w = blend fade weight [0,1]
  accelOcc: vec4<f32>,       // xyz = occupancy macrocell grid, w unused
  visGrid: vec4<f32>,        // xyz = vis-bin grid, w = visEnable (1 = accumulate)
  screen: vec4<f32>,         // xy = internal pixels, z = tile size
  worldToLight: mat4x4<f32>, // world → light-space UVW for the opacity shadow map (Milestone 7.1)
  shadowCtl: vec4<f32>,      // x = shadowMapEnable (1 = sample the map instead of marching a shadow ray)
  camRight: vec4<f32>,       // xyz = camera right axis (world, unit), w = tan(halfFovY) * aspect
  camUp: vec4<f32>,          // xyz = camera up axis (world, unit),    w = tan(halfFovY)
  mask0Ctl: vec4<f32>,       // x = mask0Enable, yzw = mask0 voxel dims (item 7 Phase B, slot 0)
  mask1Ctl: vec4<f32>,       // x = mask1Enable, yzw = mask1 voxel dims (item 7 Phase B, slot 1)
  skipCtl: vec4<f32>,        // x = lowDensitySkipThreshold (Phase 1e hardening), yzw unused
};

struct OccCell { dmin: f32, dmax: f32, dist: f32, occupied: f32 }
struct TileInst { packedXY: u32, tMin: f32, tMax: f32, pad: f32 }

// slices.w bits: 1=xEn, 2=yEn, 4=zEn, 8=showPlanes, 16/32 = viewMode (0 vol, 1 x, 2 y, 3 z) in bits 4-5

${LIGHT_STRUCT_WGSL}

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var volumeTex: texture_3d<f32>;
@group(0) @binding(2) var volumeSampler: sampler;
@group(0) @binding(3) var tfTex: texture_2d<f32>;
@group(0) @binding(4) var tfSampler: sampler;
@group(0) @binding(5) var<storage, read> lights: array<Light>;
@group(0) @binding(6) var brickTex: texture_3d<f32>;
@group(0) @binding(7) var<storage, read_write> visBins: array<atomic<u32>>;
@group(0) @binding(8) var<storage, read> occCells: array<OccCell>;
@group(0) @binding(9) var<storage, read> tfPrefix: array<u32>;
@group(0) @binding(10) var<storage, read> tileInsts: array<TileInst>;
// Cumulative extinction LUT for pre-integration (Milestone 3.1/3.2): tPreint(d, sigma) = the TF alpha
// curve blurred by sigma then integrated 0..d. x = density, y = sigma bucket (both bilinearly filtered
// by hardware) - sigma comes from the density pyramid's local variance at the ray's LOD (see
// sampleVariance/sigmaLod below). A 1x1 dummy is bound when PRE_INTEGRATE is off.
@group(0) @binding(11) var tPreint: texture_2d<f32>;
// Light-space opacity shadow map (Milestone 7.1): .r = optical depth τ from the light to each point.
@group(0) @binding(12) var shadowTex: texture_3d<f32>;
// Density mip pyramid (Milestone 3.2): rg = (mean, meanSq) per mip level, sampled via textureLoad at
// an explicit level (nearest, no interpolation between levels) chosen from the ray's step footprint.
@group(0) @binding(13) var densityPyramid: texture_3d<f32>;
// Mask/annotation layers (item 7 Phase B): two independent slots, both assumed same-grid as the
// primary (uvw needs no remapping). All four textures are read via textureLoad only - class ids must
// never be interpolated, so none of them use a sampler. Bindings 14..${MASK_BINDING_BASE - 1} (the
// shelved multi-volume-layer slots + TF atlas) are declared nowhere in this shader; WebGPU doesn't
// require every bind-group-layout entry to be referenced.
@group(0) @binding(${MASK_BINDING_BASE}) var mask0Tex: texture_3d<u32>;
@group(0) @binding(${MASK_BINDING_BASE + 1}) var mask0PaletteTex: texture_2d<f32>;
@group(0) @binding(${MASK_BINDING_BASE + 2}) var mask1Tex: texture_3d<u32>;
@group(0) @binding(${MASK_BINDING_BASE + 3}) var mask1PaletteTex: texture_2d<f32>;

struct VSOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
  var out: VSOut;
  if (TILE_INSTANCED == 0u) {
    var positions = array<vec2<f32>, 3>(
      vec2<f32>(-1.0, -1.0),
      vec2<f32>(3.0, -1.0),
      vec2<f32>(-1.0, 3.0),
    );
    let p = positions[vi];
    out.clip = vec4<f32>(p, 0.0, 1.0);
    out.uv = p * 0.5 + 0.5;
    return out;
  }
  let tile = tileInsts[ii];
  let tx = tile.packedXY & 0xffffu;
  let ty = tile.packedXY >> 16u;
  var local = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
    vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0),
  );
  let tilePx = max(frame.screen.z, 1.0);
  let w = max(frame.screen.x, 1.0);
  let h = max(frame.screen.y, 1.0);
  let px = (f32(tx) + local[vi].x) * tilePx;
  let py = (f32(ty) + local[vi].y) * tilePx;
  let ndc = vec2<f32>(px / w * 2.0 - 1.0, 1.0 - py / h * 2.0);
  out.clip = vec4<f32>(ndc, 0.0, 1.0);
  out.uv = ndc * 0.5 + 0.5;
  return out;
}

fn intersectAabb(ro: vec3<f32>, rd: vec3<f32>, bmin: vec3<f32>, bmax: vec3<f32>) -> vec2<f32> {
  let inv = 1.0 / rd;
  let t0 = (bmin - ro) * inv;
  let t1 = (bmax - ro) * inv;
  let tmin = min(t0, t1);
  let tmax = max(t0, t1);
  let tNear = max(max(tmin.x, tmin.y), tmin.z);
  let tFar = min(min(tmax.x, tmax.y), tmax.z);
  return vec2<f32>(tNear, tFar);
}

fn ign(p: vec2<f32>) -> f32 {
  return fract(52.9829189 * fract(dot(p, vec2<f32>(0.06711056, 0.00583715))));
}

// Item 9 stage 9a: which (if any) of the 4 brick slots' world AABB contains this point - same test
// sampleDensity/brickResolved themselves need, extracted once so both share it. Returns 4u for "none".
// First-match-wins by slot order (slots shouldn't normally overlap under a well-behaved policy, but
// this makes overlap well-defined rather than undefined behavior).
fn resolveBrickSlot(uvw: vec3<f32>) -> u32 {
  let halfExt = max(frame.boxHalf.xyz, vec3<f32>(1e-6));
  let p = uvw * (2.0 * halfExt) - halfExt;
  for (var i = 0u; i < 4u; i = i + 1u) {
    let bmin = frame.brickWorldMin[i];
    if (bmin.w < 0.5) { continue; } // slot disabled
    let bmax = frame.brickWorldMax[i];
    let bUvw = (p - bmin.xyz) / max(bmax.xyz - bmin.xyz, vec3<f32>(1e-6));
    if (any(bUvw < vec3<f32>(0.0)) || any(bUvw > vec3<f32>(1.0))) { continue; }
    return i;
  }
  return 4u;
}

fn sampleDensity(uvw: vec3<f32>) -> f32 {
  let coarse = textureSampleLevel(volumeTex, volumeSampler, uvw, 0.0).r;
  let slot = resolveBrickSlot(uvw);
  if (slot >= 4u) { return coarse; } // no resident brick covers this point
  // Map the world point (uvw is over the full coarse box) into this slot's [0,1]^3.
  let halfExt = max(frame.boxHalf.xyz, vec3<f32>(1e-6));
  let p = uvw * (2.0 * halfExt) - halfExt;
  let bmin = frame.brickWorldMin[slot];
  let bmax = frame.brickWorldMax[slot];
  let bUvw = (p - bmin.xyz) / max(bmax.xyz - bmin.xyz, vec3<f32>(1e-6));
  let fine = textureSampleLevel(brickTex, volumeSampler, bUvw, 0.0).r;
  // Overlay only: never punch holes in the coarse volume (empty / noisy L0 voxels) and never fill
  // empty space with fine-level reconstruction noise (that fogged out the sample when the brick
  // spanned a large Z fraction of a tomography pancake). Sharpen where coarse already has signal.
  let e = min(min(min(bUvw.x, 1.0 - bUvw.x), min(bUvw.y, 1.0 - bUvw.y)), min(bUvw.z, 1.0 - bUvw.z));
  let w = clamp(bmax.w, 0.0, 1.0) * smoothstep(0.0, 0.06, e) * smoothstep(0.02, 0.08, coarse);
  return mix(coarse, max(coarse, fine), w);
}

fn sampleTf(density: f32) -> vec4<f32> {
  return textureSampleLevel(tfTex, tfSampler, vec2<f32>(density, 0.5), 0.0);
}

// Mask/annotation layers (item 7 Phase B): uvw is over the primary's own box (same grid, no separate
// remapping - see Frame.mask0Ctl/mask1Ctl's doc comments). Nearest-voxel lookup via textureLoad (never
// interpolated - a blended class id would be meaningless), then a palette lookup by class id (also
// textureLoad, so the palette is never filtered either). Returns straight (non-premultiplied) RGBA.
// Two near-identical functions (one per slot) rather than a texture-valued parameter - WGSL textures
// are module-scope resource bindings, not first-class values that can be passed into a function.
fn sampleMask0(uvw: vec3<f32>) -> vec4<f32> {
  let dims = max(frame.mask0Ctl.yzw, vec3<f32>(1.0));
  let voxel = clamp(vec3<i32>(uvw * dims), vec3<i32>(0), vec3<i32>(dims) - vec3<i32>(1));
  let classId = i32(textureLoad(mask0Tex, voxel, 0).r);
  return textureLoad(mask0PaletteTex, vec2<i32>(classId, 0), 0);
}

fn sampleMask1(uvw: vec3<f32>) -> vec4<f32> {
  let dims = max(frame.mask1Ctl.yzw, vec3<f32>(1.0));
  let voxel = clamp(vec3<i32>(uvw * dims), vec3<i32>(0), vec3<i32>(dims) - vec3<i32>(1));
  let classId = i32(textureLoad(mask1Tex, voxel, 0).r);
  return textureLoad(mask1PaletteTex, vec2<i32>(classId, 0), 0);
}

// Milestone 3.2: local density variance from the mip pyramid's (mean, meanSq) moments at an explicit
// LOD, clamped >=0 to guard the mean^2~meanSq cancellation case. "level" is a nearest-level pick, not
// trilinear-blended between levels - the pyramid's own downsample step already box-filters each level.
fn sampleVariance(uvw: vec3<f32>, lod: f32) -> f32 {
  let maxLevel = i32(textureNumLevels(densityPyramid)) - 1;
  let level = clamp(i32(round(lod)), 0, max(maxLevel, 0));
  let levelU = u32(level);
  let dims = max(vec3<i32>(textureDimensions(densityPyramid, levelU)), vec3<i32>(1));
  let coord = clamp(vec3<i32>(uvw * vec3<f32>(dims)), vec3<i32>(0), dims - vec3<i32>(1));
  let s = textureLoad(densityPyramid, coord, levelU);
  return max(0.0, s.g - s.r * s.r);
}

// Bilinearly-interpolated cumulative extinction T(density, sigma) from the Gaussian-extended
// pre-integration LUT (Milestone 3.2 extends Milestone 3.1's 1D table to a 2nd axis blurred by the
// local density-variance-derived sigma from the mip pyramid).
fn preintT(d: f32, sigma: f32) -> f32 {
  let v = clamp(sigma / SIGMA_MAX, 0.0, 1.0);
  return textureSampleLevel(tPreint, tfSampler, vec2<f32>(clamp(d, 0.0, 1.0), v), 0.0).r;
}

// Milestone 3.1/3.2: segment-average TF alpha over the density interval [sf, sb] (front→back samples),
// assuming density varies linearly across the step. The ratio form is the exact average extinction;
// near-equal endpoints (|sb-sf| < eps) fall back to the midpoint value (2nd-order, no discontinuity at
// the boundary). This replaces the point-sampled endpoint alpha in the composite, so long majorant
// steps integrate the transfer function instead of skipping over thin spikes between samples.
fn preintAvgAlpha(sf: f32, sb: f32, sigma: f32) -> f32 {
  let n = textureDimensions(tPreint).x;
  let eps = 3.0 / f32(max(n, 2u));
  if (abs(sb - sf) < eps) {
    return sampleTf((sf + sb) * 0.5).a; // limit form (midpoint)
  }
  return (preintT(sb, sigma) - preintT(sf, sigma)) / (sb - sf); // ratio form (exact average)
}

fn occIndex(c: vec3<i32>) -> u32 {
  let g = vec3<i32>(max(frame.accelOcc.xyz, vec3<f32>(1.0)));
  let cc = clamp(c, vec3<i32>(0), g - vec3<i32>(1));
  return u32(cc.x + cc.y * g.x + cc.z * g.x * g.y);
}

fn uvwToCell(uvw: vec3<f32>) -> vec3<i32> {
  let g = max(frame.accelOcc.xyz, vec3<f32>(1.0));
  return vec3<i32>(clamp(floor(uvw * g), vec3<f32>(0.0), g - vec3<f32>(1.0)));
}

fn majorantStep(cellMaxDensity: f32, densityScale: f32) -> f32 {
  let cellMaxSigma = max(cellMaxDensity, 0.0) * densityScale * 12.0;
  return -log(1.0 - TARGET_SEGMENT_OPACITY) / max(cellMaxSigma, 1e-4);
}

fn visAccumulate(uvw: vec3<f32>, weight: f32) {
  if (frame.visGrid.w < 0.5) { return; }
  let g = max(frame.visGrid.xyz, vec3<f32>(1.0));
  let c = vec3<u32>(clamp(floor(uvw * g), vec3<f32>(0.0), g - vec3<f32>(1.0)));
  let idx = c.x + c.y * u32(g.x) + c.z * u32(g.x) * u32(g.y);
  // Fixed-point weight (WGSL has no float atomics). A bounded, saturating atomicAdd -- NOT a
  // compareExchange spin-loop: under the per-sample contention of a full-screen march the CAS retry
  // loop serializes across millions of fragments and hangs the GPU (device-lost / tab crash). q is
  // clamped to 16 bits and the buffer is cleared every readback cycle, so the u32 accumulator cannot
  // overflow (2^32 / 65535 additions per bin per cycle is unreachable).
  let q = u32(clamp(weight * VIS_SCALE, 0.0, 65535.0));
  if (q == 0u) { return; }
  atomicAdd(&visBins[idx], q);
}

// True (cheap, no texture fetch) when sampleDensity(uvw) at this point would resolve through the
// fine ROI brick instead of the coarse volume - same AABB test sampleDensity itself runs, without
// the actual texture load.
fn brickResolved(uvw: vec3<f32>) -> bool {
  return resolveBrickSlot(uvw) < 4u;
}

// Phase 2b hardening: the old fixed 0.75/textureDimensions(volumeTex) step (a) always used the
// coarse texture's resolution even when this point actually resolves through the finer ROI brick
// (aliased/over-blurred gradient right where the brick is supposed to add detail), and (b) took equal
// steps per axis in raw voxel-count fraction, which is only equal in physical distance for isotropic
// spacing - anisotropic voxel spacing (common in tomography, e.g. a coarser Z pitch) skewed gradient
// direction/magnitude toward the finer-spaced axes.
//
// Fix: pick whichever texture this point actually resolves through (coarse vs. brick) for the step's
// resolution, then size the per-axis step so it covers the same physical distance on every axis (the
// finest axis's own voxel spacing, so resolution is never coarsened below what the old formula
// already sampled at). For an isotropic volume (equal spacing/dims per axis) this reduces to exactly
// the old 0.75/dims - no default-behavior change for the common case; anisotropic-spacing datasets
// get a correctly-shaped gradient instead of a skewed one.
fn densityGradient(uvw: vec3<f32>) -> vec3<f32> {
  let coarseExtent = 2.0 * max(frame.boxHalf.xyz, vec3<f32>(1e-6));
  var texDims: vec3<f32>;
  var worldExtent: vec3<f32>;
  let slot = resolveBrickSlot(uvw);
  if (slot < 4u) {
    texDims = vec3<f32>(textureDimensions(brickTex));
    worldExtent = max(frame.brickWorldMax[slot].xyz - frame.brickWorldMin[slot].xyz, vec3<f32>(1e-6));
  } else {
    texDims = vec3<f32>(textureDimensions(volumeTex));
    worldExtent = coarseExtent;
  }
  let voxelWorld = worldExtent / max(texDims, vec3<f32>(1.0));
  let h = min(min(voxelWorld.x, voxelWorld.y), voxelWorld.z) * 0.75;
  let e = vec3<f32>(h) / coarseExtent; // back into the coarse-box uvw units sampleDensity expects
  let dx = sampleDensity(uvw + vec3<f32>(e.x, 0.0, 0.0)) - sampleDensity(uvw - vec3<f32>(e.x, 0.0, 0.0));
  let dy = sampleDensity(uvw + vec3<f32>(0.0, e.y, 0.0)) - sampleDensity(uvw - vec3<f32>(0.0, e.y, 0.0));
  let dz = sampleDensity(uvw + vec3<f32>(0.0, 0.0, e.z)) - sampleDensity(uvw - vec3<f32>(0.0, 0.0, e.z));
  return vec3<f32>(dx, dy, dz);
}

fn fresnelSchlick(cosTheta: f32, f0: vec3<f32>) -> vec3<f32> {
  let m = clamp(1.0 - cosTheta, 0.0, 1.0);
  let m2 = m * m;
  return f0 + (vec3<f32>(1.0) - f0) * (m2 * m2 * m);
}

fn refractDir(i: vec3<f32>, n: vec3<f32>, eta: f32) -> vec3<f32> {
  let cosI = clamp(-dot(i, n), -1.0, 1.0);
  let sin2T = eta * eta * (1.0 - cosI * cosI);
  if (sin2T > 1.0) {
    return reflect(i, n);
  }
  let cosT = sqrt(1.0 - sin2T);
  return eta * i + (eta * cosI - cosT) * n;
}

fn envRadiance(dir: vec3<f32>) -> vec3<f32> {
  let d = normalize(dir);
  let hemi = d.y * 0.5 + 0.5;
  let lKey = normalize(frame.light.xyz);
  let sun = frame.shade.xyz * (0.4 + 1.6 * pow(max(dot(d, lKey), 0.0), 28.0));
  let amb = vec3<f32>(frame.light.w);
  let sky = amb * 2.4 + sun + vec3<f32>(0.08, 0.12, 0.22) * hemi;
  let ground = amb * 0.25 + vec3<f32>(0.05, 0.045, 0.04);
  return mix(ground, sky, hemi) * max(frame.liquid.z, 0.2);
}

${VOLUME_LIGHTING_SHARED_WGSL}

// Milestone 6 (B3): unlit is the same shading minus the shadow/AO/multi-scatter diffuseSpec term -
// feeds the colorUnlit G-buffer target. lit is byte-identical to what shadeSample returned before
// this struct existed.
struct ShadeResult {
  lit: vec3<f32>,
  unlit: vec3<f32>,
}

fn shadeSample(
  base: vec3<f32>,
  grad: vec3<f32>,
  viewDir: vec3<f32>,
  pWorld: vec3<f32>,
  density: f32,
  lighting: f32,
  densityScale: f32,
  seed: f32,
  heavy: bool,
) -> ShadeResult {
  let gLen = length(grad);
  var n = vec3<f32>(0.0, 1.0, 0.0);
  if (gLen > 1e-5) {
    n = normalize(grad);
    if (dot(n, viewDir) < 0.0) { n = -n; }
  }

  let numLights = i32(frame.lightCtl0.x);
  let masterAmbient = frame.lightCtl0.y;
  let specStrength = frame.lightCtl0.z;
  // roughness (0 = mirror-sharp) → Blinn-Phong exponent.
  let shininess = mix(256.0, 8.0, clamp(frame.lightCtl0.w, 0.0, 1.0));
  let shadowOn = frame.lightCtl1.x > 0.5;
  let aoOn = frame.lightCtl2.x > 0.5;

  let lightRes = evaluateLighting(
    base, n, viewDir, pWorld, density, densityScale, seed, heavy,
    numLights, specStrength, shininess, aoOn, shadowOn,
  );
  var ambientTerm = base * masterAmbient * (1.0 - lightRes.ao);
  if (BENT_NORMAL_AMBIENT != 0u) {
    // Milestone 7.2: directional (bent-normal) ambient. Instead of a flat grey ambient, sample the
    // studio environment along the surface normal (the unoccluded-direction proxy) with (1-ao) as the
    // cone aperture. Blended near unity so it re-tints/varies ambient without changing overall exposure.
    let irr = envRadiance(n);
    ambientTerm = base * masterAmbient * (1.0 - lightRes.ao) * mix(vec3<f32>(1.0), irr, 0.85);
  }
  let diffuseSpec = lightRes.diffuseSpec;

  let rim = base * pow(1.0 - max(dot(n, viewDir), 0.0), 3.0) * 0.25;
  let litFull = ambientTerm + diffuseSpec + rim;
  // Milestone 6 (B3): the "unlit" G-buffer channel is the same blend but WITHOUT the shadow/AO/
  // multi-scatter-weighted diffuseSpec term - i.e. what shadeSample would return if evaluateLighting
  // contributed nothing. Same edge/lighting-strength blend so the two stay visually comparable.
  let litUnlitOnly = ambientTerm + rim;
  let edge = smoothstep(0.02, 0.35, gLen);
  let blendFactor = clamp(0.35 + edge * 0.65, 0.0, 1.0);
  let shadedFull = mix(base * masterAmbient, litFull, blendFactor);
  let shadedUnlitOnly = mix(base * masterAmbient, litUnlitOnly, blendFactor);
  let lightingFactor = clamp(lighting, 0.0, 1.0);
  return ShadeResult(
    mix(base, shadedFull, lightingFactor),
    mix(base, shadedUnlitOnly, lightingFactor),
  );
}

/** Dielectric liquid: TF RGB = absorption tint; gradient drives free-surface Fresnel. */
fn shadeDielectric(
  tint: vec3<f32>,
  opacity: f32,
  grad: vec3<f32>,
  viewDir: vec3<f32>,
  rd: vec3<f32>,
  density: f32,
) -> vec3<f32> {
  let gLen = length(grad);
  var n = vec3<f32>(0.0, 1.0, 0.0);
  if (gLen > 1e-5) {
    n = normalize(grad);
    if (dot(n, viewDir) < 0.0) { n = -n; }
  }

  let ior = max(frame.liquid.x, 1.0001);
  let roughness = clamp(frame.liquid.y, 0.012, 1.0);
  let absorbScale = max(frame.liquid.w, 0.1);
  let f0d = pow((ior - 1.0) / (ior + 1.0), 2.0);
  let f0 = vec3<f32>(f0d);
  let nDotV = max(dot(n, viewDir), 0.0);
  let F = fresnelSchlick(nDotV, f0);
  let fAmt = clamp(max(max(F.r, F.g), F.b), 0.0, 1.0);

  let incident = rd;
  let eta = 1.0 / ior;
  let refrR = refractDir(incident, n, 1.0 / (ior * 0.985));
  let refrG = refractDir(incident, n, eta);
  let refrB = refractDir(incident, n, 1.0 / (ior * 1.015));
  let reflDir = reflect(incident, n);

  var transmitted = vec3<f32>(
    envRadiance(normalize(mix(refrR, -n, 0.06))).r,
    envRadiance(normalize(mix(refrG, -n, 0.06))).g,
    envRadiance(normalize(mix(refrB, -n, 0.06))).b,
  );

  // Beer–Lambert: denser / more opaque TF → stronger absorption of cool/warm tint.
  let sigma = (vec3<f32>(1.0) - tint) * (0.35 + opacity * 2.2) * absorbScale * (0.55 + density);
  let path = mix(0.35, 1.8, 1.0 - nDotV);
  let absorb = exp(-sigma * path);
  transmitted *= absorb * mix(vec3<f32>(1.0), tint, 0.55);

  let envSpec = envRadiance(reflDir) * F * (0.7 + (1.0 - roughness) * 0.9);

  // Steam / foam (low–mid density): more isotropic scatter, less glass.
  let steam = 1.0 - smoothstep(0.18, 0.58, density);
  let scatter = tint * envRadiance(n) * (0.35 + opacity * 0.5);

  let L = normalize(frame.light.xyz);
  let H = normalize(L + viewDir);
  let sharp = pow(max(dot(n, H), 0.0), mix(96.0, 2048.0, 1.0 - roughness));
  let keySpec = frame.shade.xyz * f0 * sharp * (0.45 + f0d * 2.5) * (1.0 - steam * 0.85);

  let surfaceW = smoothstep(0.02, 0.28, gLen);
  var lit = mix(transmitted, envSpec + transmitted * (1.0 - fAmt), fAmt);
  lit = mix(lit, scatter, steam * 0.75);
  lit += keySpec * surfaceW;
  // Homogeneous interior: deep Beer tint, less mirror.
  let interior = tint * absorb * (0.15 + frame.light.w * 0.8) * envRadiance(viewDir);
  lit = mix(interior, lit, clamp(0.25 + surfaceW * 0.75 + steam * 0.2, 0.0, 1.0));
  return lit;
}

fn tonemapACES(x: vec3<f32>) -> vec3<f32> {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn background(rd: vec3<f32>) -> vec3<f32> {
  // Studio hemi matching forward glass env (brighter than old medical void).
  return envRadiance(rd) * 0.85;
}

fn inCrop(uvw: vec3<f32>) -> bool {
  let mn = frame.cropMin.xyz;
  let mx = frame.cropMax.xyz;
  return all(uvw >= mn) && all(uvw <= mx);
}

fn planeHighlight(uvw: vec3<f32>, flags: u32, thickness: f32) -> f32 {
  var h = 0.0;
  if ((flags & 1u) != 0u) {
    h = max(h, 1.0 - smoothstep(0.0, thickness, abs(uvw.x - frame.slices.x)));
  }
  if ((flags & 2u) != 0u) {
    h = max(h, 1.0 - smoothstep(0.0, thickness, abs(uvw.y - frame.slices.y)));
  }
  if ((flags & 4u) != 0u) {
    h = max(h, 1.0 - smoothstep(0.0, thickness, abs(uvw.z - frame.slices.z)));
  }
  return h;
}

fn passesViewMode(uvw: vec3<f32>, viewMode: u32, thickness: f32) -> bool {
  if (viewMode == 0u) { return true; }
  if (viewMode == 1u) { return abs(uvw.x - frame.slices.x) <= thickness; }
  if (viewMode == 2u) { return abs(uvw.y - frame.slices.y) <= thickness; }
  if (viewMode == 3u) { return abs(uvw.z - frame.slices.z) <= thickness; }
  return true;
}

// Composites the volume into a colour and, via depthOut, the transmittance-weighted depth centroid
// (Milestone 5.1) normalized by the far plane — for TAAU reprojection. All early exits leave depthOut at
// the caller's default (1.0 = far); only the composited path writes a real centroid.
fn marchColor(
  in: VSOut,
  depthOut: ptr<function, f32>,
  colorUnlitOut: ptr<function, vec4<f32>>,
  surfacePosOut: ptr<function, vec4<f32>>,
  surfaceNormalOut: ptr<function, vec4<f32>>,
  surfaceAlbedoOut: ptr<function, vec4<f32>>,
) -> vec4<f32> {
  let ndc = vec2<f32>(in.uv.x * 2.0 - 1.0, (1.0 - in.uv.y) * 2.0 - 1.0);

  let ro = frame.eye.xyz;
  // Build the ray direction from the camera basis + FOV directly, NOT from invViewProj. Reconstructing
  // via invViewProj (differencing two reprojected world points, or dividing by a reprojected w) loses
  // most of its float32 precision when zoomed far out: near/far are both ~centerDepth and huge, so the
  // reprojected points nearly coincide and their difference / w-divide degenerate — the direction jitters
  // or even flips sign, and the volume vanishes or shows an inverted (back-face) image. The camera basis
  // (unit right/up/forward) and FOV are magnitude-independent, so the direction stays exact at any zoom.
  // frame.camRight.w = tan(halfFovY)*aspect, frame.camUp.w = tan(halfFovY). ndc.y is already the display-
  // flipped NDC (see vs_main), matching how the basis vectors are oriented.
  let forward = frame.measureFwd.xyz;
  let rd = normalize(
    forward + ndc.x * frame.camRight.w * frame.camRight.xyz + ndc.y * frame.camUp.w * frame.camUp.xyz,
  );
  let alphaComposite = frame.composite.x > 0.5;
  let bg = background(rd);

  // Measure plane: a fronto-parallel grey sheet at a fixed depth in front of the camera. t at which the
  // ray crosses it = depth / cos(angle to view axis). Composited in depth order so the volume in front
  // occludes it and it dims volume behind (a real depth cue), not a flat overlay.
  let measureOn = frame.measurePlane.x > 0.5;
  let planeGray = frame.measurePlane.z;
  let planeAlpha = clamp(frame.measurePlane.w, 0.0, 1.0);
  let cosR = dot(rd, frame.measureFwd.xyz);
  var planeT = -1.0;
  if (measureOn && planeAlpha > 0.0 && cosR > 1e-4) { planeT = frame.measurePlane.y / cosR; }

  let halfExt = max(frame.boxHalf.xyz, vec3<f32>(1e-6));
  let boxMin = -halfExt;
  let boxMax = halfExt;
  let hit = intersectAabb(ro, rd, boxMin, boxMax);
  if (hit.x > hit.y || hit.y < 0.0) {
    // No volume along this ray — still paint the measure plane where it sits in front of the camera.
    // Milestone 6 (B3): colorUnlitOut must mirror every value returned here (not just the "real hit"
    // path below), or the half-res lighting composite (which reads colorUnlit as its base) sees pure
    // transparent black wherever a ray misses the volume - the "black box around the volume" bug.
    if (planeT > 0.0) {
      if (alphaComposite) {
        let v = vec4<f32>(vec3<f32>(planeGray) * planeAlpha, planeAlpha);
        *colorUnlitOut = v;
        return v;
      }
      let comp = mix(bg, vec3<f32>(planeGray), planeAlpha);
      if (frame.composite.y >= 0.5) {
        let v = vec4<f32>(comp, 1.0);
        *colorUnlitOut = v;
        return v;
      }
      let outC = tonemapACES(comp);
      let v = vec4<f32>(pow(outC, vec3<f32>(0.95)), 1.0);
      *colorUnlitOut = v;
      return v;
    }
    if (alphaComposite) {
      let v = vec4<f32>(0.0, 0.0, 0.0, 0.0);
      *colorUnlitOut = v;
      return v;
    }
    if (frame.composite.y >= 0.5) { // linear HDR for post stack
      let v = vec4<f32>(bg, 1.0);
      *colorUnlitOut = v;
      return v;
    }
    let outBg = tonemapACES(bg);
    let v = vec4<f32>(pow(outBg, vec3<f32>(0.95)), 1.0);
    *colorUnlitOut = v;
    return v;
  }

  let stepSize = max(frame.params.x, 5e-4);
  let densityScale = frame.params.y;
  let maxSteps = i32(frame.params.z);
  let exposure = max(frame.params.w, 0.1);
  let blendMode = i32(frame.boxHalf.w + 0.5);
  let gradOpacity = frame.quality.x;
  let gradScale = max(frame.quality.y, 1e-4);
  let lighting = frame.quality.z;
  let dielectric = frame.quality.w > 0.5;
  let flags = u32(frame.slices.w);
  let viewMode = (flags >> 4u) & 3u;
  let showPlanes = (flags & 8u) != 0u;
  let slabT = select(0.045, 0.014, viewMode == 0u);

  let jitter = ign(in.clip.xy + vec2<f32>(frame.eye.w * 1.7, frame.eye.w * 0.37));
  var t = max(hit.x, 0.0) + jitter * stepSize;
  let tEnd = hit.y;
  let rdUvw = rd / (2.0 * halfExt);
  // Milestone 3.2: pick the density-pyramid mip level whose texel footprint best matches this ray's
  // step size in volume-texel units (classic LOD = log2(sample footprint in texels)). The composite
  // path's step is always the uniform baseline stepSize (occupancy/crop-skip branches continue
  // before reaching it - see below), so this is constant per-ray, not recomputed per-sample.
  let volDims = vec3<f32>(textureDimensions(volumeTex));
  let voxelUvw = 1.0 / max(min(min(volDims.x, volDims.y), volDims.z), 1.0);
  let stepUvwLen = length(stepSize * rdUvw);
  let sigmaLod = clamp(
    log2(max(stepUvwLen / voxelUvw, 1.0)),
    0.0,
    f32(max(i32(textureNumLevels(densityPyramid)) - 1, 0)),
  );

  var color = vec4<f32>(0.0);
  var mipVal = 0.0;
  var mipRgb = vec3<f32>(0.0);
  var minVal = 1.0;
  var minRgb = vec3<f32>(1.0);
  var avgRgb = vec3<f32>(0.0);
  var avgW = 0.0;
  let viewDir = -rd;
  // Only composite the plane in front-to-back composite mode; disabled for MIP/minIP/average.
  var planeDone = !(planeT > 0.0) || blendMode != 0;
  var prevDensity = 0.0; // previous sample's density, for the pre-integration segment (Milestone 3.1)
  var centroidNum = 0.0;    // Σ t·Δα  — transmittance-weighted depth centroid (Milestone 5.1)
  var centroidWeight = 0.0; // Σ Δα
  // Milestone 6 (B3) G-buffer accumulators: same Δα weighting as the depth centroid above, extended
  // to world position / normal / density. colorUnlit mirrors color's own alpha-under compositing.
  var colorUnlit = vec4<f32>(0.0);
  var surfacePosNum = vec3<f32>(0.0);    // Σ p·Δα
  var surfaceNormalNum = vec3<f32>(0.0); // Σ n·Δα
  var densityCentroidNum = 0.0;          // Σ density·Δα
  // TF-sampled albedo centroid - a half-res lighting pass needs the material color evaluateLighting
  // modulates by (diffuseSpec = base*ndotl + spec), which none of the other G-buffer channels carry.
  var surfaceAlbedoNum = vec3<f32>(0.0); // Σ base·Δα
  var i = 0;
  loop {
    if (i >= maxSteps || t > tEnd) { break; }
    let ert = select(0.995, frame.composite.z, frame.composite.z > 0.0);
    if (blendMode == 0 && color.a > ert) { break; }

    // Cross the measure plane in depth order: composite it before the sample once the ray reaches it.
    if (!planeDone && t >= planeT) {
      let om = 1.0 - color.a;
      color = vec4<f32>(color.rgb + om * planeAlpha * vec3<f32>(planeGray), color.a + om * planeAlpha);
      planeDone = true;
    }

    let p = ro + rd * t;
    let uvw = clamp((p + halfExt) / (2.0 * halfExt), vec3<f32>(0.0), vec3<f32>(1.0));

    let stepNow = stepSize;
    if (OCCUPANCY != 0u) {
      let cell = uvwToCell(uvw);
      let rec = occCells[occIndex(cell)];
      // Leap only cells well clear of material — at least OCC_LEAP_MIN macrocells from any active cell
      // (rec.dist is the L∞ distance in cells, 0 = active). Everything closer is marched at baseline
      // fidelity so the silhouette follows the actual density fade, not the blocky macrocell grid; a soft
      // semi-transparent boundary can accumulate visible material several cells beyond the per-macrocell
      // "active" classification, hence the wide margin. This is nearly free: the baseline density < 0.01
      // skip still fast-forwards through the empty voxels inside the margin — only the *deep* air is
      // leaped. The leap box of radius (dist - OCC_LEAP_MIN) stays in the provably-empty interior.
      let OCC_LEAP_MIN = 5.0;
      // item 7 Phase B: the occupancy grid is built from the PRIMARY's density only, so a leap has no
      // way to know whether either mask slot has content in the region it's about to jump over - an
      // annotation sitting in primary-empty space (the exact scenario a mask commonly targets) could be
      // skipped entirely. Building a real mask-aware occupancy structure is future work; for now,
      // correctness wins over the leap's speedup whenever EITHER mask slot is active - baseline
      // per-step marching (the branch below) always visits every uvw, so sampleMask0()/sampleMask1()
      // below never get skipped.
      if (rec.dist >= OCC_LEAP_MIN && frame.mask0Ctl.x < 0.5 && frame.mask1Ctl.x < 0.5) {
        let g = max(frame.accelOcc.xyz, vec3<f32>(1.0));
        let cs = 1.0 / g;
        let r = max(0.0, floor(rec.dist) - OCC_LEAP_MIN);
        let bmin = clamp((vec3<f32>(cell) - r) * cs, vec3<f32>(0.0), vec3<f32>(1.0));
        let bmax = clamp((vec3<f32>(cell) + r + 1.0) * cs, vec3<f32>(0.0), vec3<f32>(1.0));
        let skipHit = intersectAabb(uvw, rdUvw, bmin, bmax);
        // Nudge just past the exit face so the next sample lands in a fresh cell (no re-test).
        let jump = max(skipHit.y + 1e-4, stepSize);
        prevDensity = 0.0; // leaped empty space
        t += jump;
        i += 1;
        continue;
      }
      // Otherwise march at the baseline step — no majorant coarsening (it banded flat / crop faces); the
      // speed-up comes purely from leaping the empty interior above.
    }

    if (!inCrop(uvw)) {
      // Skip the cropped-away region by jumping straight to the crop-box entry, so coarse steps through it
      // don't alias into bands on the flat crop face. If the crop is behind / around us, fall back to a step.
      let cropHit = intersectAabb(uvw, rdUvw, frame.cropMin.xyz, frame.cropMax.xyz);
      prevDensity = 0.0;
      if (cropHit.x > 0.0 && cropHit.x < cropHit.y) {
        t += cropHit.x + 1e-4;
      } else {
        t += stepNow;
      }
      i += 1;
      continue;
    }
    if (!passesViewMode(uvw, viewMode, slabT * 2.5)) {
      prevDensity = 0.0;
      t += stepNow;
      i += 1;
      continue;
    }

    // Mask/annotation layers (item 7 Phase B): composited independently of the primary's own density -
    // an annotation must stay visible even where the primary is empty, which is exactly why this runs
    // here rather than after (or gated behind) the primary's density<0.01 skip-ahead below. Flat/unlit
    // only (no shadow/AO/extinction physics) in v1, using each palette's own alpha directly as each
    // step's blend weight - the same Δα-weighted "over" accumulation the primary uses, just without
    // converting a density into an extinction coefficient first (a mask has no density, only a label).
    // Composite-mode only: MIP/MinIP/average don't have a front-to-back accumulator to add this into.
    // Slot 0 composites first (bottom), slot 1 over it (top) - slot index IS the compositing order,
    // fixed and independent of anything UI-facing, same convention the (unrelated) shelved multi-
    // volume-layer feature documents for its own slots.
    if (blendMode == 0 && frame.mask0Ctl.x > 0.5) {
      let mask0 = sampleMask0(uvw);
      if (mask0.a > SHADE_ALPHA_EPS) {
        let om = 1.0 - color.a;
        color = vec4<f32>(color.rgb + om * mask0.rgb * mask0.a, color.a + om * mask0.a);
        colorUnlit = vec4<f32>(colorUnlit.rgb + om * mask0.rgb * mask0.a, colorUnlit.a + om * mask0.a);
      }
    }
    if (blendMode == 0 && frame.mask1Ctl.x > 0.5) {
      let mask1 = sampleMask1(uvw);
      if (mask1.a > SHADE_ALPHA_EPS) {
        let om = 1.0 - color.a;
        color = vec4<f32>(color.rgb + om * mask1.rgb * mask1.a, color.a + om * mask1.a);
        colorUnlit = vec4<f32>(colorUnlit.rgb + om * mask1.rgb * mask1.a, colorUnlit.a + om * mask1.a);
      }
    }

    let density = sampleDensity(uvw);
    // Phase 1e hardening: frame.skipCtl.x is min(0.01, the lowest density at which the current TF is
    // actually non-transparent) - computed CPU-side from the baked LUT (see VolumeRenderer's
    // setTransferFunction). A TF with nothing opaque below 0.01 behaves exactly as before; a TF with a
    // narrow opaque feature below 0.01 tightens the threshold so that feature is never skipped past.
    if (density < frame.skipCtl.x && blendMode == 0) {
      prevDensity = density;
      t += stepNow * 1.75;
      i += 1;
      continue;
    }

    // Ray-guided streaming signal (Milestone 1): transmittance-weighted hit on bins with actual
    // material. Placed after the empty-space/crop skips so empty bins never contribute (and never pay
    // an atomic) -- the goal is to fetch high-res detail where visible material is, not empty air.
    visAccumulate(uvw, 1.0 - color.a);

    var src = sampleTf(density);
    // Milestone 2: skip densityGradient + shading when TF-mapped alpha is already ~0.
    // Gradient opacity only *decreases* alpha, so a transparent TF window never needs the gradient.
    var grad = vec3<f32>(0.0);
    var gFactor = 1.0;
    if (src.a > SHADE_ALPHA_EPS) {
      grad = densityGradient(uvw);
      let gLen = length(grad);
      gFactor = mix(1.0, smoothstep(0.0, gradScale, gLen), clamp(gradOpacity, 0.0, 1.0));
      src.a = src.a * gFactor;
    }

    var planeH = 0.0;
    if (showPlanes && viewMode == 0u) {
      planeH = planeHighlight(uvw, flags, 0.008);
    }

    if (blendMode == 1) {
      if (density * src.a > mipVal) {
        mipVal = density * max(src.a, 0.05);
        mipRgb = src.rgb;
      }
    } else if (blendMode == 2) {
      if (density < minVal) {
        minVal = density;
        minRgb = src.rgb;
      }
    } else if (blendMode == 3) {
      let w = max(src.a, 0.05);
      avgRgb += src.rgb * w;
      avgW += w;
    } else {
      // Composite — dielectric liquids use deeper Beer + surface Fresnel.
      var sigmaMul = 12.0;
      if (dielectric) {
        sigmaMul = mix(18.0, 9.0, smoothstep(0.18, 0.55, density)); // steam thinner
      }
      var effAlpha = max(src.a, 0.0);
      if (PRE_INTEGRATE != 0u) {
        // Milestone 3.1: integrate the TF over the segment [prevDensity, density] instead of point-
        // sampling the endpoint alpha, so a long majorant step can't skip a thin TF spike between
        // samples. Modulated by the same gradient-opacity factor as the point path.
        // Milestone 3.2: blur the integration by the local density-variance-derived sigma (from the
        // mip pyramid at this ray's LOD), so a spike that aliases at a coarse sample spacing smears
        // across neighboring samples instead of flickering in/out as the camera zooms.
        let blurVariance = sampleVariance(uvw, sigmaLod);
        let blurSigma = sqrt(blurVariance);
        effAlpha = max(preintAvgAlpha(prevDensity, density, blurSigma) * gFactor, 0.0);
      }
      let sigma = effAlpha * densityScale * sigmaMul;
      var alpha = 1.0 - exp(-sigma * stepNow);
      alpha = max(alpha, planeH * 0.35);
      if (alpha > SHADE_ALPHA_EPS && effAlpha > SHADE_ALPHA_EPS) {
        // Gate the expensive shadow/AO rays to samples that still meaningfully affect the image:
        // in front of the volume (remaining transmittance high) and locally opaque enough to matter.
        // frame.composite.w (deferLighting) forces this off outright when a separate half-res
        // LightingPass is going to compute AO/shadow/multi-scatter for this frame instead - without
        // this, the inline march would pay the full heavy cost AND a second half-res computation would
        // redo it, making "deferred" lighting strictly more expensive than not deferring at all.
        let heavy = frame.composite.w < 0.5 && (1.0 - color.a) > 0.03 && alpha > 0.03;
        let sseed = fract(jitter + f32(i) * 0.61803399);
        var lit: vec3<f32>;
        var unlit: vec3<f32>;
        if (dielectric) {
          // Dielectric shading has no shadow/AO/multi-scatter gate at all (its own separate Fresnel/
          // env model) - there's nothing to strip out, so "unlit" is just the same result.
          lit = shadeDielectric(src.rgb, src.a, grad, viewDir, rd, density);
          unlit = lit;
        } else {
          let shadeRes = shadeSample(src.rgb, grad, viewDir, p, density, lighting, densityScale, sseed, heavy);
          lit = shadeRes.lit;
          unlit = shadeRes.unlit;
        }
        lit = mix(lit, vec3<f32>(0.95, 0.85, 0.35), planeH * 0.65);
        unlit = mix(unlit, vec3<f32>(0.95, 0.85, 0.35), planeH * 0.65);
        let a = clamp(alpha, 0.0, 1.0);
        let oneMinus = 1.0 - color.a;
        color = vec4<f32>(color.rgb + oneMinus * lit * a, color.a + oneMinus * a);
        colorUnlit = vec4<f32>(colorUnlit.rgb + oneMinus * unlit * a, colorUnlit.a + oneMinus * a);
        let dContrib = oneMinus * a; // this sample's opacity contribution
        centroidNum += t * dContrib;
        centroidWeight += dContrib;
        // Milestone 6 (B3): world-position / normal / density centroids, same Δα weighting as above.
        var n = vec3<f32>(0.0, 1.0, 0.0);
        let gLenN = length(grad);
        if (gLenN > 1e-5) {
          n = normalize(grad);
          if (dot(n, viewDir) < 0.0) { n = -n; }
        }
        surfacePosNum += p * dContrib;
        surfaceNormalNum += n * dContrib;
        densityCentroidNum += density * dContrib;
        surfaceAlbedoNum += src.rgb * dContrib;
      }
    }

    prevDensity = density;
    t += stepNow;
    i += 1;
  }

  // Plane sits behind all volume samples (or the ray left the box before reaching it): composite last.
  if (!planeDone) {
    let om = 1.0 - color.a;
    color = vec4<f32>(color.rgb + om * planeAlpha * vec3<f32>(planeGray), color.a + om * planeAlpha);
  }

  var outRgb: vec3<f32>;
  var outA: f32 = 1.0;
  if (blendMode == 1) {
    let a = smoothstep(0.0, 0.15, mipVal);
    outRgb = mipRgb * exposure * smoothstep(0.0, 0.2, mipVal);
    if (alphaComposite) {
      outA = a;
      outRgb = outRgb; // over cleared scene; no bg fill
    } else {
      outRgb = outRgb + bg * (1.0 - a);
    }
  } else if (blendMode == 2) {
    let a = 1.0 - minVal;
    outRgb = minRgb * exposure * a;
    if (alphaComposite) { outA = a; } else { outRgb = outRgb + bg * (1.0 - a); }
  } else if (blendMode == 3) {
    if (avgW > 0.0) {
      outRgb = (avgRgb / avgW) * exposure;
      outA = select(1.0, clamp(avgW * 0.1, 0.0, 1.0), alphaComposite);
    } else if (alphaComposite) {
      // Milestone 6 (B3): mirror to colorUnlitOut - same reasoning as the "ray misses box" early
      // returns above, this early return would otherwise leave colorUnlitOut at its black default.
      *colorUnlitOut = vec4<f32>(0.0, 0.0, 0.0, 0.0);
      return vec4<f32>(0.0, 0.0, 0.0, 0.0);
    } else {
      outRgb = bg;
    }
  } else {
    outRgb = color.rgb * exposure;
    if (alphaComposite) {
      outA = color.a;
      if (outA < 1e-4) {
        // Milestone 6 (B3): mirror to colorUnlitOut - see the other alphaComposite early returns above.
        *colorUnlitOut = vec4<f32>(0.0, 0.0, 0.0, 0.0);
        return vec4<f32>(0.0, 0.0, 0.0, 0.0);
      }
    } else {
      outRgb = outRgb + (1.0 - color.a) * bg;
      outA = 1.0;
    }
  }

  // Milestone 6 (B3) colorUnlit output, computed the same way as outRgb/outA above but from
  // colorUnlit instead of color. MIP/MinIP/average never call shadeSample/evaluateLighting at
  // all (no heavy-lighting term to strip), so "unlit" is just the same result as outRgb there.
  var outRgbUnlit = outRgb;
  var outAUnlit = outA;
  if (blendMode == 0) {
    outRgbUnlit = colorUnlit.rgb * exposure;
    if (alphaComposite) {
      outAUnlit = colorUnlit.a;
    } else {
      outRgbUnlit = outRgbUnlit + (1.0 - colorUnlit.a) * bg;
      outAUnlit = 1.0;
    }
  }

  // composite.y >= 0.5 → emit linear HDR (a post stack tonemaps); else tonemap in-shader.
  if (frame.composite.y < 0.5) {
    outRgb = tonemapACES(outRgb);
    outRgb = pow(outRgb, vec3<f32>(0.95));
    outRgbUnlit = tonemapACES(outRgbUnlit);
    outRgbUnlit = pow(outRgbUnlit, vec3<f32>(0.95));
  }
  *colorUnlitOut = vec4<f32>(outRgbUnlit, outAUnlit);

  // Milestone 6 (B3) world-position / normal / density centroids - same Δα-weighted average as the
  // depth centroid below. Left at the caller's defaults when no sample contributed (weight ~0).
  if (centroidWeight > 1e-5) {
    let posWeight = max(centroidWeight, 1e-6);
    *surfacePosOut = vec4<f32>(surfacePosNum / posWeight, centroidWeight);
    let nLen = length(surfaceNormalNum);
    let nAvg = select(vec3<f32>(0.0, 1.0, 0.0), normalize(surfaceNormalNum), nLen > 1e-6);
    *surfaceNormalOut = vec4<f32>(nAvg, densityCentroidNum / posWeight);
    *surfaceAlbedoOut = vec4<f32>(surfaceAlbedoNum / posWeight, 0.0);
  }

  // Depth centroid (world distance along the ray) normalized by the far plane, for TAAU reprojection.
  let far = max(frame.shadowCtl.y, 1e-6);
  let centroidT = select(hit.x, centroidNum / max(centroidWeight, 1e-6), centroidWeight > 1e-5);
  *depthOut = clamp(centroidT / far, 0.0, 1.0);
  return vec4<f32>(outRgb, outA);
}

// MRT entry point: colour to location 0, depth centroid (.r) to location 1. Splitting marchColor out
// keeps its many early returns untouched; the depth defaults to 1.0 (far) for every early exit.
// Locations 2-4 (Milestone 6 / B3): colorUnlit / surfacePos / surfaceNormal G-buffer targets for a
// future half-res lighting pass - real accumulation, not yet consumed by anything downstream.
struct FragOut {
  @location(0) color: vec4<f32>,
  @location(1) depth: vec4<f32>,
  @location(2) colorUnlit: vec4<f32>,
  @location(3) surfacePos: vec4<f32>,
  @location(4) surfaceNormal: vec4<f32>,
  @location(5) surfaceAlbedo: vec4<f32>,
};

@fragment
fn fs_main(in: VSOut) -> FragOut {
  var depth = 1.0;
  var colorUnlit = vec4<f32>(0.0);
  var surfacePos = vec4<f32>(0.0);
  var surfaceNormal = vec4<f32>(0.0, 1.0, 0.0, 0.0);
  var surfaceAlbedo = vec4<f32>(0.0);
  let color = marchColor(in, &depth, &colorUnlit, &surfacePos, &surfaceNormal, &surfaceAlbedo);
  return FragOut(color, vec4<f32>(depth, 0.0, 0.0, 0.0), colorUnlit, surfacePos, surfaceNormal, surfaceAlbedo);
}
`;
}

/** Baseline (unaccelerated) WGSL, matching {@link volumeRaymarchWgsl} with occupancy/tiles off. */
export const VOLUME_RAYMARCH_WGSL = volumeRaymarchWgsl();

/**
 * Fullscreen background pass used when instanced tiles don't cover every pixel. The Frame struct must
 * byte-match {@link volumeRaymarchWgsl}'s (up through camRight/camUp) since both bind the same uniform
 * buffer — unused trailing fields are declared anyway so the offsets of camRight/camUp line up.
 */
export const VOLUME_BACKGROUND_WGSL = /* wgsl */ `
struct Frame {
  invViewProj: mat4x4<f32>,
  eye: vec4<f32>,
  params: vec4<f32>,
  light: vec4<f32>,
  shade: vec4<f32>,
  boxHalf: vec4<f32>,
  quality: vec4<f32>,
  cropMin: vec4<f32>,
  cropMax: vec4<f32>,
  slices: vec4<f32>,
  liquid: vec4<f32>,
  composite: vec4<f32>,
  lightCtl0: vec4<f32>,
  lightCtl1: vec4<f32>,
  lightCtl2: vec4<f32>,
  measurePlane: vec4<f32>,
  measureFwd: vec4<f32>,
  brickWorldMin: array<vec4<f32>, 4>,
  brickWorldMax: array<vec4<f32>, 4>,
  accelOcc: vec4<f32>,
  visGrid: vec4<f32>,
  screen: vec4<f32>,
  worldToLight: mat4x4<f32>,
  shadowCtl: vec4<f32>,
  camRight: vec4<f32>, // xyz = camera right axis (world, unit), w = tan(halfFovY) * aspect
  camUp: vec4<f32>,    // xyz = camera up axis (world, unit),    w = tan(halfFovY)
}

@group(0) @binding(0) var<uniform> frame: Frame;

struct VSOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  let p = positions[vi];
  var out: VSOut;
  out.clip = vec4<f32>(p, 0.0, 1.0);
  out.uv = p * 0.5 + 0.5;
  return out;
}

fn envRadiance(dir: vec3<f32>) -> vec3<f32> {
  let d = normalize(dir);
  let hemi = d.y * 0.5 + 0.5;
  let lKey = normalize(frame.light.xyz);
  let sun = frame.shade.xyz * (0.4 + 1.6 * pow(max(dot(d, lKey), 0.0), 28.0));
  let amb = vec3<f32>(frame.light.w);
  let sky = amb * 2.4 + sun + vec3<f32>(0.08, 0.12, 0.22) * hemi;
  let ground = amb * 0.25 + vec3<f32>(0.05, 0.045, 0.04);
  return mix(ground, sky, hemi) * max(frame.liquid.z, 0.2);
}

fn tonemapACES(x: vec3<f32>) -> vec3<f32> {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
}

// Render targets must match the volume pipeline exactly (colour + depth + the Milestone 6 / B3
// G-buffer placeholders below); background depth = 1.0 (far).
struct FragOut {
  @location(0) color: vec4<f32>,
  @location(1) depth: vec4<f32>,
  @location(2) colorUnlit: vec4<f32>,
  @location(3) surfacePos: vec4<f32>,
  @location(4) surfaceNormal: vec4<f32>,
  @location(5) surfaceAlbedo: vec4<f32>,
};

@fragment
fn fs_main(in: VSOut) -> FragOut {
  let ndc = vec2<f32>(in.uv.x * 2.0 - 1.0, (1.0 - in.uv.y) * 2.0 - 1.0);
  // Match marchColor's camera-basis ray reconstruction exactly (not invViewProj, which loses precision
  // at extreme zoom-out): a mismatched ray direction here vs. the tile march is what reads as a seam /
  // clipping discontinuity at the tile-classifier boundary when zoomed far out.
  let forward = frame.measureFwd.xyz;
  let rd = normalize(
    forward + ndc.x * frame.camRight.w * frame.camRight.xyz + ndc.y * frame.camUp.w * frame.camUp.xyz,
  );
  var bg = envRadiance(rd) * 0.85;
  if (frame.composite.y < 0.5) {
    bg = pow(tonemapACES(bg), vec3<f32>(0.95));
  }
  let color = vec4<f32>(bg, 1.0);
  return FragOut(color, vec4<f32>(1.0, 0.0, 0.0, 0.0), color, vec4<f32>(0.0), vec4<f32>(0.0, 1.0, 0.0, 0.0), vec4<f32>(0.0));
}
`;
