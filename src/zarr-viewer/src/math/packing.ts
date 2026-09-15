/**
 * GPU-oriented data packing: IEEE-754 half-float (f16) conversion, normalized 8-bit packing
 * (matching WGSL `pack4x8(u)norm` semantics), octahedral unit-vector encoding for compact normal
 * buffers, and Morton (Z-order) interleaving for spatial hashing. These cut vertex/attachment
 * bandwidth and give stable keys for spatial data structures.
 *
 * @packageDocumentation
 */

import { clamp } from "./scalar.js";
import { Vec2, type Vec2Like } from "./vec2.js";
import { Vec3, type Vec3Like } from "./vec3.js";

const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);

/** Convert a 32-bit float to its IEEE-754 half-precision (f16) bit pattern (round to nearest even). */
export function floatToHalf(value: number): number {
  _f32[0] = value;
  const x = _u32[0]!;
  const sign = (x >>> 16) & 0x8000;
  let exp = (x >>> 23) & 0xff;
  let mantissa = x & 0x007fffff;

  if (exp === 255) return sign | 0x7c00 | (mantissa ? 0x200 : 0); // Inf / NaN
  exp = exp - 127 + 15;
  if (exp >= 31) return sign | 0x7c00; // overflow → Inf
  if (exp <= 0) {
    if (exp < -10) return sign; // underflow → signed zero
    mantissa = (mantissa | 0x00800000) >>> (1 - exp);
    if (mantissa & 0x00001000) mantissa += 0x00002000; // round
    return sign | (mantissa >>> 13);
  }
  if (mantissa & 0x00001000) {
    mantissa += 0x00002000; // round to nearest even
    if (mantissa & 0x00800000) {
      mantissa = 0;
      exp += 1;
      if (exp >= 31) return sign | 0x7c00;
    }
  }
  return sign | (exp << 10) | (mantissa >>> 13);
}

/** Convert an IEEE-754 half-precision (f16) bit pattern to a 32-bit float. */
export function halfToFloat(h: number): number {
  const sign = (h & 0x8000) << 16;
  const exp = (h >>> 10) & 0x1f;
  const mant = h & 0x03ff;
  if (exp === 0) {
    if (mant === 0) {
      _u32[0] = sign;
      return _f32[0]!;
    }
    // Subnormal: normalize into a float32 normal.
    let e = -1;
    let m = mant;
    do {
      e++;
      m <<= 1;
    } while ((m & 0x0400) === 0);
    m &= 0x03ff;
    _u32[0] = sign | ((127 - 15 - e) << 23) | (m << 13);
    return _f32[0]!;
  }
  if (exp === 31) {
    _u32[0] = sign | 0x7f800000 | (mant << 13);
    return _f32[0]!;
  }
  _u32[0] = sign | ((exp - 15 + 127) << 23) | (mant << 13);
  return _f32[0]!;
}

const q8 = (x: number): number => Math.round(clamp(x, 0, 1) * 255) & 0xff;

/** Pack four `[0,1]` values into a `RGBA8` uint32 (r in the low byte), like WGSL `pack4x8unorm`. */
export function packUnorm4x8(r: number, g: number, b: number, a: number): number {
  return (q8(r) | (q8(g) << 8) | (q8(b) << 16) | (q8(a) << 24)) >>> 0;
}

/** Unpack a `RGBA8` uint32 (from {@link packUnorm4x8}) into `out` `[0,1]` components. */
export function unpackUnorm4x8(packed: number, out: Vec4Out): Vec4Out {
  out.x = (packed & 0xff) / 255;
  out.y = ((packed >>> 8) & 0xff) / 255;
  out.z = ((packed >>> 16) & 0xff) / 255;
  out.w = ((packed >>> 24) & 0xff) / 255;
  return out;
}

const q8s = (x: number): number => (Math.round(clamp(x, -1, 1) * 127) & 0xff) >>> 0;

