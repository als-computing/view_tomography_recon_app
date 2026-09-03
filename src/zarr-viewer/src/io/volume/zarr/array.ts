/**
 * Open a single Zarr array as a {@link VolumeSource} (one resolution level).
 *
 * @packageDocumentation
 */

import type { Store } from "./store.js";
import { readArrayMeta, type ZarrArrayMeta } from "./metadata.js";
import { codecFromCompressor } from "./codecs.js";
import { DecodedChunkCache } from "../chunk-cache.js";
import {
  dtypeByteSize,
  type VolumeChunk,
  type VolumeDType,
  type VolumeSource,
} from "../volume-source.js";

export interface OpenZarrArrayOptions {
  /** Physical voxel spacing in SI meters (x, y, z). Default `[1,1,1]`. */
  spacing?: readonly [number, number, number];
  /** Axis permutation from on-disk order to x,y,z (default identity). */
  axisToXyz?: readonly [number, number, number];
  /** Declared or estimated value range. */
  valueRange?: readonly [number, number];
  /** Display unit name for spacing (e.g. `"micrometer"`). */
  spacingUnitName?: string;
}

function chunkKey(meta: ZarrArrayMeta, indices: number[]): string {
  const body = indices.join(meta.dimensionSeparator);
  return meta.path ? `${meta.path}/${body}` : body;
}

/** Max concurrent chunk fetches for ROI region reads (bounded so we don't flood the store). */
const READ_REGION_CONCURRENCY = 16;

/**
 * Bounded-concurrency async map: runs `fn` over `items` with at most `concurrency` in flight, yielding
 * each result as it settles (completion order — the ROI upload scatters by chunk origin, so order is
 * irrelevant). Rejections propagate to the consumer; any still-in-flight promises are silenced on early
 * exit (abort/error) so they don't surface as unhandled rejections.
 */
async function* pooledMap<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): AsyncGenerator<R> {
  type Entry = { promise: Promise<Entry>; value: R };
  const executing = new Set<Promise<Entry>>();
  let i = 0;
  const startOne = (): void => {
    const item = items[i++]!;
    const entry = {} as Entry;
    entry.promise = fn(item).then((value) => {
      entry.value = value;
      return entry;
    });
    executing.add(entry.promise);
  };
  try {
    while (i < items.length && executing.size < concurrency) startOne();
    while (executing.size > 0) {
      const entry = await Promise.race(executing);
      executing.delete(entry.promise);
      if (i < items.length) startOne();
      yield entry.value;
    }
  } finally {
    for (const p of executing) void p.catch(() => {});
  }
}

function typedView(buf: ArrayBuffer, dtype: VolumeDType, littleEndian: boolean): ArrayBufferView {
  // Platform is LE; swap if big-endian multi-byte (rare for tomography).
  if (!littleEndian && dtypeByteSize(dtype) > 1) {
    const u8 = new Uint8Array(buf);
    const bpe = dtypeByteSize(dtype);
    for (let i = 0; i < u8.length; i += bpe) {
      for (let j = 0; j < bpe / 2; j++) {
        const a = u8[i + j]!;
        u8[i + j] = u8[i + bpe - 1 - j]!;
        u8[i + bpe - 1 - j] = a;
      }
    }
  }
  switch (dtype) {
    case "uint8":
      return new Uint8Array(buf);
    case "int8":
      return new Int8Array(buf);
    case "uint16":
      return new Uint16Array(buf);
    case "int16":
      return new Int16Array(buf);
    case "uint32":
      return new Uint32Array(buf);
    case "int32":
      return new Int32Array(buf);
    case "float32":
      return new Float32Array(buf);
    case "float64":
      return new Float64Array(buf);
    default:
      return new Uint8Array(buf);
  }
}

