/**
 * Colors as vectors: linear RGB/RGBA in `[0, 1]`, channel layout matching {@link Vec3}/{@link Vec4}
 * (`x=r`, `y=g`, `z=b`, `w=a`).
 *
 * Prefer {@link Color3}/{@link Color4} tuples at schema/GPU boundaries (serializable, zero-alloc
 * literals). Use {@link Vec3}/{@link Vec4} for in-place math, then bridge with {@link asColor3}/
 * {@link asColor4}. Canvas2D/CSS conversion lives here so demos and `@zarr-viewer/ui` share one path.
 *
 * @packageDocumentation
 */

import type { Vec3Like } from "./vec3.js";
import { Vec3 } from "./vec3.js";
import type { Vec4Like } from "./vec4.js";
import { Vec4 } from "./vec4.js";

/** Linear RGB tuple — same channels as {@link Vec3} (`x=r`, `y=g`, `z=b`). */
export type Color3 = readonly [number, number, number];
/** Linear RGBA tuple — same channels as {@link Vec4} (`x=r`, `y=g`, `z=b`, `w=a`). */
export type Color4 = readonly [number, number, number, number];

/** Mutable RGB scratch / out-parameter. */
export type MutableColor3 = [number, number, number];
/** Mutable RGBA scratch / out-parameter. */
export type MutableColor4 = [number, number, number, number];

/** Tuple or vector RGB. */
export type Color3Like = Color3 | Vec3Like;
/** Tuple or vector RGBA (a {@link Vec3Like} is treated as opaque RGB with `a = 1`). */
export type Color4Like = Color4 | Vec4Like | Color3Like;

/** Construct a linear RGB tuple. */
export function rgb(r: number, g: number, b: number): Color3 {
  return [r, g, b];
}

/** Construct a linear RGBA tuple. */
export function rgba(r: number, g: number, b: number, a = 1): Color4 {
  return [r, g, b, a];
}

/** `true` when `c` is a numeric 3-tuple (not a `{x,y,z}` vector or RGBA tuple). */
export function isColor3Tuple(c: Color3Like | Color4Like): c is Color3 {
  return Array.isArray(c) && c.length === 3;
}

/** `true` when `c` is a numeric 4-tuple. */
export function isColor4Tuple(c: Color4Like): c is Color4 {
  return Array.isArray(c) && c.length >= 4;
}

/** Write `c` into `out` as RGB. */
export function writeColor3(out: MutableColor3, c: Color3Like): MutableColor3 {
  if (isColor3Tuple(c)) {
    out[0] = c[0];
    out[1] = c[1];
    out[2] = c[2];
  } else {
    out[0] = c.x;
    out[1] = c.y;
    out[2] = c.z;
  }
  return out;
}

/** Write `c` into `out` as RGBA (`a` defaults to 1 for RGB sources). */
export function writeColor4(out: MutableColor4, c: Color4Like, a = 1): MutableColor4 {
  if (isColor4Tuple(c)) {
    out[0] = c[0];
    out[1] = c[1];
    out[2] = c[2];
    out[3] = c[3];
  } else if (isColor3Tuple(c)) {
    out[0] = c[0];
    out[1] = c[1];
    out[2] = c[2];
    out[3] = a;
  } else if ("w" in c) {
    out[0] = c.x;
    out[1] = c.y;
    out[2] = c.z;
    out[3] = c.w;
  } else {
    out[0] = c.x;
    out[1] = c.y;
    out[2] = c.z;
    out[3] = a;
  }
  return out;
}

/** Normalize any {@link Color3Like} to a {@link Color3} tuple. */
export function asColor3(c: Color3Like, out: MutableColor3 = [0, 0, 0]): Color3 {
  return writeColor3(out, c);
}

/** Normalize any {@link Color4Like} to a {@link Color4} tuple. */
export function asColor4(c: Color4Like, a = 1, out: MutableColor4 = [0, 0, 0, 1]): Color4 {
  return writeColor4(out, c, a);
}

/** Copy a color into a {@link Vec3} (`x=r`, `y=g`, `z=b`). */
export function color3ToVec3(c: Color3Like, out = new Vec3()): Vec3 {
  if (isColor3Tuple(c)) return out.set(c[0], c[1], c[2]);
  return out.set(c.x, c.y, c.z);
}

