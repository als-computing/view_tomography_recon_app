/**
 * High-quality WGSL direct volume ray-marcher for {@link "../volume/volume-renderer".VolumeRenderer}.
 *
 * Supports composite / MIP / MinIP / average blend modes, crop AABB, axis slice planes / plane
 * views, gradient-modulated opacity, and dielectric liquid shading (Fresnel / env / Beer / GGX).
 *
 * @packageDocumentation
 */

import { LIGHT_STRUCT_WGSL } from "./lights.js";

/** Byte size of the volume frame uniform block (mat4 + 14 × vec4). */
export const VOLUME_FRAME_UNIFORM_SIZE = 352;

/** High-quality volume ray-march WGSL (vertex + fragment). */
export const VOLUME_RAYMARCH_WGSL = /* wgsl */ `
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
  composite: vec4<f32>,      // x = alphaComposite (1 = transparent miss), y = linear-HDR out
  lightCtl0: vec4<f32>,      // x = numLights, y = masterAmbient, z = specStrength, w = roughness
  lightCtl1: vec4<f32>,      // x = shadowEnable, y = shadowSteps, z = shadowStrength, w = shadowSoftness
  lightCtl2: vec4<f32>,      // x = aoEnable, y = aoRadius (uvw frac), z = aoIntensity, w = aoSamples
  measurePlane: vec4<f32>,   // x = enable, y = depth (world, along view axis), z = gray, w = alpha
  measureFwd: vec4<f32>,     // xyz = camera forward (world, unit); marks the measure plane in depth
  brickMin: vec4<f32>,       // xyz = ROI brick world min, w = enable (1 = composite fine brick)
  brickMax: vec4<f32>,       // xyz = ROI brick world max, w = brickBlend fade weight [0,1]
};

// slices.w bits: 1=xEn, 2=yEn, 4=zEn, 8=showPlanes, 16/32 = viewMode (0 vol, 1 x, 2 y, 3 z) in bits 4-5

${LIGHT_STRUCT_WGSL}

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var volumeTex: texture_3d<f32>;
@group(0) @binding(2) var volumeSampler: sampler;
@group(0) @binding(3) var tfTex: texture_2d<f32>;
@group(0) @binding(4) var tfSampler: sampler;
@group(0) @binding(5) var<storage, read> lights: array<Light>;
@group(0) @binding(6) var brickTex: texture_3d<f32>;

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
  // The brick texture is zero where fine-level chunks are missing/sparse; never let an empty fine
  // sample overwrite valid coarse data (that produced voids). Gate the blend on the fine having signal.
  let hasFine = smoothstep(0.0, 0.01, fine);
  // Feather toward the ROI faces to hide the resolution seam, then blend by the fade weight.
  let e = min(min(min(bUvw.x, 1.0 - bUvw.x), min(bUvw.y, 1.0 - bUvw.y)), min(bUvw.z, 1.0 - bUvw.z));
  let w = clamp(frame.brickMax.w, 0.0, 1.0) * smoothstep(0.0, 0.06, e) * hasFine;
  return mix(coarse, fine, w);
}

fn sampleTf(density: f32) -> vec4<f32> {
  return textureSampleLevel(tfTex, tfSampler, vec2<f32>(density, 0.5), 0.0);
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
  let ambientTerm = base * masterAmbient * (1.0 - ao);

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
      shadow = shadowTransmittance(pWorld, ldir, densityScale, maxDist, seed);
    }
    let ndotl = max(dot(n, ldir), 0.0);
    let H = normalize(ldir + viewDir);
    let ndoth = max(dot(n, H), 0.0);
    let spec = pow(ndoth, shininess) * specStrength * smoothstep(0.05, 0.25, density);
    diffuseSpec += (base * ndotl + spec) * radiance * shadow;
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

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
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
  var i = 0;
  loop {
    if (i >= maxSteps || t > tEnd) { break; }
    if (blendMode == 0 && color.a > 0.995) { break; }

    // Cross the measure plane in depth order: composite it before the sample once the ray reaches it.
    if (!planeDone && t >= planeT) {
      let om = 1.0 - color.a;
      color = vec4<f32>(color.rgb + om * planeAlpha * vec3<f32>(planeGray), color.a + om * planeAlpha);
      planeDone = true;
    }

    let p = ro + rd * t;
    let uvw = clamp((p + halfExt) / (2.0 * halfExt), vec3<f32>(0.0), vec3<f32>(1.0));

    if (!inCrop(uvw) || !passesViewMode(uvw, viewMode, slabT * 2.5)) {
      t += stepSize;
      i += 1;
      continue;
    }

    let density = sampleDensity(uvw);
    if (density < 0.01 && blendMode == 0) {
      t += stepSize * 1.75;
      i += 1;
      continue;
    }

    var src = sampleTf(density);
    let grad = densityGradient(uvw);
    let gLen = length(grad);
    let gFactor = mix(1.0, smoothstep(0.0, gradScale, gLen), clamp(gradOpacity, 0.0, 1.0));
    src.a = src.a * gFactor;

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
      let sigma = max(src.a, 0.0) * densityScale * sigmaMul;
      var alpha = 1.0 - exp(-sigma * stepSize);
      alpha = max(alpha, planeH * 0.35);
      if (alpha > 1e-4) {
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
      }
    }

    t += stepSize;
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
  return vec4<f32>(outRgb, outA);
}
`;
