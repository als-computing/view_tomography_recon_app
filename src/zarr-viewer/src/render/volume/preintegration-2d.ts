/**
 * Gaussian-extended pre-integration table (Milestone 3.2): extends the 1D cumulative-extinction LUT
 * `T(d) = ∫₀^d α(x) dx` (see `VolumeRenderer.setTransferFunction`'s `tCurve`) to a 2D table indexed by
 * `(density, sigma)`, where `sigma` is a local density-variance-derived blur radius from the mip
 * pyramid. Built by **blurring the TF's alpha curve first, then integrating** — not integrating then
 * blurring the antiderivative, since convolution and definite integration don't commute cleanly at the
 * density-zero boundary. Pure math, no GPU — the resulting flat array is uploaded as a `texture_2d`
 * and sampled bilinearly in WGSL (see `volume-raymarch.ts`'s `preintAvgAlpha`).
 *
 * @packageDocumentation
 */

/**
 * Gaussian-blur `curve` with standard deviation `sigma` (in the same normalized `[0,1]` position
 * units as the curve's domain, so `sigma=0` degrees to the identity). `dd` is the spacing between
 * adjacent curve samples (`1 / (curve.length - 1)`). Clamp-to-edge at the boundaries, matching the
 * eventual hardware texture sampling.
 */
export function gaussianBlur1D(curve: Float32Array, sigma: number, dd: number): Float32Array {
  const n = curve.length;
  const out = new Float32Array(n);
  if (sigma <= 0) {
    out.set(curve);
    return out;
  }
  const sigmaIdx = sigma / dd;
  // Truncate the kernel at 3 sigma (>99.7% of the Gaussian's mass) — negligible error beyond that.
  const radius = Math.max(1, Math.ceil(sigmaIdx * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let weightSum = 0;
  for (let k = -radius; k <= radius; k++) {
    const w = Math.exp(-(k * k) / (2 * sigmaIdx * sigmaIdx));
    kernel[k + radius] = w;
    weightSum += w;
  }
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = Math.min(n - 1, Math.max(0, i + k)); // clamp-to-edge
      acc += curve[j]! * kernel[k + radius]!;
    }
    out[i] = acc / weightSum;
  }
  return out;
}

/**
 * Trapezoidal cumulative integral `T(d) = ∫₀^d curve(x) dx`, matching `VolumeRenderer.
 * setTransferFunction`'s `tCurve` construction exactly (`T[0] = 0`).
 */
export function trapezoidalIntegrate(curve: Float32Array, dd: number): Float32Array {
  const n = curve.length;
  const out = new Float32Array(n);
  let acc = 0;
  let prev = curve[0] ?? 0;
  for (let i = 1; i < n; i++) {
    const cur = curve[i] ?? 0;
    acc += 0.5 * (prev + cur) * dd;
    out[i] = acc;
    prev = cur;
  }
  return out;
}

/**
 * Sigma-axis resolution and range shared with the WGSL side (`volume-raymarch.ts` interpolates
 * `PREINTEGRATION_SIGMA_MAX` into its `SIGMA_MAX` const so the GPU's `v = sigma / SIGMA_MAX` texture
 * coordinate always matches the CPU-built table's row spacing). `PREINTEGRATION_SIGMA_MAX` is the
 * theoretical max standard deviation for density values in `[0,1]` (mean=0.5, all mass split between
 * 0 and 1 → variance 0.25 → sigma 0.5); real tomography data blurs far less than that, but the bound
 * must cover the pathological case so `sigma / SIGMA_MAX` never needs clamping above 1.
 */
export const PREINTEGRATION_SIGMA_MAX = 0.5;
export const PREINTEGRATION_SIGMA_BUCKETS = 32;

/** Uniformly-spaced sigma buckets from 0 to {@link PREINTEGRATION_SIGMA_MAX} (row `s` = `s / (n-1) * max`). */
export function defaultSigmaBuckets(
  count: number = PREINTEGRATION_SIGMA_BUCKETS,
  max: number = PREINTEGRATION_SIGMA_MAX,
): number[] {
  const n = Math.max(1, count);
  return Array.from({ length: n }, (_, i) => (n > 1 ? (i / (n - 1)) * max : 0));
}

/**
 * Build the 2D `(density, sigma)` pre-integration table: for each `sigmaBuckets[s]`, blur
 * `alphaCurve` with that sigma, then trapezoidally integrate. Returns a flat, row-major array of
 * length `sigmaBuckets.length * alphaCurve.length` (row `s` = the integrated curve for
 * `sigmaBuckets[s]`) — the shape a `texture_2d<f32>` upload expects (rows = sigma, columns = density).
 * `sigmaBuckets` must be uniformly spaced for the GPU's hardware-bilinear row lookup to line up with
 * it — use {@link defaultSigmaBuckets} unless deliberately overriding the range/resolution.
 */
export function buildGaussianPreintegrationTable(
  alphaCurve: Float32Array,
  sigmaBuckets: readonly number[],
): Float32Array {
  const n = alphaCurve.length;
  const dd = 1 / Math.max(1, n - 1);
  const out = new Float32Array(sigmaBuckets.length * n);
  for (let s = 0; s < sigmaBuckets.length; s++) {
    const blurred = gaussianBlur1D(alphaCurve, sigmaBuckets[s]!, dd);
    const integrated = trapezoidalIntegrate(blurred, dd);
    out.set(integrated, s * n);
  }
  return out;
}

/**
 * Local density variance from the mip pyramid's `(mean, meanSq)` moments, clamped to `≥0`. At typical
 * tomography densities `mean²` and `meanSq` are nearly equal, so this subtraction is cancellation-
 * prone in low precision — the pyramid is built in `rg32float` specifically so this stays accurate;
 * this function just guards the residual floating-point noise that can still push the result
 * fractionally negative even at full precision.
 */
export function varianceFromMoments(mean: number, meanSq: number): number {
  return Math.max(0, meanSq - mean * mean);
}

/**
 * Bilinear lookup into the flat row-major `(sigma × density)` table `buildGaussianPreintegrationTable`
 * produces, mirroring what a WGSL `textureSampleLevel` call on the uploaded `texture_2d` will do
 * (clamp-to-edge on both axes, exactly like `tfSampler`). `u` indexes the density (column) axis,
 * `v` indexes the sigma (row) axis, both in normalized `[0,1]` texture-coordinate space.
 */
export function sampleBilinear2D(
  table: Float32Array,
  width: number,
  height: number,
  u: number,
  v: number,
): number {
  const fx = Math.min(width - 1, Math.max(0, u * (width - 1)));
  const fy = Math.min(height - 1, Math.max(0, v * (height - 1)));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const v00 = table[y0 * width + x0]!;
  const v10 = table[y0 * width + x1]!;
  const v01 = table[y1 * width + x0]!;
  const v11 = table[y1 * width + x1]!;
  const top = v00 * (1 - tx) + v10 * tx;
  const bottom = v01 * (1 - tx) + v11 * tx;
  return top * (1 - ty) + bottom * ty;
}
