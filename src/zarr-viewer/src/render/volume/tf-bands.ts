/**
 * Multi-band transfer functions: up to {@link MAX_TF_BANDS} independent intensity sub-ranges of the
 * *same* volume's density field, each with its own color map + opacity curve, composed into one LUT.
 * Distinct from (and much simpler than) compositing a second dataset — this recolors different density
 * strata of the volume that's already loaded, entirely client-side, with no GPU/shader changes: the
 * volume shader already samples one continuous 1D `tfTex` LUT by normalized density, so a multi-band
 * TF is just a richer LUT built the same way a single-band one is.
 *
 * @packageDocumentation
 */

import { TransferFunction } from "./transfer-function.js";
import { sampleColorMap, type ColorMapName } from "./colormaps.js";
import { sampleOpacity, type OpacityPoint } from "./opacity-curve.js";

/** Hard cap on simultaneously-defined TF bands. Independent of (numerically coincidental with) the
 * shelved multi-volume `MAX_LAYERS` — this is purely a UI/usability limit, not a GPU binding limit. */
export const MAX_TF_BANDS = 6;

/** One intensity sub-range of the TF domain, with its own palette + opacity curve. */
export interface TfBandConfig {
  /** Band's normalized-intensity sub-range `[loT, hiT] ⊆ [0,1]`, `loT < hiT`. Bands are free to
   * overlap — see {@link composeMultiBandTransferFunction} for how an overlap is resolved. */
  loT: number;
  hiT: number;
  colorMap: ColorMapName;
  /** Opacity piecewise points, evaluated in the band's own *local* `[0,1]` (not the global domain). */
  opacityPoints: readonly OpacityPoint[];
  opacityScale?: number;
  /** `false` hides the band entirely (as if removed) without discarding its settings. Default `true`
   * (unset means "on" — every band predates this field). */
  enabled?: boolean;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Compose up to {@link MAX_TF_BANDS} bands into one {@link TransferFunction}. Bands are independent
 * intensity sub-ranges, but nothing stops the user from overlapping two of them (e.g. while dragging
 * the range slider) — where ranges overlap, every enabled band covering that sample is composited
 * **in `bands` order via standard non-premultiplied alpha "over"**: band 0 is the bottom layer, each
 * later band paints over the accumulated result so far. A band with full opacity in the overlap fully
 * replaces what's under it there; a band with partial opacity blends. This matters because the naive
 * alternative — picking only the *first* matching band — makes band 0 unconditionally block every band
 * layered after it wherever they overlap, which reads as "the first TF is masking the others."
 *
 * A disabled band (`enabled: false`) contributes nothing, as if it were removed. Samples outside every
 * enabled band's range are fully transparent; a sample inside exactly one band is just that band's own
 * color/opacity (compositing over transparent is a no-op), so non-overlapping bands behave exactly as
 * before this changed from first-match to composited.
 *
 * The result carries a raw-LUT baker (see `TransferFunction`'s `rawLut` param) rather than a stop
 * list, so it bakes correctly at whatever `lutSize` the caller later requests — not just the
 * resolution used here.
 */
export function composeMultiBandTransferFunction(bands: readonly TfBandConfig[]): TransferFunction {
  const clipped = bands.slice(0, MAX_TF_BANDS);
  return new TransferFunction([], (size) => bakeMultiBandLut(clipped, size));
}

function bakeMultiBandLut(bands: readonly TfBandConfig[], size: number): Uint8Array {
  const n = Math.max(2, Math.floor(size));
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    // Accumulate premultiplied, then divide back out at the end - the LUT stores straight (non-
    // premultiplied) color+alpha (what a single band always produced), but "over" compositing across
    // multiple bands is only correct to accumulate in premultiplied space.
    let pr = 0;
    let pg = 0;
    let pb = 0;
    let aAcc = 0;
    // Fallback color for the (common) fully-transparent case: a single band's raw color is stored even
    // at alpha=0 (matches composeTransferFunction and avoids texel color = black at the LUT's fade-in/
    // fade-out edges, which would otherwise bleed black into neighboring texels under bilinear filtering).
    let lastR = 0;
    let lastG = 0;
    let lastB = 0;
    for (const band of bands) {
      if (band.enabled === false) continue;
      if (t < band.loT || t > band.hiT) continue;
      const span = Math.max(1e-6, band.hiT - band.loT);
      const localT = clamp01((t - band.loT) / span);
      const [br, bg, bb] = sampleColorMap(band.colorMap, localT);
      const ba = clamp01(sampleOpacity(band.opacityPoints, localT) * (band.opacityScale ?? 1));
      lastR = clamp01(br);
      lastG = clamp01(bg);
      lastB = clamp01(bb);
      // Standard "over" compositing: this band paints on top of whatever's accumulated so far.
      pr = lastR * ba + pr * (1 - ba);
      pg = lastG * ba + pg * (1 - ba);
      pb = lastB * ba + pb * (1 - ba);
      aAcc = ba + aAcc * (1 - ba);
    }
    const o = i * 4;
    if (aAcc > 1e-6) {
      out[o + 0] = Math.round(clamp01(pr / aAcc) * 255);
      out[o + 1] = Math.round(clamp01(pg / aAcc) * 255);
      out[o + 2] = Math.round(clamp01(pb / aAcc) * 255);
    } else {
      out[o + 0] = Math.round(lastR * 255);
      out[o + 1] = Math.round(lastG * 255);
      out[o + 2] = Math.round(lastB * 255);
    }
    out[o + 3] = Math.round(aAcc * 255);
  }
  return out;
}
