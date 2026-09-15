/**
 * Transfer functions map scalar volume values to color + opacity for direct volume rendering. They
 * are the primary knob for revealing structure in tomography/ptychography data.
 *
 * @packageDocumentation
 */

import type { Color4 } from "@zarr-viewer/math";

/** A single control point: normalized scalar position -> RGBA. */
export interface TransferStop {
  /** Position in [0, 1] across the value range. */
  position: number;
  /** Linear RGBA (`Color4` / `Vec4`: x=r, y=g, z=b, w=a). */
  color: Color4;
}

/** Options for {@link windowLevelTransferFunction}. */
export interface WindowLevelOptions {
  /**
   * Normalized window center in `[0, 1]` (relative to the volume `valueRange` after upload
   * normalization). Default `0.5`.
   */
  center?: number;
  /** Normalized window width in `(0, 1]`. Default `0.35`. */
  width?: number;
  /** Peak opacity inside the window. Default `0.85`. */
  opacity?: number;
  /** Soft edge as a fraction of `width` (0 = hard, 0.5 = wide ramp). Default `0.25`. */
  softness?: number;
  /** RGB tint inside the window. Default warm tissue tone. */
  color?: readonly [number, number, number];
}

/**
 * Build a radiology-style window/level transfer function in normalized density space `[0, 1]`.
 * Outside the window opacity is 0; inside it ramps to `opacity` with optional soft shoulders.
 *
 * @example
 * ```ts
 * const tf = windowLevelTransferFunction({ center: 0.45, width: 0.3, opacity: 0.7 });
 * volumeRenderer.setTransferFunction(tf);
 * ```
 */
export function windowLevelTransferFunction(options: WindowLevelOptions = {}): TransferFunction {
  const center = clamp01(options.center ?? 0.5);
  const width = Math.min(1, Math.max(1e-4, options.width ?? 0.35));
  const opacity = clamp01(options.opacity ?? 0.85);
  const soft = clamp01(options.softness ?? 0.25);
  const [r, g, b] = options.color ?? ([0.95, 0.82, 0.68] as const);

  const half = width * 0.5;
  const lo = clamp01(center - half);
  const hi = clamp01(center + half);
  const edge = Math.max(1e-4, (hi - lo) * soft);

  const stops: TransferStop[] = [
    { position: 0, color: [r, g, b, 0] },
    { position: Math.max(0, lo - 1e-4), color: [r * 0.2, g * 0.2, b * 0.25, 0] },
    { position: lo, color: [r * 0.4, g * 0.35, b * 0.3, 0] },
    { position: clamp01(lo + edge), color: [r * 0.75, g * 0.65, b * 0.5, opacity * 0.35] },
    { position: clamp01((lo + hi) * 0.5), color: [r, g, b, opacity] },
    { position: clamp01(hi - edge), color: [r, g * 0.95, b * 0.9, opacity * 0.55] },
    { position: hi, color: [r * 0.9, g * 0.9, b * 0.95, 0.02] },
    { position: Math.min(1, hi + 1e-4), color: [1, 1, 1, 0] },
    { position: 1, color: [1, 1, 1, 0] },
  ];
  return new TransferFunction(stops);
}

/**
 * Map a data-space window `[low, high]` through a volume `valueRange` into normalized
 * `{ center, width }` for {@link windowLevelTransferFunction}.
 */
export function normalizeWindowLevel(
  low: number,
  high: number,
  valueRange: readonly [number, number],
): { center: number; width: number } {
  const [vmin, vmax] = valueRange;
  const span = vmax - vmin || 1;
  const a = (Math.min(low, high) - vmin) / span;
  const b = (Math.max(low, high) - vmin) / span;
  const lo = clamp01(a);
  const hi = clamp01(b);
  return { center: (lo + hi) * 0.5, width: Math.max(1e-4, hi - lo) };
}

/**
 * A piecewise-linear transfer function baked into a 1D lookup texture.
 *
 * @example
 * ```ts
 * const tf = new TransferFunction([
 *   { position: 0.0, color: [0, 0, 0, 0] },
 *   { position: 1.0, color: [1, 1, 1, 1] },
 * ]);
 * const lut = tf.toLut(256); // Uint8Array length 256*4
 * ```
 */
export class TransferFunction {
  private readonly sorted: TransferStop[];

  /**
   * `rawLut`, when supplied, bakes the LUT directly instead of interpolating `stops` — used by
   * multi-band composition ({@link "./tf-bands.js".composeMultiBandTransferFunction}), where each
   * output sample must look up its owning band independently rather than linearly interpolate across
   * a single global stop list (which would bleed color/opacity across band boundaries). `stops` stays
   * empty (harmless — unused) for a raw-LUT instance.
   */
  public constructor(
    public readonly stops: readonly TransferStop[],
    private readonly rawLut?: (size: number) => Uint8Array,
  ) {
    if (stops.length === 0) {
      this.sorted = [{ position: 0, color: [0, 0, 0, 0] }];
    } else {
      this.sorted = [...stops].sort((a, b) => a.position - b.position);
    }
  }

  /**
   * Bake to an RGBA8 lookup table of `size` entries (length `size * 4`). Values outside the first/
   * last stop clamp; between stops colors are linearly interpolated. Delegates to `rawLut` instead,
   * when this instance was built with one.
   */
  public toLut(size: number): Uint8Array {
    if (this.rawLut) return this.rawLut(size);
    const n = Math.max(2, Math.floor(size));
    const out = new Uint8Array(n * 4);
    const stops = this.sorted;

    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const color = sampleStops(stops, t);
      const o = i * 4;
      out[o + 0] = Math.round(clamp01(color[0]) * 255);
      out[o + 1] = Math.round(clamp01(color[1]) * 255);
      out[o + 2] = Math.round(clamp01(color[2]) * 255);
      out[o + 3] = Math.round(clamp01(color[3]) * 255);
    }
    return out;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function sampleStops(
  stops: readonly TransferStop[],
  t: number,
): readonly [number, number, number, number] {
  if (stops.length === 1) return stops[0]!.color;
  if (t <= stops[0]!.position) return stops[0]!.color;
  const last = stops[stops.length - 1]!;
  if (t >= last.position) return last.color;

  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i]!;
    const b = stops[i + 1]!;
    if (t >= a.position && t <= b.position) {
      const span = b.position - a.position;
      const u = span > 1e-12 ? (t - a.position) / span : 0;
      return [
        a.color[0] + (b.color[0] - a.color[0]) * u,
        a.color[1] + (b.color[1] - a.color[1]) * u,
        a.color[2] + (b.color[2] - a.color[2]) * u,
        a.color[3] + (b.color[3] - a.color[3]) * u,
      ];
    }
  }
  return last.color;
}