function fillBuffer(dtype: VolumeDType, count: number, fill: number): ArrayBufferView {
  switch (dtype) {
    case "float32": {
      const a = new Float32Array(count);
      a.fill(fill);
      return a;
    }
    case "float64": {
      const a = new Float64Array(count);
      a.fill(fill);
      return a;
    }
    case "uint8": {
      const a = new Uint8Array(count);
      a.fill(fill);
      return a;
    }
    case "uint16": {
      const a = new Uint16Array(count);
      a.fill(fill);
      return a;
    }
    default: {
      const a = new Float32Array(count);
      a.fill(fill);
      return a;
    }
  }
}

/**
 * Crop a full-size C-order chunk buffer down to the valid region.
 *
 * Zarr v2 stores edge chunks at the full {@link ZarrArrayMeta.chunks} shape (padding with
 * `fill_value`). Valid voxels are therefore **not** a contiguous byte prefix when a fast axis is
 * truncated — taking `product(validShape)` bytes alone produces stripes/seams on coarse LODs.
 */
function cropCOrderChunk(
  full: ArrayBufferView,
  fullShape: readonly [number, number, number],
  validShape: readonly [number, number, number],
  dtype: VolumeDType,
): ArrayBufferView {
  const [f0, f1, f2] = fullShape;
  const [v0, v1, v2] = validShape;
  if (v0 === f0 && v1 === f1 && v2 === f2) return full;
  const out = fillBuffer(dtype, v0 * v1 * v2, 0);
  const src = full as unknown as ArrayLike<number>;
  const dst = out as unknown as { [i: number]: number };
  for (let i0 = 0; i0 < v0; i0++) {
    for (let i1 = 0; i1 < v1; i1++) {
      for (let i2 = 0; i2 < v2; i2++) {
        const si = i2 + f2 * (i1 + f1 * i0);
        const di = i2 + v2 * (i1 + v1 * i0);
        dst[di] = src[si]!;
      }
    }
  }
  return out;
}

/**
 * Transpose a C-order chunk from on-disk axis order to x,y,z.
 * `axisToXyz[i]` = on-disk axis index that becomes output axis i (0=x,1=y,2=z).
 */
function permuteChunkToXyz(
  data: ArrayBufferView,
  diskShape: readonly [number, number, number],
  axisToXyz: readonly [number, number, number],
  dtype: VolumeDType,
): { shape: [number, number, number]; data: ArrayBufferView } {
  const [d0, d1, d2] = diskShape;
  const outShape: [number, number, number] = [
    diskShape[axisToXyz[0]]!,
    diskShape[axisToXyz[1]]!,
    diskShape[axisToXyz[2]]!,
  ];
  // Identity fast path.
  if (axisToXyz[0] === 0 && axisToXyz[1] === 1 && axisToXyz[2] === 2) {
    return { shape: [d0, d1, d2], data };
  }

  const n = d0 * d1 * d2;
  const src = new Float64Array(n);
  const srcView = data as unknown as ArrayLike<number>;
  for (let i = 0; i < n; i++) src[i] = Number(srcView[i]);

  const outBuf = fillBuffer(dtype, outShape[0] * outShape[1] * outShape[2], 0);
  const outView = outBuf as unknown as { [i: number]: number };

  for (let i0 = 0; i0 < d0; i0++) {
    for (let i1 = 0; i1 < d1; i1++) {
      for (let i2 = 0; i2 < d2; i2++) {
        const disk = [i0, i1, i2] as const;
        const x = disk[axisToXyz[0]]!;
        const y = disk[axisToXyz[1]]!;
        const z = disk[axisToXyz[2]]!;
        const si = i2 + d2 * (i1 + d1 * i0);
        const di = x + outShape[0] * (y + outShape[1] * z);
        outView[di] = src[si]!;
      }
    }
  }
  return { shape: outShape, data: outBuf };
}

class ZarrArraySource implements VolumeSource {
  public readonly dimensions: readonly [number, number, number];
  public readonly spacing: readonly [number, number, number];
  public readonly dtype: VolumeDType;
  public readonly valueRange: readonly [number, number];
  public readonly levelCount = 1;
  public readonly spacingUnitName?: string;

