/**
 * Named colormaps for volume transfer functions (itk-vtk-viewer–style color mapping).
 *
 * @packageDocumentation
 */

/** RGB sample in linear [0, 1]. */
export type Rgb = readonly [number, number, number];

/** A named colormap: `t` in `[0, 1]` → RGB. */
export type ColorMapFn = (t: number) => Rgb;

function lerp3(a: Rgb, b: Rgb, u: number): Rgb {
  return [
    a[0] + (b[0] - a[0]) * u,
    a[1] + (b[1] - a[1]) * u,
    a[2] + (b[2] - a[2]) * u,
  ];
}

function sampleStops(stops: readonly Rgb[], t: number): Rgb {
  const x = Math.min(1, Math.max(0, t));
  const n = stops.length;
  if (n === 0) return [0, 0, 0];
  if (n === 1) return stops[0]!;
  const f = x * (n - 1);
  const i = Math.min(n - 2, Math.floor(f));
  return lerp3(stops[i]!, stops[i + 1]!, f - i);
}

/** Built-in colormap names. */
export type ColorMapName =
  | "grayscale"
  | "bone"
  | "hot"
  | "cool"
  | "viridis"
  | "plasma"
  | "magenta"
  | "cyan";

const MAPS: Record<ColorMapName, readonly Rgb[]> = {
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

/** Sample a named colormap. */
export function sampleColorMap(name: ColorMapName, t: number): Rgb {
  return sampleStops(MAPS[name], t);
}

/** List available colormap names. */
export function colorMapNames(): ColorMapName[] {
  return Object.keys(MAPS) as ColorMapName[];
}
