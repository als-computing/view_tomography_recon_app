/**
 * Monte-Carlo sampling for path tracing and stochastic integration: counter-based hashing (for
 * reproducible per-sample/per-pixel randomness), quasi-random low-discrepancy sequences (radical
 * inverse / Halton / Hammersley, with Owen scrambling), importance-sampling transforms (concentric
 * disk, cosine-weighted and uniform hemisphere/sphere, GGX microfacet, uniform triangle), and the
 * multiple-importance-sampling power heuristic.
 *
 * QMC sequences converge far faster than white-noise sampling (error ~ O((log N)ᵈ/N) vs O(1/√N)),
 * which is what makes a progressive path tracer usable at practical sample counts. The counter-based
 * hash gives each pixel/sample/dimension a decorrelated stream without carrying mutable RNG state —
 * the standard approach for GPU-friendly, replayable rendering.
 *
 * All transforms are pure and take canonical uniforms `u ∈ [0, 1)`; direction samplers write into a
 * caller-provided {@link Vec3} (z-up local frame) and return it, matching the package's
 * allocation-conscious out-parameter style.
 *
 * @packageDocumentation
 */

import { Vec2 } from "./vec2.js";
import { Vec3 } from "./vec3.js";

const TAU = Math.PI * 2;
const UINT32_TO_UNIT = 1 / 4294967296;

// ---------------------------------------------------------------------------
// Counter-based hashing
// ---------------------------------------------------------------------------

/**
 * A high-quality integer hash (PCG output permutation) mapping a 32-bit counter to a well-mixed
 * 32-bit result. Use it to derive a decorrelated random stream from indices — e.g.
 * `hashU32(pixel ^ hashU32(sample ^ hashU32(dimension)))` — instead of threading mutable RNG state.
 */
export function hashU32(x: number): number {
  let state = (x >>> 0) * 747796405 + 2891336453;
  state >>>= 0;
  let word = ((state >>> ((state >>> 28) + 4)) ^ state) * 277803737;
  word >>>= 0;
  return ((word >>> 22) ^ word) >>> 0;
}

/** Combine two integer keys into one well-mixed 32-bit hash. */
export function hash2U32(x: number, y: number): number {
  return hashU32((x >>> 0) ^ hashU32(y));
}

/** Map a 32-bit unsigned integer to a float in `[0, 1)`. */
export function uintToUnitFloat(u: number): number {
  return (u >>> 0) * UINT32_TO_UNIT;
}

/** A uniform float in `[0, 1)` derived purely from an integer seed (stateless, reproducible). */
export function randomFromSeed(seed: number): number {
  return uintToUnitFloat(hashU32(seed));
}

// ---------------------------------------------------------------------------
// Quasi-random low-discrepancy sequences
// ---------------------------------------------------------------------------

/**
 * Van der Corput radical inverse of `index` in the given `base`: reflect the base-`base` digits of
 * `index` about the radix point into `[0, 1)`. The building block of Halton/Hammersley sequences.
 */
export function radicalInverse(base: number, index: number): number {
  const invBase = 1 / base;
  let f = invBase;
  let result = 0;
  let i = index >>> 0;
  while (i > 0) {
    result += (i % base) * f;
    i = Math.floor(i / base);
    f *= invBase;
  }
  return result;
}

/** The `index`-th value of the 1-D Halton sequence in `base` (equivalent to {@link radicalInverse}). */
export function halton(index: number, base: number): number {
  return radicalInverse(base, index);
}

/** Reverse the 32 bits of `x` (used for the base-2 radical inverse and Owen scrambling). */
export function reverseBits32(x: number): number {
  let b = x >>> 0;
  b = ((b & 0x55555555) << 1) | ((b >>> 1) & 0x55555555);
  b = ((b & 0x33333333) << 2) | ((b >>> 2) & 0x33333333);
  b = ((b & 0x0f0f0f0f) << 4) | ((b >>> 4) & 0x0f0f0f0f);
  b = ((b & 0x00ff00ff) << 8) | ((b >>> 8) & 0x00ff00ff);
  b = (b << 16) | (b >>> 16);
  return b >>> 0;
}

/**
 * Hammersley point set for a known sample count `count`: `(index/count, radicalInverseBase2(index))`.
 * The lowest-discrepancy 2-D set when the total number of samples is fixed in advance.
 */
export function hammersley2D(index: number, count: number, out: Vec2 = new Vec2()): Vec2 {
  return out.set(index / count, reverseBits32(index) * UINT32_TO_UNIT);
}

/**
 * Nested-uniform (Owen) scramble of a base-2 radical inverse, via the Laine–Karras hash. Decorrelates
 * QMC sample sets per pixel/path while preserving their low-discrepancy stratification, giving
 * blue-noise-like error and eliminating the structured aliasing of an unscrambled sequence.
 */
export function owenScrambledRadicalInverse2(index: number, seed: number): number {
  // Burley's nested-uniform scramble: scrambled_sample = reverse(permute(index)). (Because the
  // sample bits are reverse(index), and a nested scramble is reverse∘permute∘reverse.)
  // Laine–Karras permutation, all arithmetic mod 2³².
  let x = (index + seed) >>> 0;
  x = Math.imul(x, 0x6c50b47c) ^ x;
  x = Math.imul(x, 0xb82f1e52) ^ x;
  x = Math.imul(x, 0xc7afe638) ^ x;
  x = Math.imul(x, 0x8d22f6e6) ^ x;
  x >>>= 0;
  return reverseBits32(x) * UINT32_TO_UNIT;
}