  private readonly meta: ZarrArrayMeta;
  private readonly store: Store;
  private readonly axisToXyz: readonly [number, number, number];
  private readonly codec;
  /** Decoded-chunk LRU so ROI reads / panning reuse chunks instead of re-fetching + re-decoding. */
  private readonly chunkCache = new DecodedChunkCache();

  public constructor(
    store: Store,
    meta: ZarrArrayMeta,
    options: OpenZarrArrayOptions,
  ) {
    this.store = store;
    this.meta = meta;
    this.axisToXyz = options.axisToXyz ?? [0, 1, 2];
    this.codec = codecFromCompressor(meta.compressor);
    this.dtype = meta.dtype;
    this.spacing = options.spacing ?? [1, 1, 1];
    this.spacingUnitName = options.spacingUnitName;
    this.valueRange = options.valueRange ?? [0, 1];

    const disk = meta.shape;
    this.dimensions = [
      disk[this.axisToXyz[0]] ?? 1,
      disk[this.axisToXyz[1]] ?? 1,
      disk[this.axisToXyz[2]] ?? 1,
    ];
  }

  public dimensionsAt(_level: number): readonly [number, number, number] {
    return this.dimensions;
  }

  public spacingAt(_level: number): readonly [number, number, number] {
    return this.spacing;
  }

  private diskChunkCounts(): number[] {
    return this.meta.shape.map((s, i) => Math.ceil(s / this.meta.chunks[i]!));
  }

  public async readChunk(level: number, x: number, y: number, z: number): Promise<VolumeChunk> {
    if (level !== 0) throw new Error("ZarrArraySource has only level 0");
    // Map xyz voxel → disk indices, then to chunk coords.
    const diskVoxel = [0, 0, 0];
    diskVoxel[this.axisToXyz[0]] = x;
    diskVoxel[this.axisToXyz[1]] = y;
    diskVoxel[this.axisToXyz[2]] = z;
    const ci = diskVoxel.map((v, ax) => Math.floor(v / this.meta.chunks[ax]!));
    return this.readDiskChunk(ci);
  }

