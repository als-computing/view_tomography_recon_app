/**
 * Shared WGSL lighting primitives for forward, volume, and gem paths.
 *
 * Layout matches {@link "../lighting/types".GpuLight} / `packLightsStd430` (64 bytes / light).
 *
 * @packageDocumentation
 */

/** Cook-Torrance GGX / Smith / Schlick helpers (no scene bindings). */
export const BRDF_WGSL = /* wgsl */ `
const PI: f32 = 3.141592653589793;

fn fresnelSchlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32> {
  return F0 + (vec3<f32>(1.0) - F0) * pow(1.0 - cosTheta, 5.0);
}

fn distributionGGX(nDotH: f32, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let a2 = a * a;
  let d = nDotH * nDotH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}

fn geometrySchlickGGX(nDotX: f32, roughness: f32) -> f32 {
  let r = roughness + 1.0;
  let k = (r * r) / 8.0;
  return nDotX / (nDotX * (1.0 - k) + k);
}

fn geometrySmith(n: vec3<f32>, v: vec3<f32>, l: vec3<f32>, roughness: f32) -> f32 {
  return geometrySchlickGGX(max(dot(n, v), 0.0), roughness)
       * geometrySchlickGGX(max(dot(n, l), 0.0), roughness);
}

fn shadeDirect(
  n: vec3<f32>,
  v: vec3<f32>,
  l: vec3<f32>,
  radiance: vec3<f32>,
  albedo: vec3<f32>,
  metallic: f32,
  roughness: f32,
  f0: vec3<f32>,
) -> vec3<f32> {
  let h = normalize(v + l);
  let nDotL = max(dot(n, l), 0.0);
  let nDotH = max(dot(n, h), 0.0);
  let nDotV = max(dot(n, v), 0.0);
  let D = distributionGGX(nDotH, roughness);
  let G = geometrySmith(n, v, l, roughness);
  let F = fresnelSchlick(max(dot(h, v), 0.0), f0);
  let specular = (D * G * F) / max(4.0 * nDotV * nDotL, 0.001);
  let kd = (vec3<f32>(1.0) - F) * (1.0 - metallic);
  return (kd * albedo / PI + specular) * radiance * nDotL;
}
`;

/**
 * std430-matched light record (64 bytes). Must precede the storage binding.
 *
 * - positionKind: xyz = world position, w = kind (0 dir, 1 point, 2 spot, 3 rect)
 * - colorIntensity: rgb = linear color, w = photometric intensity
 * - directionRange: xyz = dir (toward light for directional; cone/rect forward), w = range
 * - spotRect: x = cos(inner), y = cos(outer), z = width, w = height
 */
export const LIGHT_STRUCT_WGSL = /* wgsl */ `
struct Light {
  positionKind: vec4<f32>,
  colorIntensity: vec4<f32>,
  directionRange: vec4<f32>,
  spotRect: vec4<f32>,
};
`;

/**
 * Light evaluation that samples `lights` storage.
 * Include after `@group(0) @binding(1) var<storage, read> lights: array<Light>;`.
 */
