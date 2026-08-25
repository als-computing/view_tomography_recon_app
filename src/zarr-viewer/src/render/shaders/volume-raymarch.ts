/**
 * High-quality WGSL direct volume ray-marcher for {@link "../volume/volume-renderer".VolumeRenderer}.
 *
 * Supports composite / MIP / MinIP / average blend modes, crop AABB, axis slice planes / plane
 * views, gradient-modulated opacity, and dielectric liquid shading (Fresnel / env / Beer / GGX).
 *
 * @packageDocumentation
 */

import { LIGHT_STRUCT_WGSL } from "./lights.js";

/** Byte size of the volume frame uniform block (mat4 + 21 × vec4 + shadow mat4 + shadowCtl vec4). */
export const VOLUME_FRAME_UNIFORM_SIZE = 480;

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
  composite: vec4<f32>,      // x = alphaComposite, y = linear-HDR, z = ERT threshold, w unused
  lightCtl0: vec4<f32>,      // x = numLights, y = masterAmbient, z = specStrength, w = roughness
  lightCtl1: vec4<f32>,      // x = shadowEnable, y = shadowSteps, z = shadowStrength, w = shadowSoftness
  lightCtl2: vec4<f32>,      // x = aoEnable, y = aoRadius (uvw frac), z = aoIntensity, w = aoSamples
  measurePlane: vec4<f32>,   // x = enable, y = depth (world, along view axis), z = gray, w = alpha
  measureFwd: vec4<f32>,     // xyz = camera forward (world, unit); marks the measure plane in depth
  brickMin: vec4<f32>,       // xyz = ROI brick world min, w = enable (1 = composite fine brick)
  brickMax: vec4<f32>,       // xyz = ROI brick world max, w = brickBlend fade weight [0,1]
  accelOcc: vec4<f32>,       // xyz = occupancy macrocell grid, w unused
  visGrid: vec4<f32>,        // xyz = vis-bin grid, w = visEnable (1 = accumulate)
  screen: vec4<f32>,         // xy = internal pixels, z = tile size
  worldToLight: mat4x4<f32>, // world → light-space UVW for the opacity shadow map (Milestone 7.1)
  shadowCtl: vec4<f32>,      // x = shadowMapEnable (1 = sample the map instead of marching a shadow ray)
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
// Cumulative extinction LUT for pre-integration (Milestone 3.1): tPreint[i] = ∫₀^{d_i} α(x) dx over the
// transfer function alpha (density units). Kept f32 (the ratio form is cancellation-prone). One entry
// per TF LUT bin; a 2-entry dummy is bound when PRE_INTEGRATE is off.
@group(0) @binding(11) var<storage, read> tPreint: array<f32>;
// Light-space opacity shadow map (Milestone 7.1): .r = optical depth τ from the light to each point.
@group(0) @binding(12) var shadowTex: texture_3d<f32>;

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

fn sampleDensity(uvw: vec3<f32>) -> f32 {
  let coarse = textureSampleLevel(volumeTex, volumeSampler, uvw, 0.0).r;
  if (frame.brickMin.w < 0.5) { return coarse; } // no high-res ROI brick
  // Map the world point (uvw is over the full coarse box) into the ROI brick's [0,1]^3.
  let halfExt = max(frame.boxHalf.xyz, vec3<f32>(1e-6));
  let p = uvw * (2.0 * halfExt) - halfExt;
  let bUvw = (p - frame.brickMin.xyz) / max(frame.brickMax.xyz - frame.brickMin.xyz, vec3<f32>(1e-6));
  if (any(bUvw < vec3<f32>(0.0)) || any(bUvw > vec3<f32>(1.0))) { return coarse; }
  let fine = textureSampleLevel(brickTex, volumeSampler, bUvw, 0.0).r;
  // Overlay only: never punch holes in the coarse volume (empty / noisy L0 voxels) and never fill
  // empty space with fine-level reconstruction noise (that fogged out the sample when the brick
  // spanned a large Z fraction of a tomography pancake). Sharpen where coarse already has signal.
  let e = min(min(min(bUvw.x, 1.0 - bUvw.x), min(bUvw.y, 1.0 - bUvw.y)), min(bUvw.z, 1.0 - bUvw.z));
  let w = clamp(frame.brickMax.w, 0.0, 1.0) * smoothstep(0.0, 0.06, e) * smoothstep(0.02, 0.08, coarse);
  return mix(coarse, max(coarse, fine), w);
}

