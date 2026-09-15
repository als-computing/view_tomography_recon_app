/**
 * Zarr chunk codecs. Gzip/zlib/raw use the platform `DecompressionStream` (zero-dependency);
 * blosc (lz4 + byte-shuffle) is implemented from scratch for OME-Zarr tomography.
 *
 * @packageDocumentation
 */

import { NotImplementedError } from "@zarr-viewer/core";
import { lz4BlockDecompress } from "./lz4.js";

/** A chunk codec: decode compressed bytes to raw bytes. */
export interface Codec {
  readonly name: string;
  decode(bytes: Uint8Array): Promise<Uint8Array>;
}

/** Blosc compressor metadata from a Zarr v2 `.zarray` (or equivalent). */
export interface BloscCompressorConfig {
  id?: string;
  cname?: string;
  clevel?: number;
  shuffle?: number;
  blocksize?: number;
}

/** Identity codec for uncompressed chunks. */
export const rawCodec: Codec = {
  name: "raw",
  decode: (bytes) => Promise.resolve(bytes),
};

async function decompressStream(bytes: Uint8Array, format: "gzip" | "deflate"): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error(`${format} decode requires DecompressionStream`);
  }
  const ds = new DecompressionStream(format);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const stream = new Blob([copy]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/** Gzip codec backed by the platform `DecompressionStream`. */
export function gzipCodec(): Codec {
  return {
    name: "gzip",
    decode: (bytes) => decompressStream(bytes, "gzip"),
  };
}

/** Zlib/deflate codec (Zarr `"zlib"` compressor). */
export function zlibCodec(): Codec {
  return {
    name: "zlib",
    decode: (bytes) => decompressStream(bytes, "deflate"),
  };
}

const BLOSC_HEADER = 16;
const BLOSC_MAX_SPLITS = 8;
const BLOSC_MIN_BUFFERSIZE = 128;
const BLOSC_DOSHUFFLE = 0x1;
const BLOSC_DOBITSHUFFLE = 0x2;
const BLOSC_DONT_SPLIT = 0x10;

function readU32LE(buf: Uint8Array, off: number): number {
  return (
    buf[off]! |
    (buf[off + 1]! << 8) |
    (buf[off + 2]! << 16) |
    (buf[off + 3]! << 24)
  ) >>> 0;
}

function readI32LE(buf: Uint8Array, off: number): number {
  return readU32LE(buf, off) | 0;
}

/** Reverse Blosc byte-shuffle into `dest` (same length as `src`). */
export function bloscUnshuffle(typesize: number, src: Uint8Array, dest: Uint8Array): void {
  const n = src.length;
  const nitems = (n / typesize) | 0;
  for (let j = 0; j < typesize; j++) {
    const srcBase = j * nitems;
    for (let i = 0; i < nitems; i++) {
      dest[i * typesize + j] = src[srcBase + i]!;
    }
  }
}

function bloscCompressorName(flags: number): string {
  switch ((flags >> 5) & 0x7) {
    case 0:
      return "blosclz";
    case 1:
      return "lz4";
    case 2:
      return "lz4hc";
    case 3:
      return "snappy";
    case 4:
      return "zlib";
    case 5:
      return "zstd";
    default:
      return "unknown";
  }
}

/**
 * Decode a Blosc1 frame (as stored by numcodecs / zarr-python) into raw bytes.
 * Supports lz4 / lz4hc and zlib inner codecs, with optional byte-shuffle.
 */
export function bloscDecodeSync(src: Uint8Array): Uint8Array {
  if (src.length < BLOSC_HEADER) throw new Error("blosc: truncated header");
  const flags = src[2]!;
  const typesize = src[3]!;
  const nbytes = readU32LE(src, 4);
  let blocksize = readU32LE(src, 8);
  const cbytes = readU32LE(src, 12);
  if (cbytes > src.length) throw new Error("blosc: cbytes exceeds buffer");
  if (typesize === 0) throw new Error("blosc: invalid typesize");
  if (blocksize === 0) {
    // Autoblock: c-blosc picks a size; for decode we derive from nbytes when needed.
    blocksize = nbytes;
  }

  const dest = new Uint8Array(nbytes);
  if (nbytes === 0) return dest;

  let nblocks = (nbytes / blocksize) | 0;
  const leftover = nbytes % blocksize;
  if (leftover > 0) nblocks++;
  if (nblocks > Math.floor((cbytes - BLOSC_HEADER) / 4)) {
    throw new Error("blosc: invalid nblocks");
  }

  const bstarts = src.subarray(BLOSC_HEADER);
  const cname = bloscCompressorName(flags);
  const doshuffle = (flags & BLOSC_DOSHUFFLE) !== 0 && typesize > 1;
  const dobitshuffle = (flags & BLOSC_DOBITSHUFFLE) !== 0;
  if (dobitshuffle) throw new NotImplementedError("blosc bitshuffle");

  const dontSplit = (flags & BLOSC_DONT_SPLIT) !== 0;
  let destOff = 0;

  for (let j = 0; j < nblocks; j++) {
    const leftoverBlock = leftover > 0 && j === nblocks - 1;
    const bsize = leftoverBlock ? leftover : blocksize;
    let srcOffset = readI32LE(bstarts, j * 4);
    if (srcOffset < 0 || srcOffset > cbytes - 4) throw new Error("blosc: bad bstart");

    let nsplits = 1;
    if (
      !dontSplit &&
      !leftoverBlock &&
      typesize <= BLOSC_MAX_SPLITS &&
      bsize / typesize >= BLOSC_MIN_BUFFERSIZE
    ) {
      nsplits = typesize;
    }
    const neblock = (bsize / nsplits) | 0;
    const blockTmp = doshuffle ? new Uint8Array(bsize) : dest.subarray(destOff, destOff + bsize);
    let tmpOff = 0;

    for (let s = 0; s < nsplits; s++) {
      if (srcOffset < 0 || srcOffset > cbytes - 4) throw new Error("blosc: split offset");
      const splitCBytes = readI32LE(src, srcOffset);
      srcOffset += 4;
      if (splitCBytes < 0 || srcOffset + splitCBytes > cbytes) {
        throw new Error("blosc: bad split cbytes");
      }
      const splitSrc = src.subarray(srcOffset, srcOffset + splitCBytes);
      srcOffset += splitCBytes;
      const splitDest = blockTmp.subarray(tmpOff, tmpOff + neblock);

      if (splitCBytes === neblock) {
        splitDest.set(splitSrc);
      } else if (cname === "lz4" || cname === "lz4hc") {
        lz4BlockDecompress(splitSrc, splitDest);
      } else if (cname === "zlib") {
        throw new NotImplementedError("blosc zlib split (use gzip codec path)");
      } else {
        throw new NotImplementedError(`blosc inner codec ${cname}`);
      }
      tmpOff += neblock;
    }

    if (doshuffle) {
      const out = dest.subarray(destOff, destOff + bsize);
      bloscUnshuffle(typesize, blockTmp, out);
    }
    destOff += bsize;
  }

  return dest;
}

/** Blosc meta-codec (lz4 + byte-shuffle; bitshuffle/zstd later). */
export function bloscCodec(_config?: BloscCompressorConfig): Codec {
  return {
    name: "blosc",
    decode: (bytes) => Promise.resolve(bloscDecodeSync(bytes)),
  };
}

/** Zstandard codec (from scratch; later priority). */
export function zstdCodec(): Codec {
  return {
    name: "zstd",
    decode: (_bytes) => {
      throw new NotImplementedError("zstdCodec.decode");
    },
  };
}

/** Pick a codec from a Zarr v2 compressor JSON object (or `null` → raw). */
export function codecFromCompressor(compressor: unknown): Codec {
  if (compressor == null) return rawCodec;
  if (typeof compressor !== "object") throw new Error("invalid compressor");
  const c = compressor as Record<string, unknown>;
  const id = String(c.id ?? "");
  switch (id) {
    case "raw":
    case "":
      return rawCodec;
    case "gzip":
      return gzipCodec();
    case "zlib":
      return zlibCodec();
    case "blosc":
      return bloscCodec({
        id: "blosc",
        cname: typeof c.cname === "string" ? c.cname : undefined,
        clevel: typeof c.clevel === "number" ? c.clevel : undefined,
        shuffle: typeof c.shuffle === "number" ? c.shuffle : undefined,
        blocksize: typeof c.blocksize === "number" ? c.blocksize : undefined,
      });
    case "zstd":
      return zstdCodec();
    default:
      throw new NotImplementedError(`codec ${id}`);
  }
}
