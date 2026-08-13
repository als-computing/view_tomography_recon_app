/**
 * WGSL uniform/storage buffer packing helpers. WebGPU imposes strict memory layout rules that differ
 * between uniform buffers (**std140**) and storage buffers (**std430**) — most notably `vec3<f32>`
 * aligns to 16 bytes, and array element strides differ between the two layouts. These builders write
 * correctly-padded `Float32Array`s so structs are laid out exactly as WGSL expects, by construction.
 *
 * All member types here are 4-byte multiples, so the builders work in 4-byte "words" internally.
 *
 * ### std140 vs std430
 * - Base alignments (`f32`=4, `vec2`=8, `vec3`/`vec4`/`mat*`=16) are the same in both layouts.
 * - In **std140** every array element is rounded up to a 16-byte stride, and the whole struct size is
 *   rounded up to 16 bytes.
 * - In **std430** array elements use their base alignment as the stride (e.g. an `f32[]` packs
 *   tightly at 4 bytes each), and the struct is rounded up to its largest member alignment.
 *
 * @packageDocumentation
 */

import type { Mat3 } from "./mat3.js";
import type { Mat4 } from "./mat4.js";

const WORD = 4; // bytes per word

/** Shared word-buffer accumulator with alignment bookkeeping. */
abstract class LayoutBuilder {
  protected words: number[] = [];
  protected maxAlignWords = 1;

  protected alignTo(alignWords: number): void {
    if (alignWords > this.maxAlignWords) this.maxAlignWords = alignWords;
    while (this.words.length % alignWords !== 0) this.words.push(0);
  }

  /** Append a 32-bit float (align 4 bytes). */
  public f32(x: number): this {
    this.words.push(x);
    return this;
  }

  /** Append a `vec2<f32>` (align 8 bytes). */
  public vec2(x: number, y: number): this {
    this.alignTo(2);
    this.words.push(x, y);
    return this;
  }

  /** Append a `vec3<f32>` (align 16 bytes; occupies 12, leaving a 4-byte gap before the next). */
  public vec3(x: number, y: number, z: number): this {
    this.alignTo(4);
    this.words.push(x, y, z);
    return this;
  }

  /** Append a `vec4<f32>` (align 16 bytes). */
  public vec4(x: number, y: number, z: number, w: number): this {
    this.alignTo(4);
    this.words.push(x, y, z, w);
    return this;
  }

  /** Append a column-major `mat3x3<f32>` (align 16; 3 columns padded to 16 bytes each = 48 bytes). */
  public mat3(m: Mat3): this {
    this.alignTo(4);
    const e = m.elements;
    for (let c = 0; c < 3; c++) {
      this.words.push(e[c * 3]!, e[c * 3 + 1]!, e[c * 3 + 2]!, 0);
    }
    return this;
  }

  /** Append a column-major `mat4x4<f32>` (align 16 bytes, 64 bytes total). */
  public mat4(m: Mat4): this {
    this.alignTo(4);
    const e = m.elements;
    for (let i = 0; i < 16; i++) this.words.push(e[i]!);
    return this;
  }

  /** Current size in bytes (before final struct padding). */
  public get byteLength(): number {
    return this.words.length * WORD;
  }

  /** Finish and return the packed, struct-size-padded `Float32Array`. */
  public abstract finish(): Float32Array;
}

/**
 * Accumulates uniform-buffer data with **std140** layout (for `@group @binding var<uniform>`).
 *
 * @example
 * ```ts
 * const buf = new Std140Builder()
 *   .mat4(viewProj)
 *   .vec3(cameraPos.x, cameraPos.y, cameraPos.z)
 *   .f32(time)
 *   .finish();
 * device.queue.writeBuffer(ubo, 0, buf);
 * ```
 */
export class Std140Builder extends LayoutBuilder {
  /** Append an array of scalars; each element occupies a full 16-byte slot (std140 rule). */
  public f32Array(values: ArrayLike<number>): this {
    for (let i = 0; i < values.length; i++) {
      this.alignTo(4);
      this.words.push(values[i]!);
    }
    return this;
  }

  /** Append an array of `vec4<f32>` from a flat `[x,y,z,w, ...]` source (16-byte stride). */
  public vec4Array(values: ArrayLike<number>): this {
    const n = Math.floor(values.length / 4);
    for (let i = 0; i < n; i++) {
      this.alignTo(4);
      this.words.push(values[i * 4]!, values[i * 4 + 1]!, values[i * 4 + 2]!, values[i * 4 + 3]!);
    }
    return this;
  }

  /** Finish and return a `Float32Array`, padded so the struct size is a multiple of 16 bytes. */
  public override finish(): Float32Array {
    this.alignTo(4);
    return new Float32Array(this.words);
  }
}

/**
 * Accumulates storage-buffer data with **std430** layout (for `var<storage>`). Array element strides
 * use each element's base alignment, so scalar/`vec2` arrays pack more tightly than in std140.
 *
 * @example
 * ```ts
 * const buf = new Std430Builder().f32Array(weights).vec3(0, 1, 0).finish();
 * device.queue.writeBuffer(ssbo, 0, buf);
 * ```
 */
export class Std430Builder extends LayoutBuilder {
  /** Append an array of scalars packed tightly at 4-byte stride (std430 rule). */
  public f32Array(values: ArrayLike<number>): this {
    for (let i = 0; i < values.length; i++) this.words.push(values[i]!);
    return this;
  }

  /** Append an array of `vec2<f32>` from a flat source at 8-byte stride. */
  public vec2Array(values: ArrayLike<number>): this {
    const n = Math.floor(values.length / 2);
    for (let i = 0; i < n; i++) {
      this.alignTo(2);
      this.words.push(values[i * 2]!, values[i * 2 + 1]!);
    }
    return this;
  }

  /** Append an array of `vec4<f32>` from a flat source at 16-byte stride. */
  public vec4Array(values: ArrayLike<number>): this {
    const n = Math.floor(values.length / 4);
    for (let i = 0; i < n; i++) {
      this.alignTo(4);
      this.words.push(values[i * 4]!, values[i * 4 + 1]!, values[i * 4 + 2]!, values[i * 4 + 3]!);
    }
    return this;
  }

  /** Finish and return a `Float32Array`, padded to the largest member alignment encountered. */
  public override finish(): Float32Array {
    this.alignTo(this.maxAlignWords);
    return new Float32Array(this.words);
  }
}

/** Base type accepted by the alignment helpers. */
export type WgslBaseType = "f32" | "vec2" | "vec3" | "vec4" | "mat3" | "mat4";

/** std140 alignment (in bytes) of a base WGSL type. */
export function std140Alignment(type: WgslBaseType): number {
  switch (type) {
    case "f32":
      return 4;
    case "vec2":
      return 8;
    default:
      return 16;
  }
}

/**
 * std430 alignment (in bytes) of a base WGSL type. Identical to std140 for these base types; the
 * layouts differ only in array element stride and struct-size rounding (see the module docs).
 */
export function std430Alignment(type: WgslBaseType): number {
  return std140Alignment(type);
}
