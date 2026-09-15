/**
 * Scalar math utilities and shared constants.
 *
 * All functions are pure and allocation-free. Angles are in radians unless a name says otherwise.
 *
 * @packageDocumentation
 */

/** Small tolerance for floating-point comparisons (single-precision friendly). */
export const EPSILON = 1e-6;

/** The circle constant pi. */
export const PI = Math.PI;
/** Two pi (a full turn in radians). */
export const TAU = Math.PI * 2;
/** Half pi (a quarter turn in radians). */
export const HALF_PI = Math.PI / 2;

/** Multiply degrees by this to get radians. */
export const DEG2RAD = Math.PI / 180;
/** Multiply radians by this to get degrees. */
export const RAD2DEG = 180 / Math.PI;

/** Convert degrees to radians. */
export function degToRad(degrees: number): number {
  return degrees * DEG2RAD;
}

/** Convert radians to degrees. */
export function radToDeg(radians: number): number {
  return radians * RAD2DEG;
}

/** Clamp `x` into the inclusive range `[min, max]`. */
export function clamp(x: number, min: number, max: number): number {
  return x < min ? min : x > max ? max : x;
}

/** Clamp `x` into `[0, 1]`. */
export function saturate(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Linearly interpolate from `a` to `b` by `t` (unclamped). */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Inverse of {@link lerp}: the parameter `t` such that `lerp(a, b, t) === value`.
 * Returns 0 when `a === b`.
 */
export function inverseLerp(a: number, b: number, value: number): number {
  return a === b ? 0 : (value - a) / (b - a);
}

/** Re-map `value` from range `[inMin, inMax]` to `[outMin, outMax]` (unclamped). */
export function remap(
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): number {
  return outMin + (outMax - outMin) * inverseLerp(inMin, inMax, value);
}

/** Hermite smoothstep in `[0, 1]` over the edges `[edge0, edge1]`. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = saturate(inverseLerp(edge0, edge1, x));
  return t * t * (3 - 2 * t);
}

/** Ken Perlin's smootherstep (continuous 2nd derivative) in `[0, 1]`. */
export function smootherstep(edge0: number, edge1: number, x: number): number {
  const t = saturate(inverseLerp(edge0, edge1, x));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Step function: 0 when `x < edge`, else 1. */
export function step(edge: number, x: number): number {
  return x < edge ? 0 : 1;
}

/** Sign of `x` as -1, 0, or 1. */
export function sign(x: number): number {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

/**
 * Wrap `x` into the half-open range `[min, max)`. Handles negative values correctly, unlike a bare
 * `%`. Useful for angles and looping animation time.
 */
export function wrap(x: number, min: number, max: number): number {
  const range = max - min;
  if (range <= 0) return min;
  return ((((x - min) % range) + range) % range) + min;
}

/** Ping-pong `x` back and forth in `[0, length]`. */
export function pingPong(x: number, length: number): number {
  const t = wrap(x, 0, length * 2);
  return length - Math.abs(t - length);
}

/** Whether `a` and `b` are within `tolerance` of each other. */
export function approxEqual(a: number, b: number, tolerance: number = EPSILON): boolean {
  return Math.abs(a - b) <= tolerance;
}

/** True when `x` is a positive power of two. */
export function isPowerOfTwo(x: number): boolean {
  return x > 0 && (x & (x - 1)) === 0;
}

/** Smallest power of two greater than or equal to `x`. */
export function nextPowerOfTwo(x: number): number {
  if (x <= 1) return 1;
  return 2 ** Math.ceil(Math.log2(x));
}

/** Round `x` to a multiple of `increment`. */
export function roundTo(x: number, increment: number): number {
  return Math.round(x / increment) * increment;
}

/** Shortest signed difference between two angles (radians), in `(-pi, pi]`. */
export function deltaAngle(a: number, b: number): number {
  return wrap(b - a + PI, 0, TAU) - PI;
}

/** Interpolate between angles `a` and `b` along the shortest arc (radians). */
export function lerpAngle(a: number, b: number, t: number): number {
  return a + deltaAngle(a, b) * t;
}
