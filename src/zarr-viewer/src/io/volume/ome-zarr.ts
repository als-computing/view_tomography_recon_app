/**
 * OME-Zarr (OME-NGFF) reader: opens a multiscale image pyramid and exposes it as a
 * {@link VolumeSource}, honoring axes and coordinate transforms so large tomography volumes
 * stream at an appropriate level of detail. Voxel spacing is converted to SI meters via
 * `@zarr-viewer/core` units.
 *
 * @packageDocumentation
 */

import { units } from "@zarr-viewer/core";
import type { Store } from "./zarr/store.js";
import { readGroupAttrs, readArrayMeta } from "./zarr/metadata.js";
import { openZarrArrayFromMeta, estimateValueRange, padValueRange } from "./zarr/array.js";
import { DecodedChunkCache } from "./chunk-cache.js";
import type { VolumeChunk, VolumeDType, VolumeSource } from "./volume-source.js";

/** Options for {@link openOmeZarr}. */
export interface OpenOmeZarrOptions {
  /** Override value range (otherwise estimated from the coarsest level). */
  valueRange?: readonly [number, number];
  /** Skip range estimation (use `[0,1]`). */
  skipRangeEstimate?: boolean;
}

interface LevelInfo {
  path: string;
  /** Dimensions in x,y,z. */
  dimensions: readonly [number, number, number];
  /** Spacing in SI meters (x,y,z). */
  spacing: readonly [number, number, number];
  /**
   * Per-level translation from `coordinateTransformations`, in SI meters (x,y,z) - parsed and kept so
   * it isn't silently lost, but **not yet applied anywhere**: the renderer today assumes every level
   * shares one identical world box (`WebGpuVolumeViewer.ts`'s `boxHalf`/`sizeSim`, set once from
   * level 0 and reused unchanged for whichever level is currently displayed), so per-level translation
   * has nowhere to plug in without that geometry model changing too - a real, separate, larger piece of
   * work (see the `indexToPhysicalAt`/`physicalToIndexAt` composed-transform idea in the Zarr I/O
   * backlog section of the plan file) than this pass's "stop silently discarding the value" fix.
   * `[0,0,0]` when the level declares no translation (the common case for every dataset in this app
   * today) or none is present in its `coordinateTransformations`.
   */
  translation: readonly [number, number, number];
  source: VolumeSource;
}

function axisToXyz(axes: Array<{ name?: string }>): [number, number, number] {
  const names = axes.map((a) => String(a.name ?? "").toLowerCase());
  const ix = names.indexOf("x");
  const iy = names.indexOf("y");
  const iz = names.indexOf("z");
  if (ix < 0 || iy < 0 || iz < 0) {
    // Assume already x,y,z or z,y,x last-three spatial.
    if (names.length >= 3 && names[names.length - 3] === "z") {
      return [2, 1, 0]; // disk z,y,x → xyz
    }
    return [0, 1, 2];
  }
  // axisToXyz[outAxis] = diskAxisIndex
  return [ix, iy, iz];
}

function scaleTranslation(
  transforms: unknown,
): { scale: number[] | undefined; translation: number[] | undefined } {
  let scale: number[] | undefined;
  let translation: number[] | undefined;
  if (!Array.isArray(transforms)) return { scale, translation };
  for (const t of transforms) {
    if (!t || typeof t !== "object") continue;
    const o = t as Record<string, unknown>;
    if (o.type === "scale" && Array.isArray(o.scale)) scale = o.scale.map(Number);
    if (o.type === "translation" && Array.isArray(o.translation)) {
      translation = o.translation.map(Number);
    }
  }
  return { scale, translation };
}

class OmeZarrVolumeSource implements VolumeSource {
  public readonly dimensions: readonly [number, number, number];
  public readonly spacing: readonly [number, number, number];
  public readonly dtype: VolumeDType;
  public readonly valueRange: readonly [number, number];
  public readonly levelCount: number;
  public readonly spacingUnitName: string;
  public readonly name: string;

  private readonly levels: LevelInfo[];

  public constructor(
    levels: LevelInfo[],
    dtype: VolumeDType,
    valueRange: readonly [number, number],
    spacingUnitName: string,
    name: string,
  ) {
    this.levels = levels;
    this.levelCount = levels.length;
    this.dimensions = levels[0]!.dimensions;
    this.spacing = levels[0]!.spacing;
    this.dtype = dtype;
    this.valueRange = valueRange;
    this.spacingUnitName = spacingUnitName;
    this.name = name;
  }

  public dimensionsAt(level: number): readonly [number, number, number] {
    return this.level(level).dimensions;
  }

  public spacingAt(level: number): readonly [number, number, number] {
    return this.level(level).spacing;
  }

  /** Per-level NGFF `translation`, in SI meters (x,y,z) — not part of the shared {@link VolumeSource}
   * interface (other implementors have no NGFF-translation concept), and not yet consumed by the
   * renderer's own geometry model (see {@link LevelInfo.translation}'s doc comment). Exposed here so
   * the parsed value is genuinely retrievable instead of a dead end once wiring it in becomes real work. */
  public translationAt(level: number): readonly [number, number, number] {
    return this.level(level).translation;
  }

  private level(level: number): LevelInfo {
    if (level < 0 || level >= this.levels.length) {
      throw new Error(`OME-Zarr level ${level} out of range 0..${this.levels.length - 1}`);
    }
    return this.levels[level]!;
  }

  public readChunk(level: number, x: number, y: number, z: number): Promise<VolumeChunk> {
    return this.level(level).source.readChunk(0, x, y, z);
  }

  public chunks(level: number): AsyncIterable<VolumeChunk> {
    return this.level(level).source.chunks(0);
  }

