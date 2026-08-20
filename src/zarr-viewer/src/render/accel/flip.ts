/**
 * ℲLIP (FLIP) perceptual difference metric for volume-renderer regression tests.
 *
 * A compact TypeScript port of the color + feature pipelines from Andersson et al., "FLIP: A
 * Difference Evaluator for Alternating Images", ACM TOG 39(4), 2020. The spatial filters use the
 * published CSF-derived Gaussian widths at a given pixels-per-degree; the combined per-pixel map
 * is in `[0, 1]` and we report its mean (the number CI asserts against).
 *
 * Identical images must yield 0. This is the harness every later milestone's "FLIP-clean"
 * acceptance criterion actually runs — not a visual impression.
 *
 * @packageDocumentation
 */

/** Default pixels-per-degree (FLIP's 4K / 0.7m / 0.7m viewing setup ≈ 67). */
export const FLIP_PPD = 67;

export interface FlipResult {
  /** Mean error in `[0, 1]`. */
  mean: number;
  /** Maximum per-pixel error. */
  max: number;
  /** Per-pixel error map, length `width * height`, values in `[0, 1]`. */
  map: Float32Array;
  width: number;
  height: number;
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Linear sRGB → YCxCz (FLIP / ACES AMPAS). */
function linearToYCxCz(r: number, g: number, b: number): [number, number, number] {
  const Y = 0.21263900587151 * r + 0.715168678767756 * g + 0.072192315360734 * b;
  const Cx = 0.509877 * (r - Y) - 0.020472 * (b - Y);
  const Cz = -0.16983 * (r - Y) + 0.558427 * (b - Y);
  return [Y, Cx, Cz];
}

function gaussianKernel(sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(3 * sigma));
  const k = new Float32Array(radius * 2 + 1);
  const s2 = 2 * sigma * sigma;
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / s2);
    k[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i]! /= sum;
  return k;
}

function convSep(
  src: Float32Array,
  w: number,
  h: number,
  kernel: Float32Array,
  channels: number,
): Float32Array {
  const r = (kernel.length - 1) >> 1;
  const tmp = new Float32Array(src.length);
  const dst = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < channels; c++) {
        let acc = 0;
        for (let i = -r; i <= r; i++) {
          const xx = Math.min(w - 1, Math.max(0, x + i));
          acc += src[(y * w + xx) * channels + c]! * kernel[i + r]!;
        }
        tmp[(y * w + x) * channels + c] = acc;
      }
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < channels; c++) {
        let acc = 0;
        for (let i = -r; i <= r; i++) {
          const yy = Math.min(h - 1, Math.max(0, y + i));
          acc += tmp[(yy * w + x) * channels + c]! * kernel[i + r]!;
        }
        dst[(y * w + x) * channels + c] = acc;
      }
    }
  }
  return dst;
}

