/**
 * Named colormaps for volume transfer functions (itk-vtk-viewer–style color mapping).
 *
 * @packageDocumentation
 */

import { SCIVIS_MAPS, type ColorStop } from "./sciviscolor-maps.js";
import { lerpColor3, type Color3 } from "../../math/color.js";

/** A named colormap: `t` in `[0, 1]` → RGB. */
export type ColorMapFn = (t: number) => Color3;

function sampleStops(stops: readonly Color3[], t: number): Color3 {
  const x = Math.min(1, Math.max(0, t));
  const n = stops.length;
  if (n === 0) return [0, 0, 0];
  if (n === 1) return stops[0]!;
  const f = x * (n - 1);
  const i = Math.min(n - 2, Math.floor(f));
  return lerpColor3([0, 0, 0], stops[i]!, stops[i + 1]!, f - i);
}

/** Built-in (evenly-spaced) colormap names. */
export type BuiltinColorMapName =
  | "grayscale"
  | "bone"
  | "hot"
  | "cool"
  | "viridis"
  | "plasma"
  | "magenta"
  | "cyan";

/**
 * Any selectable colormap name: a built-in or a scraped SciVisColor map ({@link SCIVIS_MAPS}). The
 * `(string & {})` keeps built-in literals autocompleting while still accepting the dynamic SciVis keys.
 */
export type ColorMapName = BuiltinColorMapName | (string & {});

const MAPS: Record<BuiltinColorMapName, readonly Color3[]> = {
  grayscale: [
    [0, 0, 0],
    [1, 1, 1],
  ],
  bone: [
    [0, 0, 0],
    [0.33, 0.33, 0.45],
    [0.66, 0.75, 0.8],
    [1, 1, 0.95],
  ],
  hot: [
    [0, 0, 0],
    [0.7, 0, 0],
    [1, 0.5, 0],
    [1, 1, 0.3],
    [1, 1, 1],
  ],
  cool: [
    [0, 1, 1],
    [0.3, 0.4, 1],
    [1, 0, 1],
  ],
  viridis: [
    [0.267, 0.005, 0.329],
    [0.283, 0.141, 0.458],
    [0.254, 0.265, 0.53],
    [0.207, 0.372, 0.553],
    [0.164, 0.471, 0.558],
    [0.128, 0.567, 0.551],
    [0.134, 0.658, 0.517],
    [0.267, 0.749, 0.441],
    [0.478, 0.821, 0.318],
    [0.741, 0.873, 0.15],
    [0.993, 0.906, 0.144],
  ],
  plasma: [
    [0.05, 0.03, 0.53],
    [0.42, 0.0, 0.66],
    [0.7, 0.15, 0.56],
    [0.9, 0.38, 0.38],
    [0.98, 0.65, 0.15],
    [0.94, 0.98, 0.13],
  ],
  magenta: [
    [0, 0, 0],
    [0.6, 0, 0.45],
    [1, 0.4, 0.85],
  ],
  cyan: [
    [0, 0, 0],
    [0, 0.45, 0.55],
    [0.4, 0.95, 1],
  ],
};

/** Sample a positioned-stop colormap (SciVisColor maps have non-uniform x positions). */
function samplePositioned(stops: readonly ColorStop[], t: number): Color3 {
  const x = Math.min(1, Math.max(0, t));
  const n = stops.length;
  if (n === 0) return [0, 0, 0];
  const first = stops[0]!;
  if (x <= first[0]) return [first[1], first[2], first[3]];
  const last = stops[n - 1]!;
  if (x >= last[0]) return [last[1], last[2], last[3]];
  for (let i = 0; i < n - 1; i++) {
    const a = stops[i]!;
    const b = stops[i + 1]!;
    if (x >= a[0] && x <= b[0]) {
      const span = b[0] - a[0] || 1;
      const u = (x - a[0]) / span;
      return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u];
    }
  }
  return [last[1], last[2], last[3]];
}

/** Sample a named colormap — a built-in (evenly-spaced) or a SciVisColor map (positioned stops). */
export function sampleColorMap(name: ColorMapName, t: number): Color3 {
  const builtin = MAPS[name as BuiltinColorMapName];
  if (builtin) return sampleStops(builtin, t);
  const scivis = SCIVIS_MAPS[name];
  if (scivis) return samplePositioned(scivis, t);
  return sampleStops(MAPS.grayscale, t);
}

/** List available colormap names: built-ins first, then the scraped SciVisColor maps. */
export function colorMapNames(): ColorMapName[] {
  return [...Object.keys(MAPS), ...Object.keys(SCIVIS_MAPS)] as ColorMapName[];
}
