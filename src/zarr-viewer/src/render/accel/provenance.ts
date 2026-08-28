/**
 * PNG provenance stamping for exported frames. Every screenshot / still export carries tEXt / iTXt
 * chunks so a figure is reproducible: shader config, approximate-shading knobs, TAAU convergence,
 * shadow representation, transfer-function identity, and the render scale at export time.
 *
 * @packageDocumentation
 */

import type { ShaderConfigName, ShadowRepresentation } from "./shader-config.js";

/** Metadata written into every exported PNG. */
export interface RenderProvenance {
  /** Named shader configuration used for the frame. */
  shaderConfig: ShaderConfigName;
  /** Multi-scatter octave count (0 if disabled). */
  multiScatterOctaves: number;
  /** TAAU accumulated-frame count at export (0 if TAAU is off / not yet built). */
  taauFrames: number;
  /** Shadow representation that was bound. */
  shadowMode: ShadowRepresentation;
  /**
   * Identity of the transfer function: a hex FNV-1a hash of the LUT, plus optional window/level
   * parameters when the TF was built that way.
   */
  transferFunction: string;
  /** Internal render resolution as a fraction of the swapchain (1 = full). */
  renderScale: number;
  /**
   * Whether the Gaussian-extended pre-integration table (Milestone 3.2) was active — i.e. the
   * per-sample opacity integral was blurred by a mip-pyramid-derived local density variance instead
   * of using the exact (unblurred) transfer-function curve. An artistic approximation in the same
   * sense as multi-scatter/bent-normal ambient, so it's provenance-stamped like them.
   */
  extendedPreIntegration: boolean;
}

const PNG_SIG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