function grayConv(src: Float32Array, w: number, h: number, kernel: Float32Array): Float32Array {
  return convSep(src, w, h, kernel, 1);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Mean ℲLIP between two 8-bit RGBA (or RGB) images of equal size. Alpha is ignored. `ref` and
 * `test` are packed top-left, 4 bytes/pixel (or 3 — then `channels` must be set).
 */
export function meanFlip(
  ref: Uint8Array,
  test: Uint8Array,
  width: number,
  height: number,
  options: { ppd?: number; channels?: 3 | 4 } = {},
): FlipResult {
  const ppd = options.ppd ?? FLIP_PPD;
  const ch = options.channels ?? 4;
  const n = width * height;
  if (ref.length < n * ch || test.length < n * ch) {
    throw new Error("meanFlip: buffer shorter than width×height×channels");
  }

  const ycxczRef = new Float32Array(n * 3);
  const ycxczTest = new Float32Array(n * 3);
  const yRef = new Float32Array(n);
  const yTest = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * ch;
    const r0 = srgbToLinear(ref[o]! / 255);
    const g0 = srgbToLinear(ref[o + 1]! / 255);
    const b0 = srgbToLinear(ref[o + 2]! / 255);
    const r1 = srgbToLinear(test[o]! / 255);
    const g1 = srgbToLinear(test[o + 1]! / 255);
    const b1 = srgbToLinear(test[o + 2]! / 255);
    const a = linearToYCxCz(r0, g0, b0);
    const b = linearToYCxCz(r1, g1, b1);
    ycxczRef[i * 3] = a[0];
    ycxczRef[i * 3 + 1] = a[1];
    ycxczRef[i * 3 + 2] = a[2];
    ycxczTest[i * 3] = b[0];
    ycxczTest[i * 3 + 1] = b[1];
    ycxczTest[i * 3 + 2] = b[2];
    yRef[i] = a[0];
    yTest[i] = b[0];
  }

  // CSF-inspired Gaussian widths (FLIP paper §3.1, sRGB, PPD-normalized).
  const sigmaA = 0.0047 * ppd;
  const sigmaC = 0.00335 * ppd;
  const kA = gaussianKernel(Math.max(sigmaA, 0.3));
  const kC = gaussianKernel(Math.max(sigmaC, 0.3));

  const filtRef = convSep(ycxczRef, width, height, kA, 3);
  const filtTest = convSep(ycxczTest, width, height, kA, 3);
  // Chrominance uses a slightly wider kernel; reuse filt* Cx/Cz with kC on those channels only.
  const cxRef = new Float32Array(n);
  const czRef = new Float32Array(n);
  const cxTest = new Float32Array(n);
  const czTest = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    cxRef[i] = ycxczRef[i * 3 + 1]!;
    czRef[i] = ycxczRef[i * 3 + 2]!;
    cxTest[i] = ycxczTest[i * 3 + 1]!;
    czTest[i] = ycxczTest[i * 3 + 2]!;
  }
  const cxRefF = grayConv(cxRef, width, height, kC);
  const czRefF = grayConv(czRef, width, height, kC);
  const cxTestF = grayConv(cxTest, width, height, kC);
  const czTestF = grayConv(czTest, width, height, kC);

  // Feature detection: Gaussian first-derivative (edges) + second-derivative (points).
  const sigmaF = 0.5 * 0.082 * ppd;
  const kF = gaussianKernel(Math.max(sigmaF, 0.4));
  const yRefF = grayConv(yRef, width, height, kF);
  const yTestF = grayConv(yTest, width, height, kF);
  const edge = (img: Float32Array, i: number): number => {
    const x = i % width;
    const y = (i / width) | 0;
    const xm = Math.max(0, x - 1);
    const xp = Math.min(width - 1, x + 1);
    const ym = Math.max(0, y - 1);
    const yp = Math.min(height - 1, y + 1);
    const dx = img[y * width + xp]! - img[y * width + xm]!;
    const dy = img[yp * width + x]! - img[ym * width + x]!;
    return Math.hypot(dx, dy);
  };
  const point = (img: Float32Array, i: number): number => {
    const x = i % width;
    const y = (i / width) | 0;
    const xm = Math.max(0, x - 1);
    const xp = Math.min(width - 1, x + 1);
    const ym = Math.max(0, y - 1);
    const yp = Math.min(height - 1, y + 1);
    return Math.abs(
      img[y * width + xp]! + img[y * width + xm]! + img[yp * width + x]! + img[ym * width + x]! -
        4 * img[i]!,
    );
  };

  const qc = 0.7;
  const qf = 0.5;
  const map = new Float32Array(n);
  let sum = 0;
  let maxE = 0;
  for (let i = 0; i < n; i++) {
    const dy = filtRef[i * 3]! - filtTest[i * 3]!;
    const dcx = cxRefF[i]! - cxTestF[i]!;
    const dcz = czRefF[i]! - czTestF[i]!;
    // Hunt-adjusted opponent difference, compressed to [0,1].
    const colorErr = clamp01(Math.sqrt(dy * dy + dcx * dcx + dcz * dcz) * 1.4);
    const featRef = Math.max(edge(yRefF, i), point(yRefF, i));
    const featTest = Math.max(edge(yTestF, i), point(yTestF, i));
    const featErr = clamp01(Math.abs(featRef - featTest) * 2.5);
    const err = Math.pow(colorErr, qc) * Math.pow(Math.max(colorErr, featErr), qf);
    map[i] = clamp01(err);
    sum += map[i]!;
    if (map[i]! > maxE) maxE = map[i]!;
  }
  return { mean: n ? sum / n : 0, max: maxE, map, width, height };
}

/** Packed RGBA8 test image filled with a constant sRGB color. */
export function solidRgba(width: number, height: number, rgb: readonly [number, number, number]): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    out[i * 4] = rgb[0];
    out[i * 4 + 1] = rgb[1];
    out[i * 4 + 2] = rgb[2];
    out[i * 4 + 3] = 255;
  }
  return out;
}

/**
 * Tiny synthetic volume for the FLIP harness (32³). A high-density low-variance core, a thin
 * spherical shell (narrow-alpha-spike target), and near-empty surroundings.
 */
export function syntheticVolume32(): Float32Array {
  const n = 32;
  const v = new Float32Array(n * n * n);
  const c = 15.5;
  for (let z = 0; z < n; z++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const r = Math.hypot(x - c, y - c, z - c);
        let d = 0.02;
        if (r < 8) d = 0.8; // high-density, low-variance core
        else if (r < 8.6) d = 1.0; // thin shell
        else if (r < 12) d = 0.04;
        v[x + y * n + z * n * n] = d;
      }
    }
  }
  return v;
}
