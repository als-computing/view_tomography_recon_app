/**
 * WGSL shared between the main volume raymarch shader ({@link "./volume-raymarch".volumeRaymarchWgsl})
 * and the Milestone 6 (B3) half-res lighting pass: the shadow/AO/multi-scatter "heavy" lighting terms.
 * Extracted to one shared string (rather than duplicated, unlike the small `Frame`-struct-style
 * duplication elsewhere in this codebase) because this is ~150 lines of non-trivial shading logic —
 * genuinely risky to keep in sync by hand across two files.
 *
 * The including module must already declare, with these exact names: a `frame: Frame` uniform (with
 * `lightCtl1`/`lightCtl2`/`boxHalf`/`params`/`worldToLight`/`shadowCtl` fields matching the main
 * shader's `Frame` struct), `lights: array<Light>`, `volumeSampler: sampler`, `shadowTex:
 * texture_3d<f32>`, the `Light` struct (`LIGHT_STRUCT_WGSL`), a `MS_OCTAVES: u32` const, and the small
 * helper functions `inCrop(uvw)`, `sampleTf(density)`, `sampleDensity(uvw)` (each ~5-20 lines - kept as
 * a small, explicitly-must-match duplication per module rather than extracted here, since they're also
 * needed by code outside the lighting path in each consumer).
 *
 * @packageDocumentation
 */

export const VOLUME_LIGHTING_SHARED_WGSL = /* wgsl */ `
// Gentle smooth-cutoff attenuation (no harsh 1/r^2) so stage/flashlight coverage stays even.
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

// Milestone 7.1: sample the precomputed light-space opacity map (optical depth tau from the light)
// with a single trilinear fetch, instead of marching a secondary shadow ray. Points outside the map
// are unlit-shadowed (T = 1). Applies the same shadowStrength (lightCtl1.z) as the brute-march path.
fn shadowMapT(worldP: vec3<f32>) -> f32 {
  let lc = (frame.worldToLight * vec4<f32>(worldP, 1.0)).xyz;
  if (any(lc < vec3<f32>(0.0)) || any(lc > vec3<f32>(1.0))) { return 1.0; }
  let tau = textureSampleLevel(shadowTex, volumeSampler, lc, 0.0).r;
  return mix(1.0, exp(-tau), clamp(frame.lightCtl1.z, 0.0, 1.0));
}

// seed is a per-sample hash for shadow/AO jitter. heavy gates the expensive secondary rays
// (shadow + AO) to samples that actually contribute to the image (front-of-volume, not yet opaque);
// low-contribution samples still get cheap diffuse/spec so the look is unchanged.
// Milestone 6 (B3): isolated into one swappable function so a half-res/G-buffer lighting pass can
// call the exact same code a full-res inline sample does, instead of duplicating it.
struct LightingResult {
  ao: f32,
  diffuseSpec: vec3<f32>,
}

fn evaluateLighting(
  base: vec3<f32>,
  n: vec3<f32>,
  viewDir: vec3<f32>,
  pWorld: vec3<f32>,
  density: f32,
  densityScale: f32,
  seed: f32,
  heavy: bool,
  numLights: i32,
  specStrength: f32,
  shininess: f32,
  aoOn: bool,
  shadowOn: bool,
) -> LightingResult {
  var ao = 0.0;
  if (aoOn && heavy) { ao = ambientOcclusion(pWorld, n, seed) * clamp(frame.lightCtl2.z, 0.0, 1.0); }

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
      // fills hard shadows without brightening already-lit samples (Tj == shadow => zero contribution).
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

  return LightingResult(ao, diffuseSpec);
}
`;