/** Pack four `[-1,1]` values into a signed `RGBA8` uint32, like WGSL `pack4x8snorm`. */
export function packSnorm4x8(r: number, g: number, b: number, a: number): number {
  return (q8s(r) | (q8s(g) << 8) | (q8s(b) << 16) | (q8s(a) << 24)) >>> 0;
}

/** Sign-extend an 8-bit two's-complement byte and map to `[-1,1]`. */
const s8 = (byte: number): number => {
  const v = byte & 0xff;
  return clamp((v < 128 ? v : v - 256) / 127, -1, 1);
};

/** Unpack a signed `RGBA8` uint32 (from {@link packSnorm4x8}) into `out` `[-1,1]` components. */
export function unpackSnorm4x8(packed: number, out: Vec4Out): Vec4Out {
  out.x = s8(packed & 0xff);
  out.y = s8((packed >>> 8) & 0xff);
  out.z = s8((packed >>> 16) & 0xff);
  out.w = s8((packed >>> 24) & 0xff);
  return out;
}

/** Minimal 4-component writable target for unpack helpers. */
export interface Vec4Out {
  x: number;
  y: number;
  z: number;
  w: number;
}

/**
 * Octahedral encoding of a unit vector into two `[-1,1]` values (written to `out`). Stores a normal
 * in two channels with far less error than storing `xy` and reconstructing `z`, and no hemisphere
 * ambiguity — the standard compact G-buffer normal encoding.
 */
export function encodeOctNormal(v: Vec3Like, out: Vec2 = new Vec2()): Vec2 {
  const l1 = Math.abs(v.x) + Math.abs(v.y) + Math.abs(v.z) || 1;
  let x = v.x / l1;
  let y = v.y / l1;
  if (v.z < 0) {
    const ox = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
    const oy = (1 - Math.abs(x)) * (y >= 0 ? 1 : -1);
    x = ox;
    y = oy;
  }
  return out.set(x, y);
}

/** Decode an octahedral-encoded normal (from {@link encodeOctNormal}) back to a unit vector. */
export function decodeOctNormal(e: Vec2Like, out: Vec3 = new Vec3()): Vec3 {
  let x = e.x;
  let y = e.y;
  const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) {
    const ox = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
    const oy = (1 - Math.abs(x)) * (y >= 0 ? 1 : -1);
    x = ox;
    y = oy;
  }
  return out.set(x, y, z).normalize();
}

/** Spread the low 10 bits of `n` so each occupies every third bit (Morton "part-1-by-2"). */
function part1By2(n: number): number {
  let x = n & 0x3ff;
  x = (x | (x << 16)) & 0x030000ff;
  x = (x | (x << 8)) & 0x0300f00f;
  x = (x | (x << 4)) & 0x030c30c3;
  x = (x | (x << 2)) & 0x09249249;
  return x >>> 0;
}

/** Inverse of {@link part1By2}: gather every third bit back into a 10-bit value. */
function compact1By2(n: number): number {
  let x = n & 0x09249249;
  x = (x | (x >>> 2)) & 0x030c30c3;
  x = (x | (x >>> 4)) & 0x0300f00f;
  x = (x | (x >>> 8)) & 0x030000ff;
  x = (x | (x >>> 16)) & 0x000003ff;
  return x >>> 0;
}

/**
 * Interleave three 10-bit integer coordinates into a 30-bit Morton (Z-order) code. Nearby cells get
 * nearby codes, giving cache-friendly ordering and stable keys for spatial hash grids and BVH build.
 */
export function morton3D(x: number, y: number, z: number): number {
  return (part1By2(x) | (part1By2(y) << 1) | (part1By2(z) << 2)) >>> 0;
}

/** Decode a 30-bit Morton code (from {@link morton3D}) into `out` integer coordinates. */
export function demorton3D(code: number, out: Vec3 = new Vec3()): Vec3 {
  return out.set(compact1By2(code), compact1By2(code >>> 1), compact1By2(code >>> 2));
}
