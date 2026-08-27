/**
 * Auto-contrast helpers operating on the normalized `[0, 1]` intensity histogram: percentile
 * auto-windowing and contrast-limited (global) histogram equalization.
 *
 * @packageDocumentation
 */

/**
 * Percentile auto-window (matches Seg Studio stretch.ts, default 2-98%). Bin 0 is skipped: volume
 * upload zero-fills empty voxels, piling background mass into bin 0 which would bias the low
 * percentile. Returns `fallback` unchanged if the histogram (excluding bin 0) is empty.
 */
export function autoWindow(
  hist: Float32Array,
  fallback: readonly [number, number],
  loP = 0.02,
  hiP = 0.98,
): [number, number] {
  const n = hist.length;
  let total = 0;
  for (let i = 1; i < n; i++) total += hist[i]!;
  if (total <= 0) return [fallback[0], fallback[1]];
  const loT = total * loP;
  const hiT = total * hiP;
  let loBin = 1;
  let hiBin = n - 1;
  let cum = 0;
  for (let i = 1; i < n; i++) {
    cum += hist[i]!;
    if (cum >= loT) { loBin = i; break; }
  }
  cum = 0;
  for (let i = 1; i < n; i++) {
    cum += hist[i]!;
    if (cum >= hiT) { hiBin = i; break; }
  }
  let lo = loBin / n;
  let hi = hiBin / n;
  if (hi - lo < 0.02) {
    const mid = (lo + hi) / 2;
    lo = Math.max(0, mid - 0.01);
    hi = Math.min(1, mid + 0.01);
  }
  return [lo, hi];
}

/**
 * Contrast-limited (global) histogram equalization → a normalized CDF remap LUT. Bins are clipped to
 * `clip`×mean and the excess redistributed (OpenCV-style), background bin 0 ignored.
 */
export function buildEqualizeRemap(hist: Float32Array, clip: number): Float32Array {
  const n = hist.length;
  const work = new Float32Array(n);
  let total = 0;
  for (let i = 1; i < n; i++) { work[i] = hist[i]!; total += hist[i]!; }
  const lut = new Float32Array(n);
  if (total <= 0) {
    for (let i = 0; i < n; i++) lut[i] = i / (n - 1);
    return lut;
  }
  const mean = total / (n - 1);
  const limit = Math.max(mean, clip * mean);
  let excess = 0;
  for (let i = 1; i < n; i++) if (work[i]! > limit) { excess += work[i]! - limit; work[i] = limit; }
  const add = excess / (n - 1);
  let sum = 0;
  for (let i = 1; i < n; i++) { work[i] = work[i]! + add; sum += work[i]!; }
  let cum = 0;
  for (let i = 0; i < n; i++) { cum += work[i]!; lut[i] = sum > 0 ? cum / sum : i / (n - 1); }
  return lut;
}

/** Move each bin's mass to its remapped position → the displayed (equalized) histogram. */
export function rebinThroughRemap(hist: Float32Array, remap: Float32Array): Float32Array {
  const n = hist.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const dst = Math.min(n - 1, Math.max(0, Math.round(remap[i]! * (n - 1))));
    out[dst] += hist[i]!;
  }
  return out;
}