  /** Intersecting disk-chunk index range `[cLo, cHi]` (inclusive) for an xyz voxel box. */
  private regionChunkRange(
    voxelMin: readonly [number, number, number],
    voxelMax: readonly [number, number, number],
  ): { cLo: number[]; cHi: number[] } {
    // Map the xyz voxel box → disk-axis voxel box, then to the intersecting disk chunk range.
    const diskMin = [0, 0, 0];
    const diskMax = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const ax = this.axisToXyz[i]!;
      diskMin[ax] = voxelMin[i]!;
      diskMax[ax] = voxelMax[i]!;
    }
    const counts = this.diskChunkCounts();
    const cLo = [0, 0, 0];
    const cHi = [0, 0, 0];
    for (let ax = 0; ax < 3; ax++) {
      const chunk = this.meta.chunks[ax]!;
      cLo[ax] = Math.max(0, Math.floor(diskMin[ax]! / chunk));
      cHi[ax] = Math.min((counts[ax] ?? 1) - 1, Math.floor((Math.max(diskMax[ax]!, diskMin[ax]! + 1) - 1) / chunk));
    }
    return { cLo, cHi };
  }

  private regionChunkIndices(
    voxelMin: readonly [number, number, number],
    voxelMax: readonly [number, number, number],
  ): number[][] {
    const { cLo, cHi } = this.regionChunkRange(voxelMin, voxelMax);
    const out: number[][] = [];
    for (let c0 = cLo[0]!; c0 <= cHi[0]!; c0++) {
      for (let c1 = cLo[1]!; c1 <= cHi[1]!; c1++) {
        for (let c2 = cLo[2]!; c2 <= cHi[2]!; c2++) {
          out.push([c0, c1, c2]);
        }
      }
    }
    return out;
  }

  public regionChunkCount(
    level: number,
    voxelMin: readonly [number, number, number],
    voxelMax: readonly [number, number, number],
  ): number {
    if (level !== 0) throw new Error("ZarrArraySource has only level 0");
    const { cLo, cHi } = this.regionChunkRange(voxelMin, voxelMax);
    return (
      Math.max(0, cHi[0]! - cLo[0]! + 1) *
      Math.max(0, cHi[1]! - cLo[1]! + 1) *
      Math.max(0, cHi[2]! - cLo[2]! + 1)
    );
  }

  public readRegion(
    level: number,
    voxelMin: readonly [number, number, number],
    voxelMax: readonly [number, number, number],
    signal?: AbortSignal,
  ): AsyncIterable<VolumeChunk> {
    if (level !== 0) throw new Error("ZarrArraySource has only level 0");
    // Fetch the intersecting chunks with bounded concurrency instead of one-at-a-time: on a remote
    // store the brick's wall-clock is dominated by fetch latency × chunk count, so N parallel fetches
    // cut it ~N×. Results are yielded as they land (order-independent — the caller scatters by origin).
    const indices = this.regionChunkIndices(voxelMin, voxelMax);
    const concurrency = Math.max(1, Math.min(READ_REGION_CONCURRENCY, indices.length));
    return pooledMap(indices, concurrency, (ci) => {
      if (signal?.aborted) return Promise.reject(new DOMException("readRegion aborted", "AbortError"));
      return this.readDiskChunk(ci, signal);
    });
  }

  private async readDiskChunk(chunkIndices: number[], signal?: AbortSignal): Promise<VolumeChunk> {
    const key = chunkKey(this.meta, chunkIndices);
    const cached = this.chunkCache.get(key);
    if (cached) return cached;
    const compressed = await this.store.get(key, signal ? { signal } : undefined);
    const fullShape: [number, number, number] = [
      this.meta.chunks[0]!,
      this.meta.chunks[1]!,
      this.meta.chunks[2]!,
    ];
    const validShape: [number, number, number] = [0, 0, 0];
    for (let ax = 0; ax < 3; ax++) {
      const start = chunkIndices[ax]! * this.meta.chunks[ax]!;
      validShape[ax] = Math.min(this.meta.chunks[ax]!, this.meta.shape[ax]! - start);
    }
    const validCount = validShape[0]! * validShape[1]! * validShape[2]!;
    const fullCount = fullShape[0]! * fullShape[1]! * fullShape[2]!;
    const bpe = this.meta.bytesPerElement;
    let raw: ArrayBufferView;
    if (!compressed) {
      raw = fillBuffer(this.dtype, validCount, this.meta.fillValue);
    } else {
      const decoded = await this.codec.decode(compressed);
      const fullBytes = fullCount * bpe;
      const validBytes = validCount * bpe;
      if (decoded.byteLength >= fullBytes) {
        // Standard Zarr v2: full chunk with edge padding — crop with full strides.
        const buf = decoded.buffer.slice(
          decoded.byteOffset,
          decoded.byteOffset + fullBytes,
        ) as ArrayBuffer;
        const fullView = typedView(buf, this.dtype, this.meta.littleEndian);
        raw = cropCOrderChunk(fullView, fullShape, validShape, this.dtype);
      } else if (decoded.byteLength >= validBytes) {
        // Some writers emit a tightly packed valid region (non-standard but harmless).
        const buf = decoded.buffer.slice(
          decoded.byteOffset,
          decoded.byteOffset + validBytes,
        ) as ArrayBuffer;
        raw = typedView(buf, this.dtype, this.meta.littleEndian);
      } else {
        throw new Error(
          `chunk ${key}: decoded ${decoded.byteLength} < valid ${validBytes} (full ${fullBytes})`,
        );
      }
    }

    const { shape, data } = permuteChunkToXyz(raw, validShape, this.axisToXyz, this.dtype);

    const originDisk = chunkIndices.map((c, ax) => c * this.meta.chunks[ax]!);
    const origin: [number, number, number] = [
      originDisk[this.axisToXyz[0]]!,
      originDisk[this.axisToXyz[1]]!,
      originDisk[this.axisToXyz[2]]!,
    ];
    const chunk: VolumeChunk = { origin, shape, data };
    this.chunkCache.set(chunkKey(this.meta, chunkIndices), chunk);
    return chunk;
  }

  public chunks(level: number): AsyncIterable<VolumeChunk> {
    if (level !== 0) throw new Error("ZarrArraySource has only level 0");
    const counts = this.diskChunkCounts();
    const indices: number[][] = [];
    for (let c0 = 0; c0 < counts[0]!; c0++) {
      for (let c1 = 0; c1 < counts[1]!; c1++) {
        for (let c2 = 0; c2 < (counts[2] ?? 1); c2++) {
          indices.push([c0, c1, c2]);
        }
      }
    }
    // Bounded-concurrency fetch, same rationale/pattern as readRegion() below: on a remote store a
    // whole-level upload's wall-clock is dominated by fetch latency × chunk count, and a dataset whose
    // finest level actually fits the device's texture budget (unlike every previously-tested dataset,
    // where level 0 was always excluded by listUploadableLevels()) can have thousands of chunks here —
    // one-at-a-time fetching serialized that entire round-trip cost, and its interleaved per-chunk
    // decode/scatter work between awaits was frequent enough to jank the main thread mid-navigation.
    const concurrency = Math.max(1, Math.min(READ_REGION_CONCURRENCY, indices.length));
    return pooledMap(indices, concurrency, (ci) => this.readDiskChunk(ci));
  }
}