/** Copy a color into a {@link Vec4} (`x=r`, `y=g`, `z=b`, `w=a`). */
export function color4ToVec4(c: Color4Like, a = 1, out = new Vec4()): Vec4 {
  const t = writeColor4([0, 0, 0, 1], c, a);
  return out.set(t[0], t[1], t[2], t[3]);
}

/** Read a {@link Vec3Like} as a {@link Color3}. */
export function vec3ToColor3(v: Vec3Like, out: MutableColor3 = [0, 0, 0]): Color3 {
  out[0] = v.x;
  out[1] = v.y;
  out[2] = v.z;
  return out;
}

/** Read a {@link Vec4Like} as a {@link Color4}. */
export function vec4ToColor4(v: Vec4Like, out: MutableColor4 = [0, 0, 0, 1]): Color4 {
  out[0] = v.x;
  out[1] = v.y;
  out[2] = v.z;
  out[3] = v.w;
  return out;
}

/** `out = a * s` (scale RGB; alpha unchanged when writing RGBA via {@link scaleColor4}). */
export function scaleColor3(out: MutableColor3, c: Color3Like, s: number): MutableColor3 {
  writeColor3(out, c);
  out[0] *= s;
  out[1] *= s;
  out[2] *= s;
  return out;
}

/** `out = a * s` including alpha. */
export function scaleColor4(out: MutableColor4, c: Color4Like, s: number): MutableColor4 {
  writeColor4(out, c);
  out[0] *= s;
  out[1] *= s;
  out[2] *= s;
  out[3] *= s;
  return out;
}

/** Component-wise `out = a * b` (modulate). */
export function multiplyColor3(out: MutableColor3, a: Color3Like, b: Color3Like): MutableColor3 {
  const A = writeColor3([0, 0, 0], a);
  const B = writeColor3([0, 0, 0], b);
  out[0] = A[0] * B[0];
  out[1] = A[1] * B[1];
  out[2] = A[2] * B[2];
  return out;
}

/** Linear interpolate RGB: `out = a + (b - a) * t`. */
export function lerpColor3(
  out: MutableColor3,
  a: Color3Like,
  b: Color3Like,
  t: number,
): MutableColor3 {
  const A = writeColor3([0, 0, 0], a);
  const B = writeColor3([0, 0, 0], b);
  out[0] = A[0] + (B[0] - A[0]) * t;
  out[1] = A[1] + (B[1] - A[1]) * t;
  out[2] = A[2] + (B[2] - A[2]) * t;
  return out;
}

/** Linear interpolate RGBA. */
export function lerpColor4(
  out: MutableColor4,
  a: Color4Like,
  b: Color4Like,
  t: number,
): MutableColor4 {
  const A = writeColor4([0, 0, 0, 1], a);
  const B = writeColor4([0, 0, 0, 1], b);
  out[0] = A[0] + (B[0] - A[0]) * t;
  out[1] = A[1] + (B[1] - A[1]) * t;
  out[2] = A[2] + (B[2] - A[2]) * t;
  out[3] = A[3] + (B[3] - A[3]) * t;
  return out;
}

/** Clamp each channel of an RGB color into `[0, 1]`. */
export function clampColor3(out: MutableColor3, c: Color3Like): MutableColor3 {
  writeColor3(out, c);
  out[0] = out[0] < 0 ? 0 : out[0] > 1 ? 1 : out[0];
  out[1] = out[1] < 0 ? 0 : out[1] > 1 ? 1 : out[1];
  out[2] = out[2] < 0 ? 0 : out[2] > 1 ? 1 : out[2];
  return out;
}

/** Clamp each channel of an RGBA color into `[0, 1]`. */
export function clampColor4(out: MutableColor4, c: Color4Like): MutableColor4 {
  writeColor4(out, c);
  out[0] = out[0] < 0 ? 0 : out[0] > 1 ? 1 : out[0];
  out[1] = out[1] < 0 ? 0 : out[1] > 1 ? 1 : out[1];
  out[2] = out[2] < 0 ? 0 : out[2] > 1 ? 1 : out[2];
  out[3] = out[3] < 0 ? 0 : out[3] > 1 ? 1 : out[3];
  return out;
}

/**
 * Convert a linear (or already display-referred) color to a CSS `rgb()` / `rgba()` string.
 * Channels are treated as `[0, 1]` and rounded to 8-bit.
 */
export function colorToCss(c: Color4Like, alpha?: number): string {
  const t = writeColor4([0, 0, 0, 1], c);
  const r = Math.round(clamp01(t[0]) * 255);
  const g = Math.round(clamp01(t[1]) * 255);
  const b = Math.round(clamp01(t[2]) * 255);
  const a = alpha !== undefined ? alpha : t[3];
  if (a >= 1) return `rgb(${r},${g},${b})`;
  return `rgba(${r},${g},${b},${a})`;
}

