/**
 * Shared GPU light kinds and photometric helpers for the unified lighting library.
 *
 * Intensities are stored as linear floats suitable for PBR shading:
 * - **Directional:** illuminance scale (lux-like) multiplying `color`.
 * - **Point / spot:** luminous intensity scale (candela-like); shader applies `1/r²`.
 * - **Rect:** provisional intensity (LTC / area lighting lands in a later phase).
 *
 * @packageDocumentation
 */

/** Maximum lights packed into the GPU storage buffer. */
export const MAX_LIGHTS = 64;

/** GPU light kind codes (must match `LIGHTS_WGSL`). */
export const GpuLightKind = {
  directional: 0,
  point: 1,
  spot: 2,
  rect: 3,
} as const;

export type GpuLightKindCode = (typeof GpuLightKind)[keyof typeof GpuLightKind];

/**
 * CPU-side light ready for GPU upload. One light = four `vec4`s (64 bytes, std430).
 *
 * Layout:
 * - `positionKind`: xyz = world position (or unused for directional), w = kind
 * - `colorIntensity`: rgb = linear color, w = photometric intensity
 * - `directionRange`: xyz = direction (toward light for directional; spot/rect forward), w = range
 * - `spotRect`: x = cos(inner), y = cos(outer), z = width, w = height
 */
export interface GpuLight {
  positionKind: [number, number, number, number];
  colorIntensity: [number, number, number, number];
  directionRange: [number, number, number, number];
  spotRect: [number, number, number, number];
  /** Optional: cast shadows (Phase 3). Packed into flags when shadows land. */
  castShadows?: boolean;
}

/** Bytes per {@link GpuLight} in the storage buffer. */
export const GPU_LIGHT_STRIDE_BYTES = 64;

/** Default point-light range (m) when the scene component omits `range`. */
export const DEFAULT_POINT_RANGE = 8;

/** Default spot outer half-angle (rad) ≈ 30°. */
export const DEFAULT_SPOT_OUTER = Math.PI / 6;

/** Default spot inner half-angle (rad) ≈ 20°. */
export const DEFAULT_SPOT_INNER = Math.PI / 9;

/**
 * Build a directional light. `directionTowardLight` is a world-space vector pointing toward the
 * light (same convention as the legacy `Renderer.findLight`).
 */
export function makeDirectionalLight(
  directionTowardLight: readonly [number, number, number],
  color: readonly [number, number, number],
  intensity: number,
): GpuLight {
  const len = Math.hypot(directionTowardLight[0], directionTowardLight[1], directionTowardLight[2]) || 1;
  const dx = directionTowardLight[0]! / len;
  const dy = directionTowardLight[1]! / len;
  const dz = directionTowardLight[2]! / len;
  return {
    positionKind: [0, 0, 0, GpuLightKind.directional],
    colorIntensity: [color[0]!, color[1]!, color[2]!, Math.max(0, intensity)],
    directionRange: [dx, dy, dz, 0],
    spotRect: [0, 0, 0, 0],
  };
}

/** Build a punctual point light at `position` (m) with inverse-square falloff out to `range`. */
export function makePointLight(
  position: readonly [number, number, number],
  color: readonly [number, number, number],
  intensity: number,
  range = DEFAULT_POINT_RANGE,
): GpuLight {
  return {
    positionKind: [position[0]!, position[1]!, position[2]!, GpuLightKind.point],
    colorIntensity: [color[0]!, color[1]!, color[2]!, Math.max(0, intensity)],
    directionRange: [0, 0, 0, Math.max(1e-3, range)],
    spotRect: [0, 0, 0, 0],
  };
}

/** Build a spot light; `direction` is the cone axis (light → scene). */
export function makeSpotLight(
  position: readonly [number, number, number],
  direction: readonly [number, number, number],
  color: readonly [number, number, number],
  intensity: number,
  options: {
    range?: number;
    innerConeAngle?: number;
    outerConeAngle?: number;
  } = {},
): GpuLight {
  const len = Math.hypot(direction[0], direction[1], direction[2]) || 1;
  const inner = options.innerConeAngle ?? DEFAULT_SPOT_INNER;
  const outer = options.outerConeAngle ?? Math.max(inner + 1e-3, DEFAULT_SPOT_OUTER);
  return {
    positionKind: [position[0]!, position[1]!, position[2]!, GpuLightKind.spot],
    colorIntensity: [color[0]!, color[1]!, color[2]!, Math.max(0, intensity)],
    directionRange: [
      direction[0]! / len,
      direction[1]! / len,
      direction[2]! / len,
      Math.max(1e-3, options.range ?? DEFAULT_POINT_RANGE),
    ],
    spotRect: [Math.cos(inner), Math.cos(outer), 0, 0],
  };
}

/** Provisional rect area light (shaded as a bright point until LTC). */
export function makeRectLight(
  position: readonly [number, number, number],
  normal: readonly [number, number, number],
  color: readonly [number, number, number],
  intensity: number,
  width: number,
  height: number,
): GpuLight {
  const len = Math.hypot(normal[0], normal[1], normal[2]) || 1;
  return {
    positionKind: [position[0]!, position[1]!, position[2]!, GpuLightKind.rect],
    colorIntensity: [color[0]!, color[1]!, color[2]!, Math.max(0, intensity)],
    directionRange: [normal[0]! / len, normal[1]! / len, normal[2]! / len, DEFAULT_POINT_RANGE * 2],
    spotRect: [0, 0, Math.max(1e-4, width), Math.max(1e-4, height)],
  };
}

/**
 * Smooth distance attenuation used by the GPU and CPU reference:
 * `saturate(1 - (r/range)⁴)² / (r² + ε)`.
 */
export function distanceAttenuation(distance: number, range: number): number {
  const r = Math.max(distance, 1e-4);
  const x = Math.min(1, Math.max(0, 1 - (r / Math.max(range, 1e-4)) ** 4));
  return (x * x) / (r * r + 1e-4);
}

/** Spot cone angular attenuation between cos(inner) and cos(outer). */
export function spotAttenuation(
  cosTheta: number,
  cosInner: number,
  cosOuter: number,
): number {
  if (cosTheta <= cosOuter) return 0;
  if (cosTheta >= cosInner) return 1;
  const t = (cosTheta - cosOuter) / Math.max(1e-5, cosInner - cosOuter);
  return t * t;
}
