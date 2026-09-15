/**
 * Zarr array/group metadata parsing for v2 (`.zarray`/`.zgroup`/`.zattrs`) and v3 (`zarr.json`).
 *
 * @packageDocumentation
 */

import { NotImplementedError } from "@zarr-viewer/core";
import type { Store } from "./store.js";
import { normalizeStoreKey } from "./store.js";
import type { VolumeDType } from "../volume-source.js";

/** Parsed NumPy-style dtype. */
export interface ParsedDType {
  dtype: VolumeDType;
  /** Little-endian when true; big-endian when false; irrelevant for 1-byte types. */
  littleEndian: boolean;
  /** Bytes per element. */
  bytes: number;
}

/** Zarr v2 compressor object (subset). */
export type ZarrCompressor = Record<string, unknown> | null;

/** Parsed metadata for a single Zarr array. */
export interface ZarrArrayMeta {
  /** Array shape (per-dimension sizes, on-disk axis order). */
  shape: number[];
  /** Chunk shape (on-disk axis order). */
  chunks: number[];
  /** Element data type. */
  dtype: VolumeDType;
  /** Codec chain names in decode order. */
  codecs: string[];
  /** Zarr format version. */
  zarrFormat: 2 | 3;
  /** Fill value for missing chunks. */
  fillValue: number;
  /** Chunk key separator (`.` classic, `/` nested dirs). */
  dimensionSeparator: "." | "/";
  /** Memory layout of each chunk. */
  order: "C" | "F";
  littleEndian: boolean;
  bytesPerElement: number;
  /** Raw compressor JSON (v2), or null. */
  compressor: ZarrCompressor;
  /** Store path prefix for this array (no trailing slash). */
  path: string;
}

/** Parse a NumPy dtype string such as `<f4`, `|u1`, `>i2`. */
export function parseNumpyDtype(spec: string): ParsedDType {
  const s = spec.trim();
  const endian = s[0] === "<" || s[0] === ">" || s[0] === "|" ? s[0] : "|";
  const body = endian === "|" || endian === "<" || endian === ">" ? s.slice(1) : s;
  const code = body[0]!;
  const size = Number.parseInt(body.slice(1), 10);
  const littleEndian = endian !== ">";

  let dtype: VolumeDType;
  switch (code) {
    case "u":
      if (size === 1) dtype = "uint8";
      else if (size === 2) dtype = "uint16";
      else if (size === 4) dtype = "uint32";
      else throw new Error(`unsupported dtype ${spec}`);
      break;
    case "i":
      if (size === 1) dtype = "int8";
      else if (size === 2) dtype = "int16";
      else if (size === 4) dtype = "int32";
      else throw new Error(`unsupported dtype ${spec}`);
      break;
    case "f":
      if (size === 4) dtype = "float32";
      else if (size === 8) dtype = "float64";
      else throw new Error(`unsupported dtype ${spec}`);
      break;
    case "b":
      dtype = "int8";
      break;
    default:
      throw new Error(`unsupported dtype ${spec}`);
  }
  return { dtype, littleEndian, bytes: size || 1 };
}

function joinPath(path: string, name: string): string {
  const p = normalizeStoreKey(path);
  if (!p) return name;
  return `${p.replace(/\/+$/, "")}/${name}`;
}

async function readJson(store: Store, key: string): Promise<unknown | undefined> {
  const bytes = await store.get(key);
  if (!bytes) return undefined;
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

/** Read group `.zattrs` (empty object if missing). */
export async function readGroupAttrs(store: Store, path = ""): Promise<Record<string, unknown>> {
  const key = joinPath(path, ".zattrs");
  const json = await readJson(store, key);
  if (json == null) return {};
  if (typeof json !== "object" || Array.isArray(json)) {
    throw new Error(`${key}: expected JSON object`);
  }
  return json as Record<string, unknown>;
}

/** Read and parse array metadata at `path` within a store (v2 `.zarray`; v3 later). */
export async function readArrayMeta(store: Store, path = ""): Promise<ZarrArrayMeta> {
  const zarrayKey = joinPath(path, ".zarray");
  const zarrJsonKey = joinPath(path, "zarr.json");
  const v2 = await readJson(store, zarrayKey);
  if (v2 != null) {
    if (typeof v2 !== "object" || Array.isArray(v2)) throw new Error(`${zarrayKey}: bad JSON`);
    const o = v2 as Record<string, unknown>;
    const shape = o.shape as number[];
    const chunks = o.chunks as number[];
    if (!Array.isArray(shape) || !Array.isArray(chunks)) {
      throw new Error(`${zarrayKey}: missing shape/chunks`);
    }
    const parsed = parseNumpyDtype(String(o.dtype));
    const compressor = (o.compressor ?? null) as ZarrCompressor;
    const codecs =
      compressor && typeof compressor === "object" && "id" in compressor
        ? [String((compressor as { id: string }).id)]
        : ["raw"];
    const sep = o.dimension_separator === "/" ? "/" : ".";
    const fill = o.fill_value;
    const fillValue =
      typeof fill === "number" ? fill : fill == null ? 0 : Number(fill);
    return {
      shape: shape.map(Number),
      chunks: chunks.map(Number),
      dtype: parsed.dtype,
      codecs,
      zarrFormat: 2,
      fillValue: Number.isFinite(fillValue) ? fillValue : 0,
      dimensionSeparator: sep,
      order: o.order === "F" ? "F" : "C",
      littleEndian: parsed.littleEndian,
      bytesPerElement: parsed.bytes,
      compressor,
      path: normalizeStoreKey(path).replace(/\/+$/, ""),
    };
  }

  const v3 = await readJson(store, zarrJsonKey);
  if (v3 != null) {
    throw new NotImplementedError("readArrayMeta zarr v3");
  }
  throw new Error(`No .zarray or zarr.json at store path "${path}"`);
}
