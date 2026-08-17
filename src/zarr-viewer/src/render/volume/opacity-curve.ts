/**
 * Piecewise opacity curves and composition with colormaps into a {@link TransferFunction}.
 *
 * @packageDocumentation
 */

import { TransferFunction, type TransferStop } from "./transfer-function.js";
import { sampleColorMap, type ColorMapName } from "./colormaps.js";

/** Opacity control point: normalized intensity → opacity. */
export type OpacityPoint = readonly [intensity: number, opacity: number];

/** Options for {@link composeTransferFunction}. */
export interface ComposeTransferFunctionOptions {
  /** Piecewise opacity points in `[0,1]×[0,1]` (sorted by intensity). */
  opacity: readonly OpacityPoint[];
  /** Named colormap for RGB. */
  colorMap?: ColorMapName;
  /**
   * Color window in normalized intensity: intensities outside map to end colors;
   * inside map across the colormap. Default `[0, 1]`.
   */
  colorRange?: readonly [number, number];
  /** Global opacity scale. Default `1`. */
  opacityScale?: number;
  /** LUT sample count when building stops. Default `32`. */
  samples?: number;
  /**
   * Optional intensity remap LUT (e.g. a contrast-limited histogram-equalization CDF), sampled after
   * the color window: the colormap is looked up at `remap(ct)` instead of `ct`. Values in `[0,1]`; any
   * length (linearly interpolated). Omit for the default linear window.
   */
  intensityRemap?: Float32Array;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Interpolate opacity from sorted piecewise points. */
export function sampleOpacity(points: readonly OpacityPoint[], t: number): number {
  if (points.length === 0) return 0;
  const x = clamp01(t);
  if (x <= points[0]![0]) return points[0]![1];
  const last = points[points.length - 1]!;
  if (x >= last[0]) return last[1];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (x >= a[0] && x <= b[0]) {
      const span = b[0] - a[0];
      const u = span > 1e-12 ? (x - a[0]) / span : 0;
      return a[1] + (b[1] - a[1]) * u;
    }
  }
  return last[1];
}

/** Default soft-tissue opacity ramp. */
export const DEFAULT_OPACITY_POINTS: readonly OpacityPoint[] = [
  [0, 0],
  [0.12, 0],
  [0.28, 0.15],
  [0.5, 0.55],
  [0.75, 0.85],
  [1, 0.95],
];

/**
 * Compose a colormap + opacity piecewise function into a {@link TransferFunction}
 * (itk-vtk `setImagePiecewiseFunctionPoints` + color map).
 */
export function composeTransferFunction(
  options: ComposeTransferFunctionOptions,
): TransferFunction {
  const opacityPts = [...options.opacity].sort((a, b) => a[0] - b[0]);
  const map = options.colorMap ?? "bone";
  const [cLo, cHi] = options.colorRange ?? [0, 1];
  const cSpan = Math.max(1e-6, cHi - cLo);
  const scale = options.opacityScale ?? 1;
  const remap = options.intensityRemap;
  const n = Math.max(8, options.samples ?? 32);
  const stops: TransferStop[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    let ct = clamp01((t - cLo) / cSpan);
    if (remap && remap.length > 1) ct = sampleLut(remap, ct);
    const [r, g, b] = sampleColorMap(map, ct);
    const a = clamp01(sampleOpacity(opacityPts, t) * scale);
    stops.push({ position: t, color: [r, g, b, a] });
  }
  return new TransferFunction(stops);
}

/** Sample a normalized-domain LUT at x in [0,1] with linear interpolation. */
function sampleLut(lut: Float32Array, x: number): number {
  const f = clamp01(x) * (lut.length - 1);
  const i = Math.floor(f);
  if (i >= lut.length - 1) return lut[lut.length - 1]!;
  return lut[i]! + (lut[i + 1]! - lut[i]!) * (f - i);
}

/** Move / insert an opacity point; keeps intensity sorted and clamped. */
export function setOpacityPoint(
  points: readonly OpacityPoint[],
  index: number,
  intensity: number,
  opacity: number,
): OpacityPoint[] {
  const next = points.map((p) => [...p] as [number, number]);
  if (index < 0 || index >= next.length) {
    next.push([clamp01(intensity), clamp01(opacity)]);
  } else {
    next[index] = [clamp01(intensity), clamp01(opacity)];
  }
  next.sort((a, b) => a[0] - b[0]);
  return next;
}