// ---------------------------------------------------------------------------
// Importance-sampling transforms (canonical uniforms → geometry)
// ---------------------------------------------------------------------------

/**
 * Shirley's concentric mapping of `[0,1)²` to a uniform point on the unit disk — lower distortion
 * than the naive polar map, so it preserves stratification for disk/lens and hemisphere sampling.
 */
export function sampleConcentricDisk(u1: number, u2: number, out: Vec2 = new Vec2()): Vec2 {
  const a = 2 * u1 - 1;
  const b = 2 * u2 - 1;
  if (a === 0 && b === 0) return out.set(0, 0);
  let r: number;
  let phi: number;
  if (Math.abs(a) > Math.abs(b)) {
    r = a;
    phi = (Math.PI / 4) * (b / a);
  } else {
    r = b;
    phi = Math.PI / 2 - (Math.PI / 4) * (a / b);
  }
  return out.set(r * Math.cos(phi), r * Math.sin(phi));
}

/** Uniform direction on the unit sphere (solid-angle pdf `1/4π`). */
export function sampleUniformSphere(u1: number, u2: number, out: Vec3 = new Vec3()): Vec3 {
  const z = 1 - 2 * u1;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  const phi = TAU * u2;
  return out.set(r * Math.cos(phi), r * Math.sin(phi), z);
}

/** Uniform direction on the z-up unit hemisphere (solid-angle pdf `1/2π`). */
export function sampleUniformHemisphere(u1: number, u2: number, out: Vec3 = new Vec3()): Vec3 {
  const z = u1;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  const phi = TAU * u2;
  return out.set(r * Math.cos(phi), r * Math.sin(phi), z);
}

/** pdf of {@link sampleUniformHemisphere}. */
export const UNIFORM_HEMISPHERE_PDF = 1 / (2 * Math.PI);

/**
 * Cosine-weighted direction on the z-up unit hemisphere (Malley's method: concentric disk lifted to
 * the hemisphere). The natural importance sample for a Lambertian BRDF; solid-angle pdf `cosθ/π`.
 */
export function sampleCosineHemisphere(u1: number, u2: number, out: Vec3 = new Vec3()): Vec3 {
  const d = sampleConcentricDisk(u1, u2, tmpDisk);
  const z = Math.sqrt(Math.max(0, 1 - d.x * d.x - d.y * d.y));
  return out.set(d.x, d.y, z);
}

/** pdf of {@link sampleCosineHemisphere} for a direction with the given `cosTheta` (≥ 0). */
export function cosineHemispherePdf(cosTheta: number): number {
  return Math.max(0, cosTheta) / Math.PI;
}

/**
 * Sample a microfacet normal (half-vector) from the GGX / Trowbridge–Reitz NDF in the z-up local
 * frame, given roughness `alpha` (perceptual roughness **squared**). Returns the half-vector `h`;
 * pair with {@link ggxPdf} for the corresponding density.
 */
export function sampleGGX(u1: number, u2: number, alpha: number, out: Vec3 = new Vec3()): Vec3 {
  const a2 = alpha * alpha;
  const cosTheta = Math.sqrt(Math.max(0, (1 - u1) / (1 + (a2 - 1) * u1)));
  const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
  const phi = TAU * u2;
  return out.set(sinTheta * Math.cos(phi), sinTheta * Math.sin(phi), cosTheta);
}

/** NDF-sampling pdf (w.r.t. solid angle of the half-vector) for {@link sampleGGX}. */
export function ggxPdf(cosThetaH: number, alpha: number): number {
  if (cosThetaH <= 0) return 0;
  const a2 = alpha * alpha;
  const d = a2 / (Math.PI * (cosThetaH * cosThetaH * (a2 - 1) + 1) ** 2);
  return d * cosThetaH;
}

/**
 * Uniform barycentric coordinates `(b0, b1)` for a point in a triangle (the third is `1 − b0 − b1`),
 * written into `out`. Used to sample area lights and scatter points on meshes.
 */
export function sampleUniformTriangle(u1: number, u2: number, out: Vec2 = new Vec2()): Vec2 {
  const su0 = Math.sqrt(u1);
  return out.set(1 - su0, u2 * su0);
}

/**
 * Multiple-importance-sampling **power heuristic** (β = 2) weight for combining two strategies that
 * drew `nf`/`ng` samples with pdfs `fPdf`/`gPdf`. Reduces variance versus the balance heuristic.
 */
export function powerHeuristic(nf: number, fPdf: number, ng: number, gPdf: number): number {
  const f = nf * fPdf;
  const g = ng * gPdf;
  const f2 = f * f;
  const denom = f2 + g * g;
  return denom > 0 ? f2 / denom : 0;
}

/** Scratch disk sample reused by {@link sampleCosineHemisphere} (module-local, not re-entrant). */
const tmpDisk = new Vec2();