/** Parse `#rgb` / `#rrggbb` (optional leading `#`) into linear-ish `[0,1]` RGB (no sRGB decode). */
export function hexToColor3(hex: string, out: MutableColor3 = [0, 0, 0]): Color3 {
  let h = hex.startsWith("#") ? hex.slice(1) : hex;
  if (h.length === 3) {
    h = `${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
  }
  if (h.length !== 6) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    return out;
  }
  out[0] = parseInt(h.slice(0, 2), 16) / 255;
  out[1] = parseInt(h.slice(2, 4), 16) / 255;
  out[2] = parseInt(h.slice(4, 6), 16) / 255;
  return out;
}

/** Convert a single sRGB channel to linear. */
export function srgbToLinearChannel(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Convert a single linear channel to sRGB. */
export function linearToSrgbChannel(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** Convert an sRGB color to linear, writing into `out`. */
export function srgbToLinear(c: Color3Like, out?: MutableColor3): MutableColor3;
export function srgbToLinear(
  r: number,
  g: number,
  b: number,
  out?: MutableColor3,
): MutableColor3;
export function srgbToLinear(
  rOrC: number | Color3Like,
  gOrOut?: number | MutableColor3,
  b?: number,
  out: MutableColor3 = [0, 0, 0],
): MutableColor3 {
  if (typeof rOrC !== "number") {
    const dest = (Array.isArray(gOrOut) ? gOrOut : out) as MutableColor3;
    writeColor3(dest, rOrC);
    dest[0] = srgbToLinearChannel(dest[0]);
    dest[1] = srgbToLinearChannel(dest[1]);
    dest[2] = srgbToLinearChannel(dest[2]);
    return dest;
  }
  const dest = (typeof gOrOut === "number" ? out : (gOrOut ?? out)) as MutableColor3;
  const g = typeof gOrOut === "number" ? gOrOut : 0;
  const bb = typeof b === "number" ? b : 0;
  dest[0] = srgbToLinearChannel(rOrC);
  dest[1] = srgbToLinearChannel(g);
  dest[2] = srgbToLinearChannel(bb);
  return dest;
}

/** Convert a linear color to sRGB, writing into `out`. */
export function linearToSrgb(c: Color3Like, out?: MutableColor3): MutableColor3;
export function linearToSrgb(
  r: number,
  g: number,
  b: number,
  out?: MutableColor3,
): MutableColor3;
export function linearToSrgb(
  rOrC: number | Color3Like,
  gOrOut?: number | MutableColor3,
  b?: number,
  out: MutableColor3 = [0, 0, 0],
): MutableColor3 {
  if (typeof rOrC !== "number") {
    const dest = (Array.isArray(gOrOut) ? gOrOut : out) as MutableColor3;
    writeColor3(dest, rOrC);
    dest[0] = linearToSrgbChannel(dest[0]);
    dest[1] = linearToSrgbChannel(dest[1]);
    dest[2] = linearToSrgbChannel(dest[2]);
    return dest;
  }
  const dest = (typeof gOrOut === "number" ? out : (gOrOut ?? out)) as MutableColor3;
  const g = typeof gOrOut === "number" ? gOrOut : 0;
  const bb = typeof b === "number" ? b : 0;
  dest[0] = linearToSrgbChannel(rOrC);
  dest[1] = linearToSrgbChannel(g);
  dest[2] = linearToSrgbChannel(bb);
  return dest;
}

/** Convert HSV (each in `[0, 1]`) to RGB, writing into `out`. */
export function hsvToRgb(
  h: number,
  s: number,
  v: number,
  out: MutableColor3 = [0, 0, 0],
): MutableColor3 {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0:
      out[0] = v;
      out[1] = t;
      out[2] = p;
      break;
    case 1:
      out[0] = q;
      out[1] = v;
      out[2] = p;
      break;
    case 2:
      out[0] = p;
      out[1] = v;
      out[2] = t;
      break;
    case 3:
      out[0] = p;
      out[1] = q;
      out[2] = v;
      break;
    case 4:
      out[0] = t;
      out[1] = p;
      out[2] = v;
      break;
    default:
      out[0] = v;
      out[1] = p;
      out[2] = q;
      break;
  }
  return out;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