/** Open a Zarr array at `path` as a single-level {@link VolumeSource}. */
export async function openZarrArray(
  store: Store,
  path = "",
  options: OpenZarrArrayOptions = {},
): Promise<VolumeSource> {
  const meta = await readArrayMeta(store, path);
  if (meta.shape.length !== 3) {
    throw new Error(`openZarrArray: expected 3D array, got shape [${meta.shape}]`);
  }
  return new ZarrArraySource(store, meta, options);
}

/** Estimate `[min,max]` by scanning all chunks (ok for coarse LOD). */
export async function estimateValueRange(source: VolumeSource, level = 0): Promise<[number, number]> {
  let min = Infinity;
  let max = -Infinity;
  for await (const chunk of source.chunks(level)) {
    const view = chunk.data as unknown as ArrayLike<number>;
    const n = view.length;
    for (let i = 0; i < n; i++) {
      const v = view[i]!;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) return [min, min + 1];
  return [min, max];
}

/**
 * Widens an estimated `[min, max]` (from {@link estimateValueRange}) by `fraction` of its span on
 * each side. `estimateValueRange` only ever scans the *coarsest* pyramid level (scanning a full-res
 * finest level would be prohibitively expensive over the network) — but that level's voxels are
 * box-filter averages of finer voxels, which compresses variance, so real finer-level values routinely
 * fall outside the coarse-derived range. Normalizing against an under-wide range then hard-clamps
 * those real values (frequently to exactly the low end), which the ray march's empty-space skip reads
 * as air — a real region can silently vanish (confirmed live: this was the root cause of a mask-blend
 * regression once a downstream `max()` floor that happened to mask it was removed).
 *
 * This is a bounded, cheap, but *imperfect* mitigation, not a fix — it doesn't scan finer levels, so a
 * true outlier further than `fraction * span` beyond the coarse range can still clamp. A tighter fix
 * (bounded/sampled scan of the finest level) is a real, larger follow-up if this heuristic proves
 * insufficient in practice; `fraction` is a single tunable constant for that reason.
 */
export function padValueRange(
  range: readonly [number, number],
  fraction = 0.15,
): [number, number] {
  const [min, max] = range;
  const span = max - min || 1;
  const pad = span * fraction;
  return [min - pad, max + pad];
}