export const LIGHT_EVAL_WGSL = /* wgsl */ `
fn lightAttenuation(dist: f32, range: f32) -> f32 {
  if (range <= 0.0) {
    return 1.0 / max(dist * dist, 0.0001);
  }
  let x = clamp(1.0 - pow(dist / max(range, 0.001), 4.0), 0.0, 1.0);
  return (x * x) / max(dist * dist, 0.0001);
}

fn lightRadiance(light: Light) -> vec3<f32> {
  return light.colorIntensity.xyz * light.colorIntensity.w;
}

fn evalDirectional(
  light: Light,
  n: vec3<f32>,
  v: vec3<f32>,
  albedo: vec3<f32>,
  metallic: f32,
  roughness: f32,
  f0: vec3<f32>,
) -> vec3<f32> {
  // directionRange.xyz points toward the light (legacy Renderer convention).
  let l = normalize(light.directionRange.xyz);
  return shadeDirect(n, v, l, lightRadiance(light), albedo, metallic, roughness, f0);
}

fn evalPoint(
  light: Light,
  n: vec3<f32>,
  v: vec3<f32>,
  worldPos: vec3<f32>,
  albedo: vec3<f32>,
  metallic: f32,
  roughness: f32,
  f0: vec3<f32>,
) -> vec3<f32> {
  let toLight = light.positionKind.xyz - worldPos;
  let dist = length(toLight);
  let l = toLight / max(dist, 0.0001);
  let att = lightAttenuation(dist, light.directionRange.w);
  return shadeDirect(n, v, l, lightRadiance(light) * att, albedo, metallic, roughness, f0);
}

fn evalSpot(
  light: Light,
  n: vec3<f32>,
  v: vec3<f32>,
  worldPos: vec3<f32>,
  albedo: vec3<f32>,
  metallic: f32,
  roughness: f32,
  f0: vec3<f32>,
) -> vec3<f32> {
  let toLight = light.positionKind.xyz - worldPos;
  let dist = length(toLight);
  let l = toLight / max(dist, 0.0001);
  let spotDir = normalize(light.directionRange.xyz);
  let cosTheta = dot(-l, spotDir);
  let cosInner = light.spotRect.x;
  let cosOuter = light.spotRect.y;
  let spot = smoothstep(cosOuter, cosInner, cosTheta);
  let att = lightAttenuation(dist, light.directionRange.w) * spot;
  return shadeDirect(n, v, l, lightRadiance(light) * att, albedo, metallic, roughness, f0);
}

fn evalRect(
  light: Light,
  n: vec3<f32>,
  v: vec3<f32>,
  worldPos: vec3<f32>,
  albedo: vec3<f32>,
  metallic: f32,
  roughness: f32,
  f0: vec3<f32>,
) -> vec3<f32> {
  let center = light.positionKind.xyz;
  let toLight = center - worldPos;
  let dist = length(toLight);
  let l = toLight / max(dist, 0.0001);
  let area = max(light.spotRect.z * light.spotRect.w, 0.0001);
  let att = lightAttenuation(dist, light.directionRange.w) * area * 0.05;
  return shadeDirect(n, v, l, lightRadiance(light) * att, albedo, metallic, roughness, f0);
}

fn evalLight(
  light: Light,
  n: vec3<f32>,
  v: vec3<f32>,
  worldPos: vec3<f32>,
  albedo: vec3<f32>,
  metallic: f32,
  roughness: f32,
  f0: vec3<f32>,
) -> vec3<f32> {
  let kind = i32(light.positionKind.w + 0.5);
  if (kind == 0) {
    return evalDirectional(light, n, v, albedo, metallic, roughness, f0);
  }
  if (kind == 1) {
    return evalPoint(light, n, v, worldPos, albedo, metallic, roughness, f0);
  }
  if (kind == 2) {
    return evalSpot(light, n, v, worldPos, albedo, metallic, roughness, f0);
  }
  if (kind == 3) {
    return evalRect(light, n, v, worldPos, albedo, metallic, roughness, f0);
  }
  return vec3<f32>(0.0);
}

fn accumulateLights(
  n: vec3<f32>,
  v: vec3<f32>,
  worldPos: vec3<f32>,
  albedo: vec3<f32>,
  metallic: f32,
  roughness: f32,
  f0: vec3<f32>,
  lightCount: i32,
) -> vec3<f32> {
  var color = vec3<f32>(0.0);
  let nLights = min(lightCount, 64);
  for (var i = 0; i < nLights; i++) {
    color += evalLight(lights[i], n, v, worldPos, albedo, metallic, roughness, f0);
  }
  return color;
}
`;

/** Combined struct + eval (only valid when `lights` is already in scope — prefer split includes). */
export const LIGHTS_WGSL = `${LIGHT_STRUCT_WGSL}\n${LIGHT_EVAL_WGSL}`;