fn sampleTf(density: f32) -> vec4<f32> {
  return textureSampleLevel(tfTex, tfSampler, vec2<f32>(density, 0.5), 0.0);
}

// Linearly-interpolated cumulative extinction T(density) from the pre-integration LUT.
fn preintT(d: f32) -> f32 {
  let n = arrayLength(&tPreint);
  if (n < 2u) { return 0.0; }
  let x = clamp(d, 0.0, 1.0) * f32(n - 1u);
  let i0 = u32(floor(x));
  let i1 = min(i0 + 1u, n - 1u);
  return mix(tPreint[i0], tPreint[i1], x - floor(x));
}

// Milestone 3.1: segment-average TF alpha over the density interval [sf, sb] (front→back samples),
// assuming density varies linearly across the step. The ratio form is the exact average extinction;
// near-equal endpoints (|sb-sf| < eps) fall back to the midpoint value (2nd-order, no discontinuity at
// the boundary). This replaces the point-sampled endpoint alpha in the composite, so long majorant
// steps integrate the transfer function instead of skipping over thin spikes between samples.
fn preintAvgAlpha(sf: f32, sb: f32) -> f32 {
  let n = arrayLength(&tPreint);
  let eps = 3.0 / f32(max(n, 2u));
  if (abs(sb - sf) < eps) {
    return sampleTf((sf + sb) * 0.5).a; // limit form (midpoint)
  }
  return (preintT(sb) - preintT(sf)) / (sb - sf); // ratio form (exact average)
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

fn densityGradient(uvw: vec3<f32>) -> vec3<f32> {
  let dims = vec3<f32>(textureDimensions(volumeTex));
  let e = 0.75 / max(dims, vec3<f32>(1.0));
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

// Gentle smooth-cutoff attenuation (no harsh 1/r²) so stage/flashlight coverage stays even.
fn volAttenuation(dist: f32, range: f32) -> f32 {
  if (range <= 0.0) { return 1.0; } // directional: no distance falloff
  let x = clamp(1.0 - (dist / max(range, 1e-3)) * (dist / max(range, 1e-3)), 0.0, 1.0);
  return x * x;
}

// Secondary shadow ray: march from the sample toward the light through the volume, accumulating
// optical depth, and return transmittance T = exp(-tau). ldir points toward the light (world);
// maxDist is the distance to the (positional) light, or huge for directional. seed is a per-sample
// hash in [0,1) used to jitter the start (anti-banding) and dither a soft penumbra.
//
// The step is tied to the PRIMARY ray step (frame.params.x), not the box size, so the shadow's
// optical depth uses the same sampling rate as the composite (same sigma = a*densityScale*12) --
// keeping shadow darkness consistent instead of resolution-dependent. shadowSteps (lightCtl1.y) is a
// cap on how far we march.
fn shadowTransmittance(
  pWorld: vec3<f32>, ldir: vec3<f32>, densityScale: f32, maxDist: f32, seed: f32,
) -> f32 {
  let stepsCap = i32(frame.lightCtl1.y);
  if (stepsCap <= 0) { return 1.0; }
  let halfExt = max(frame.boxHalf.xyz, vec3<f32>(1e-6));
  let ext2 = 2.0 * max(halfExt.x, max(halfExt.y, halfExt.z));
  let softness = clamp(frame.lightCtl1.w, 0.0, 1.0);
  let sStep = max(frame.params.x, 5e-4) * 1.6;
  // March at most: to the light, across the box, and within the step budget.
  let marchLen = min(min(ext2, maxDist), f32(stepsCap) * sStep);
  // Soft shadows: laterally offset the whole ray by up to (softness) steps -- a dithered penumbra that
  // averages out under FXAA / temporal jitter. Build a basis perpendicular to the light direction.
  var origin = pWorld;
  if (softness > 0.0) {
    let up = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(ldir.y) > 0.9);
    let tang = normalize(cross(ldir, up));
    let bitan = cross(ldir, tang);
    let j1 = fract(seed * 17.13) - 0.5;
    let j2 = fract(seed * 41.71 + 0.37) - 0.5;
    origin += (tang * j1 + bitan * j2) * softness * sStep * 2.0;
  }
  // Jittered start bias (>= half a step) avoids self-shadow acne and banding.
  let bias = (0.5 + seed) * sStep;
  var traveled = bias;
  var wp = origin + ldir * bias;
  var tau = 0.0;
  loop {
    if (traveled >= marchLen) { break; }
    let uvw = (wp + halfExt) / (2.0 * halfExt);
    if (any(uvw < vec3<f32>(0.0)) || any(uvw > vec3<f32>(1.0))) { break; }
    if (inCrop(uvw)) {
      let a = sampleTf(sampleDensity(uvw)).a;
      tau += a * densityScale * 12.0 * sStep;
      if (tau > 8.0) { break; }
    }
    wp += ldir * sStep;
    traveled += sStep;
  }
  let T = exp(-tau);
  return mix(1.0, T, clamp(frame.lightCtl1.z, 0.0, 1.0));
}

// Volumetric ambient occlusion: sample density outward along the surface normal; more material
// above a sample = more occluded (darker ambient).
fn ambientOcclusion(pWorld: vec3<f32>, n: vec3<f32>, seed: f32) -> f32 {
  let samples = i32(frame.lightCtl2.w);
  if (samples <= 0) { return 0.0; }
  let halfExt = max(frame.boxHalf.xyz, vec3<f32>(1e-6));
  let ext = max(halfExt.x, max(halfExt.y, halfExt.z));
  let radius = max(frame.lightCtl2.y, 1e-3) * ext;
  let stepW = radius / f32(samples);
  var occ = 0.0;
  for (var s = 1; s <= samples; s++) {
    // Jitter each tap by (seed) within its step so the AO probe doesn't band on flat features.
    let wp = pWorld + n * stepW * (f32(s) - 0.5 + seed);
    let uvw = (wp + halfExt) / (2.0 * halfExt);
    if (any(uvw < vec3<f32>(0.0)) || any(uvw > vec3<f32>(1.0))) { break; }
    if (inCrop(uvw)) {
      occ += sampleTf(sampleDensity(uvw)).a / f32(samples);
    }
  }
  return clamp(occ, 0.0, 1.0);
}

// Milestone 7.1: sample the precomputed light-space opacity map (optical depth τ from the light) with a
// single trilinear fetch, instead of marching a secondary shadow ray. Points outside the map are unlit-
// shadowed (T = 1). Applies the same shadowStrength (lightCtl1.z) as the brute-march path.
fn shadowMapT(worldP: vec3<f32>) -> f32 {
  let lc = (frame.worldToLight * vec4<f32>(worldP, 1.0)).xyz;
  if (any(lc < vec3<f32>(0.0)) || any(lc > vec3<f32>(1.0))) { return 1.0; }
  let tau = textureSampleLevel(shadowTex, volumeSampler, lc, 0.0).r;
  return mix(1.0, exp(-tau), clamp(frame.lightCtl1.z, 0.0, 1.0));
}

// seed is a per-sample hash for shadow/AO jitter. heavy gates the expensive secondary rays
// (shadow + AO) to samples that actually contribute to the image (front-of-volume, not yet opaque);
// low-contribution samples still get cheap diffuse/spec so the look is unchanged.
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
) -> vec3<f32> {
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

  var ao = 0.0;
  if (aoOn && heavy) { ao = ambientOcclusion(pWorld, n, seed) * clamp(frame.lightCtl2.z, 0.0, 1.0); }
  var ambientTerm = base * masterAmbient * (1.0 - ao);
  if (BENT_NORMAL_AMBIENT != 0u) {
    // Milestone 7.2: directional (bent-normal) ambient. Instead of a flat grey ambient, sample the
    // studio environment along the surface normal (the unoccluded-direction proxy) with (1-ao) as the
    // cone aperture. Blended near unity so it re-tints/varies ambient without changing overall exposure.
    let irr = envRadiance(n);
    ambientTerm = base * masterAmbient * (1.0 - ao) * mix(vec3<f32>(1.0), irr, 0.85);
  }

  var diffuseSpec = vec3<f32>(0.0);
  for (var i = 0; i < numLights; i++) {
    let Lgt = lights[i];
    let kind = i32(Lgt.positionKind.w + 0.5);
    var ldir: vec3<f32>;
    var att = 1.0;
    var maxDist = 1e30;
    if (kind == 0) {
      ldir = normalize(Lgt.directionRange.xyz);
    } else {
      let toL = Lgt.positionKind.xyz - pWorld;
      let dist = length(toL);
      maxDist = dist;
      ldir = toL / max(dist, 1e-4);
      att = volAttenuation(dist, Lgt.directionRange.w);
      if (kind == 2) {
        let cosT = dot(-ldir, normalize(Lgt.directionRange.xyz));
        att *= smoothstep(Lgt.spotRect.y, Lgt.spotRect.x, cosT);
      }
    }
    if (att <= 0.0) { continue; }
    let radiance = Lgt.colorIntensity.xyz * Lgt.colorIntensity.w * att;
    var shadow = 1.0;
    // Only shadow-casting lights (spotRect.z flag, set per light on the CPU) cast, and only for
    // contributing samples (heavy) -- clamps the biggest cost while matching the visible result.
    if (shadowOn && heavy && Lgt.spotRect.z > 0.5) {
      if (frame.shadowCtl.x > 0.5) {
        shadow = shadowMapT(pWorld); // precomputed light-space opacity map (Milestone 7.1)
      } else {
        shadow = shadowTransmittance(pWorld, ldir, densityScale, maxDist, seed);
      }
    }
    let ndotl = max(dot(n, ldir), 0.0);
    let H = normalize(ldir + viewDir);
    let ndoth = max(dot(n, H), 0.0);
    let spec = pow(ndoth, shininess) * specStrength * smoothstep(0.05, 0.25, density);
    diffuseSpec += (base * ndotl + spec) * radiance * shadow;
    if (MS_OCTAVES > 0u && heavy) {
      // Milestone 7.3: cheap multi-scatter octaves (Wrenninge). Each octave lets light penetrate deeper
      // via T^c (c < 1) with no extra shadow marching; weighting by (Tj - shadow) adds a soft glow that
      // fills hard shadows without brightening already-lit samples (Tj == shadow ⇒ zero contribution).
      var atten = 1.0;
      var w = 1.0;
      for (var o = 0u; o < MS_OCTAVES; o++) {
        atten *= 0.5;
        w *= 0.6;
        let Tj = pow(shadow, atten);
        diffuseSpec += base * ndotl * radiance * max(Tj - shadow, 0.0) * w;
      }
    }
  }

  let rim = base * pow(1.0 - max(dot(n, viewDir), 0.0), 3.0) * 0.25;
  let lit = ambientTerm + diffuseSpec + rim;
  let edge = smoothstep(0.02, 0.35, gLen);
  let shaded = mix(base * masterAmbient, lit, clamp(0.35 + edge * 0.65, 0.0, 1.0));
  return mix(base, shaded, clamp(lighting, 0.0, 1.0));
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
fn marchColor(in: VSOut, depthOut: ptr<function, f32>) -> vec4<f32> {
  let ndc = vec2<f32>(in.uv.x * 2.0 - 1.0, (1.0 - in.uv.y) * 2.0 - 1.0);
  let nearH = frame.invViewProj * vec4<f32>(ndc, 0.0, 1.0);
  let farH = frame.invViewProj * vec4<f32>(ndc, 1.0, 1.0);
  let nearW = nearH.xyz / nearH.w;
  let farW = farH.xyz / farH.w;

  let ro = frame.eye.xyz;
  let rd = normalize(farW - nearW);
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
    if (planeT > 0.0) {
      if (alphaComposite) { return vec4<f32>(vec3<f32>(planeGray) * planeAlpha, planeAlpha); }
      let comp = mix(bg, vec3<f32>(planeGray), planeAlpha);
      if (frame.composite.y >= 0.5) { return vec4<f32>(comp, 1.0); }
      let outC = tonemapACES(comp);
      return vec4<f32>(pow(outC, vec3<f32>(0.95)), 1.0);
    }
    if (alphaComposite) {
      return vec4<f32>(0.0, 0.0, 0.0, 0.0);
    }
    if (frame.composite.y >= 0.5) { return vec4<f32>(bg, 1.0); } // linear HDR for post stack
    let outBg = tonemapACES(bg);
    return vec4<f32>(pow(outBg, vec3<f32>(0.95)), 1.0);
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
      if (rec.dist >= OCC_LEAP_MIN) {
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

    let density = sampleDensity(uvw);
    if (density < 0.01 && blendMode == 0) {
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
        effAlpha = max(preintAvgAlpha(prevDensity, density) * gFactor, 0.0);
      }
      let sigma = effAlpha * densityScale * sigmaMul;
      var alpha = 1.0 - exp(-sigma * stepNow);
      alpha = max(alpha, planeH * 0.35);
      if (alpha > SHADE_ALPHA_EPS && effAlpha > SHADE_ALPHA_EPS) {
        // Gate the expensive shadow/AO rays to samples that still meaningfully affect the image:
        // in front of the volume (remaining transmittance high) and locally opaque enough to matter.
        let heavy = (1.0 - color.a) > 0.03 && alpha > 0.03;
        let sseed = fract(jitter + f32(i) * 0.61803399);
        var lit: vec3<f32>;
        if (dielectric) {
          lit = shadeDielectric(src.rgb, src.a, grad, viewDir, rd, density);
        } else {
          lit = shadeSample(src.rgb, grad, viewDir, p, density, lighting, densityScale, sseed, heavy);
        }
        lit = mix(lit, vec3<f32>(0.95, 0.85, 0.35), planeH * 0.65);
        let a = clamp(alpha, 0.0, 1.0);
        let oneMinus = 1.0 - color.a;
        color = vec4<f32>(color.rgb + oneMinus * lit * a, color.a + oneMinus * a);
        let dContrib = oneMinus * a; // this sample's opacity contribution
        centroidNum += t * dContrib;
        centroidWeight += dContrib;
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
      return vec4<f32>(0.0, 0.0, 0.0, 0.0);
    } else {
      outRgb = bg;
    }
  } else {
    outRgb = color.rgb * exposure;
    if (alphaComposite) {
      outA = color.a;
      if (outA < 1e-4) {
        return vec4<f32>(0.0, 0.0, 0.0, 0.0);
      }
    } else {
      outRgb = outRgb + (1.0 - color.a) * bg;
      outA = 1.0;
    }
  }

  // composite.y >= 0.5 → emit linear HDR (a post stack tonemaps); else tonemap in-shader.
  if (frame.composite.y < 0.5) {
    outRgb = tonemapACES(outRgb);
    outRgb = pow(outRgb, vec3<f32>(0.95));
  }
  // Depth centroid (world distance along the ray) normalized by the far plane, for TAAU reprojection.
  let far = max(frame.shadowCtl.y, 1e-6);
  let centroidT = select(hit.x, centroidNum / max(centroidWeight, 1e-6), centroidWeight > 1e-5);
  *depthOut = clamp(centroidT / far, 0.0, 1.0);
  return vec4<f32>(outRgb, outA);
}

// MRT entry point: colour to location 0, depth centroid (.r) to location 1. Splitting marchColor out
// keeps its many early returns untouched; the depth defaults to 1.0 (far) for every early exit.
struct FragOut {
  @location(0) color: vec4<f32>,
  @location(1) depth: vec4<f32>,
};

@fragment
fn fs_main(in: VSOut) -> FragOut {
  var depth = 1.0;
  let color = marchColor(in, &depth);
  return FragOut(color, vec4<f32>(depth, 0.0, 0.0, 0.0));
}
`;
}

/** Baseline (unaccelerated) WGSL, matching {@link volumeRaymarchWgsl} with occupancy/tiles off. */
export const VOLUME_RAYMARCH_WGSL = volumeRaymarchWgsl();

/** Fullscreen background pass used when instanced tiles don't cover every pixel. */
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

// Two render targets to match the volume pipeline (colour + depth); background depth = 1.0 (far).
struct FragOut {
  @location(0) color: vec4<f32>,
  @location(1) depth: vec4<f32>,
};

@fragment
fn fs_main(in: VSOut) -> FragOut {
  let ndc = vec2<f32>(in.uv.x * 2.0 - 1.0, (1.0 - in.uv.y) * 2.0 - 1.0);
  let nearH = frame.invViewProj * vec4<f32>(ndc, 0.0, 1.0);
  let farH = frame.invViewProj * vec4<f32>(ndc, 1.0, 1.0);
  let rd = normalize(farH.xyz / farH.w - nearH.xyz / nearH.w);
  var bg = envRadiance(rd) * 0.85;
  if (frame.composite.y < 0.5) {
    bg = pow(tonemapACES(bg), vec3<f32>(0.95));
  }
  return FragOut(vec4<f32>(bg, 1.0), vec4<f32>(1.0, 0.0, 0.0, 0.0));
}
`;