  public readRegion(
    level: number,
    voxelMin: readonly [number, number, number],
    voxelMax: readonly [number, number, number],
    signal?: AbortSignal,
  ): AsyncIterable<VolumeChunk> {
    return this.level(level).source.readRegion(0, voxelMin, voxelMax, signal);
  }

  public regionChunkCount(
    level: number,
    voxelMin: readonly [number, number, number],
    voxelMax: readonly [number, number, number],
  ): number {
    return this.level(level).source.regionChunkCount(0, voxelMin, voxelMax);
  }
}

/**
 * Open an OME-Zarr group as a multiscale {@link VolumeSource}.
 *
 * Spacing from NGFF `coordinateTransformations` is converted to SI meters using axis unit names
 * (e.g. `"micrometer"` → {@link units.micrometer}).
 *
 * @example
 * ```ts
 * const src = await openOmeZarr(httpStore(url));
 * console.log(src.levelCount, src.dimensions, src.spacing);
 * ```
 */
export async function openOmeZarr(
  store: Store,
  options: OpenOmeZarrOptions = {},
): Promise<VolumeSource> {
  const attrs = await readGroupAttrs(store, "");
  const multiscales = attrs.multiscales;
  if (!Array.isArray(multiscales) || multiscales.length === 0) {
    throw new Error("openOmeZarr: missing multiscales in root .zattrs");
  }
  const ms = multiscales[0] as Record<string, unknown>;
  const axes = (ms.axes as Array<{ name?: string; type?: string; unit?: string }>) ?? [];
  const datasets = ms.datasets as Array<{
    path: string;
    coordinateTransformations?: unknown;
  }>;
  if (!Array.isArray(datasets) || datasets.length === 0) {
    throw new Error("openOmeZarr: multiscales[0].datasets missing");
  }

  const spatialAxes = axes.filter((a) => (a.type ?? "space") === "space" || ["x", "y", "z"].includes(String(a.name).toLowerCase()));
  const unitName =
    spatialAxes.find((a) => a.unit)?.unit ??
    axes.find((a) => a.unit)?.unit ??
    "micrometer";
  const lengthUnit = units.resolveLengthUnit(unitName) ?? units.micrometer;
  const axisMap = axisToXyz(axes.length ? axes : [{ name: "z" }, { name: "y" }, { name: "x" }]);

  // Fetch every level's .zarray in parallel (previously sequential, and previously fetched twice per
  // level: once here, once more inside openZarrArray - now fetched once, up front, then handed to the
  // sync openZarrArrayFromMeta below). For a 4-5 level pyramid this turns N sequential round-trip
  // latencies into ~1.
  const metas = await Promise.all(datasets.map((ds) => readArrayMeta(store, String(ds.path))));

  const levels: LevelInfo[] = [];
  let dtype: VolumeDType = "float32";
  // One decoded-chunk cache shared across every level of this pyramid (previously each level's
  // ZarrArraySource got its own independent instance/budget) — a whole-level scan of one level and an
  // overlapping ROI brick read of another level's chunk never collide (chunk keys embed the level's own
  // store path), so sharing is safe, and it also dedupes concurrent in-flight fetches for the exact same
  // chunk (e.g. two overlapping ROI requests) instead of each paying for its own fetch + decode.
  const sharedCache = new DecodedChunkCache();

  for (let i = 0; i < datasets.length; i++) {
    const ds = datasets[i]!;
    const path = String(ds.path);
    const meta = metas[i]!;
    dtype = meta.dtype;
    const { scale, translation } = scaleTranslation(ds.coordinateTransformations);

    // NGFF scale/translation are in axis order (same as array axes). Convert to xyz SI meters.
    const diskScale = scale ?? meta.shape.map(() => 1);
    const spacingXyz: [number, number, number] = [
      lengthUnit.toSI(diskScale[axisMap[0]] ?? 1),
      lengthUnit.toSI(diskScale[axisMap[1]] ?? 1),
      lengthUnit.toSI(diskScale[axisMap[2]] ?? 1),
    ];
    const diskTranslation = translation ?? meta.shape.map(() => 0);
    const translationXyz: [number, number, number] = [
      lengthUnit.toSI(diskTranslation[axisMap[0]] ?? 0),
      lengthUnit.toSI(diskTranslation[axisMap[1]] ?? 0),
      lengthUnit.toSI(diskTranslation[axisMap[2]] ?? 0),
    ];
    const dimsXyz: [number, number, number] = [
      meta.shape[axisMap[0]] ?? 1,
      meta.shape[axisMap[1]] ?? 1,
      meta.shape[axisMap[2]] ?? 1,
    ];

    const source = openZarrArrayFromMeta(store, meta, {
      spacing: spacingXyz,
      axisToXyz: axisMap,
      spacingUnitName: unitName,
      valueRange: options.valueRange ?? [0, 1],
      sharedCache,
    });

    levels.push({ path, dimensions: dimsXyz, spacing: spacingXyz, translation: translationXyz, source });
  }

  let valueRange: readonly [number, number] = options.valueRange ?? [0, 1];
  if (!options.valueRange && !options.skipRangeEstimate) {
    const coarse = levels.length - 1;
    // Widened (see padValueRange's doc comment): the coarsest-level scan below is exact for that
    // level, but real finer-level values routinely fall outside it (box-filter downsampling
    // compresses variance) and would otherwise hard-clamp on upload — most visibly, a real region
    // reads as exactly empty and vanishes.
    valueRange = padValueRange(await estimateValueRange(levels[coarse]!.source, 0));
    // Propagate range onto level sources by re-wrapping — OmeZarrVolumeSource holds the range.
  }

  return new OmeZarrVolumeSource(
    levels,
    dtype,
    valueRange,
    unitName,
    String(ms.name ?? "image"),
  );
}
