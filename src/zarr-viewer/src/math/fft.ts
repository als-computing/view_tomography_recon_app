/**
 * Radix-2 Cooley–Tukey fast Fourier transform for power-of-two lengths, operating in place on
 * separate real/imaginary `Float64Array`s. The substrate for spectral methods: ocean/turbulence
 * spectra, Ewald/PME long-range forces, convolution, and frequency-domain filtering.
 *
 * @packageDocumentation
 */

import { isPowerOfTwo } from "./scalar.js";

/** In-place bit-reversal permutation of paired real/imaginary arrays of length `n`. */
function bitReverse(re: Float64Array, im: Float64Array, n: number): void {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }
}

/**
 * In-place forward FFT. `re`/`im` must have equal, power-of-two length. After the call they hold the
 * unnormalized transform (so `ifft(fft(x)) = x`).
 *
 * @throws {RangeError} if lengths differ or are not a power of two.
 */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (im.length !== n) throw new RangeError("fft: real and imaginary arrays must match in length");
  if (!isPowerOfTwo(n)) throw new RangeError("fft: length must be a power of two");
  bitReverse(re, im, n);
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wLenRe = Math.cos(ang);
    const wLenIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const uRe = re[a]!;
        const uIm = im[a]!;
        const vRe = re[b]! * wRe - im[b]! * wIm;
        const vIm = re[b]! * wIm + im[b]! * wRe;
        re[a] = uRe + vRe;
        im[a] = uIm + vIm;
        re[b] = uRe - vRe;
        im[b] = uIm - vIm;
        const nextWRe = wRe * wLenRe - wIm * wLenIm;
        wIm = wRe * wLenIm + wIm * wLenRe;
        wRe = nextWRe;
      }
    }
  }
}

/**
 * In-place inverse FFT (normalized by `1/n`), computed via the conjugation identity
 * `IFFT(x) = conj(FFT(conj(x))) / n`.
 *
 * @throws {RangeError} if lengths differ or are not a power of two.
 */
export function ifft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (im.length !== n) throw new RangeError("ifft: real and imaginary arrays must match in length");
  for (let i = 0; i < n; i++) im[i] = -im[i]!;
  fft(re, im);
  const inv = 1 / n;
  for (let i = 0; i < n; i++) {
    re[i] = re[i]! * inv;
    im[i] = -im[i]! * inv;
  }
}

/**
 * Convenience forward FFT of a real signal: returns freshly-allocated `re`/`im` spectra. The input
 * is not modified.
 */
export function fftReal(input: ArrayLike<number>): { re: Float64Array; im: Float64Array } {
  const n = input.length;
  const re = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = input[i]!;
  const im = new Float64Array(n);
  fft(re, im);
  return { re, im };
}
