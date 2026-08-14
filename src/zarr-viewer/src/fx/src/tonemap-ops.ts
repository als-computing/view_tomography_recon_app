/**
 * Tone-mapping and color operators, as pure CPU functions plus the matching WGSL snippets. Having a
 * single, tested source of truth fixes the previous duplication where each shader inlined its own
 * ACES curve. The CPU functions are used for validation, LUT baking, and tests; the WGSL constants
 * are pasted into the post-processing fragment shaders so the two never drift.
 *
 * @packageDocumentation
 */

/** Rec. 709 relative luminance of a linear RGB color. */
export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Scale a linear value by an exposure stop count (EV): `x · 2^ev`. */
export function applyExposure(x: number, ev: number): number {
  return x * 2 ** ev;
}

/** Reinhard tone map `x / (1 + x)`; simple, never clips, but desaturates highlights. */
export function reinhard(x: number): number {
  return x / (1 + x);
}

/**
 * Extended Reinhard with a white point: highlights up to `white` map to 1 while preserving more
 * contrast than plain Reinhard.
 */
export function reinhardExtended(x: number, white: number): number {
  return (x * (1 + x / (white * white))) / (1 + x);
}

/**
 * ACES filmic tone map (Narkowicz's fitted curve). The de-facto default for film-like HDR→LDR,
 * matching the curve previously duplicated across the forward/gem/volume shaders.
 */
export function acesFilmic(x: number): number {
  const a = 2.51;
  const b = 0.03;
  const c = 2.43;
  const d = 0.59;
  const e = 0.14;
  const y = (x * (a * x + b)) / (x * (c * x + d) + e);
  return y < 0 ? 0 : y > 1 ? 1 : y;
}

/** Encode a linear channel to sRGB (gamma) for display. */
export function linearToSrgb(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055;
}

/** Decode an sRGB channel back to linear. */
export function srgbToLinear(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

/** Supported tone-map operators. */
export type ToneMapOperator = "aces" | "reinhard" | "reinhard-extended";

/** WGSL implementations of the operators above, kept byte-for-byte consistent with the CPU code. */
export const TONEMAP_WGSL = /* wgsl */ `
fn tm_luminance(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

fn tm_reinhard(c: vec3f) -> vec3f { return c / (1.0 + c); }

fn tm_reinhard_extended(c: vec3f, white: f32) -> vec3f {
  return (c * (1.0 + c / (white * white))) / (1.0 + c);
}

fn tm_aces(c: vec3f) -> vec3f {
  let a = 2.51; let b = 0.03; let d = 2.43; let e = 0.59; let f = 0.14;
  return clamp((c * (a * c + b)) / (c * (d * c + e) + f), vec3f(0.0), vec3f(1.0));
}

fn tm_linear_to_srgb(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}
`;