/** FNV-1a 32-bit hash, returned as 8 hex chars. */
export function fnv1aHex(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Hash a transfer-function LUT (RGBA8) for provenance. Optionally append window/level so a radiology
 * window is recoverable even if the LUT quantization would collide.
 */
export function hashTransferFunction(
  lut: Uint8Array,
  windowLevel?: { center: number; width: number },
): string {
  const lutHash = fnv1aHex(lut);
  if (!windowLevel) return `lut:${lutHash}`;
  const c = windowLevel.center.toFixed(4);
  const w = windowLevel.width.toFixed(4);
  return `lut:${lutHash};wl:${c}/${w}`;
}

/** Serialize provenance as a stable, parseable text blob. */
export function formatProvenance(p: RenderProvenance): string {
  return [
    `shaderConfig=${p.shaderConfig}`,
    `multiScatterOctaves=${p.multiScatterOctaves}`,
    `taauFrames=${p.taauFrames}`,
    `shadowMode=${p.shadowMode}`,
    `transferFunction=${p.transferFunction}`,
    `renderScale=${p.renderScale}`,
  ].join("\n");
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function u32be(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Build a PNG chunk (length + type + data + crc). */
export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = latin1(type);
  const crcInput = concat([typeBytes, data]);
  return concat([u32be(data.length), crcInput, u32be(crc32(crcInput))]);
}

/** tEXt chunk: Latin-1 keyword + NUL + Latin-1 text. Keyword must be 1–79 chars. */
export function pngTextChunk(keyword: string, text: string): Uint8Array {
  const data = concat([latin1(keyword), new Uint8Array([0]), latin1(text)]);
  return pngChunk("tEXt", data);
}

/** iTXt chunk (uncompressed UTF-8) for values that aren't Latin-1-safe. */
export function pngItxtChunk(keyword: string, text: string): Uint8Array {
  const data = concat([
    latin1(keyword),
    new Uint8Array([0, 0, 0, 0, 0]), // compression flag, method, empty language, empty translated
    utf8(text),
  ]);
  return pngChunk("iTXt", data);
}

/**
 * Insert provenance chunks immediately before IEND. Throws if `png` is not a PNG.
 *
 * Keywords follow the plan: shader config, octave count, TAAU frames, shadow mode, TF identity,
 * render scale — plus a single iTXt JSON blob for programmatic round-trip.
 */
export function stampPngProvenance(png: Uint8Array, provenance: RenderProvenance): Uint8Array {
  if (png.length < 8 || PNG_SIG.some((b, i) => png[i] !== b)) {
    throw new Error("stampPngProvenance: not a PNG");
  }
  let iendAt = -1;
  let offset = 8;
  while (offset + 12 <= png.length) {
    const len = (png[offset]! << 24) | (png[offset + 1]! << 16) | (png[offset + 2]! << 8) | png[offset + 3]!;
    const type = String.fromCharCode(png[offset + 4]!, png[offset + 5]!, png[offset + 6]!, png[offset + 7]!);
    if (type === "IEND") {
      iendAt = offset;
      break;
    }
    offset += 12 + len;
  }
  if (iendAt < 0) throw new Error("stampPngProvenance: missing IEND");

  const extra = concat([
    pngTextChunk("ShaderConfig", provenance.shaderConfig),
    pngTextChunk("MultiScatterOctaves", String(provenance.multiScatterOctaves)),
    pngTextChunk("TAAUFrames", String(provenance.taauFrames)),
    pngTextChunk("ShadowMode", provenance.shadowMode),
    pngTextChunk("TransferFunction", provenance.transferFunction.slice(0, 79)),
    pngTextChunk("RenderScale", String(provenance.renderScale)),
    pngItxtChunk("TomoProvenance", JSON.stringify(provenance)),
  ]);

  const out = new Uint8Array(iendAt + extra.length + (png.length - iendAt));
  out.set(png.subarray(0, iendAt), 0);
  out.set(extra, iendAt);
  out.set(png.subarray(iendAt), iendAt + extra.length);
  return out;
}

/**
 * Encode a canvas snapshot as a PNG with provenance tEXt/iTXt chunks. Uses `convertToBlob` when
 * available (WebGPU canvases), otherwise `toBlob`.
 */
export async function stampCanvasPng(
  canvas: HTMLCanvasElement,
  provenance: RenderProvenance,
): Promise<Blob> {
  const withConvert = canvas as HTMLCanvasElement & {
    convertToBlob?: (opts: { type: string }) => Promise<Blob>;
  };
  const blob = withConvert.convertToBlob
    ? await withConvert.convertToBlob({ type: "image/png" })
    : await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png");
      });
  const buf = new Uint8Array(await blob.arrayBuffer());
  const stamped = stampPngProvenance(buf, provenance);
  const copy = new Uint8Array(stamped.byteLength);
  copy.set(stamped);
  return new Blob([copy], { type: "image/png" });
}

/**
 * Parse the `TomoProvenance` iTXt JSON blob back out of a stamped PNG, or `null` if absent.
 */
export function readPngProvenance(png: Uint8Array): RenderProvenance | null {
  if (png.length < 8 || PNG_SIG.some((b, i) => png[i] !== b)) return null;
  let offset = 8;
  while (offset + 12 <= png.length) {
    const len = (png[offset]! << 24) | (png[offset + 1]! << 16) | (png[offset + 2]! << 8) | png[offset + 3]!;
    const type = String.fromCharCode(png[offset + 4]!, png[offset + 5]!, png[offset + 6]!, png[offset + 7]!);
    if (type === "iTXt") {
      const data = png.subarray(offset + 8, offset + 8 + len);
      const nul = data.indexOf(0);
      if (nul > 0) {
        const keyword = String.fromCharCode(...data.subarray(0, nul));
        if (keyword === "TomoProvenance") {
          // keyword \0 flag method \0 lang \0 translated \0 utf8
          let i = nul + 1;
          i += 2; // flag + method
          while (i < data.length && data[i] !== 0) i++; // language
          i++;
          while (i < data.length && data[i] !== 0) i++; // translated
          i++;
          try {
            return JSON.parse(new TextDecoder().decode(data.subarray(i))) as RenderProvenance;
          } catch {
            return null;
          }
        }
      }
    }
    if (type === "IEND") break;
    offset += 12 + len;
  }
  return null;
}
