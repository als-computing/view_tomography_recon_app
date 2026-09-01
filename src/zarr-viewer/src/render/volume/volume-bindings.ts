/**
 * Per-frame bind-group creation for the volume ray-march pass. Split out of `VolumeRenderer` so
 * `recordInto` can call `ensure()` immediately before use instead of relying on `!` assertions
 * against a field invalidated from a dozen call sites scattered across the class.
 *
 * @packageDocumentation
 */

import type { ManagedBuffer } from "../resources/buffer.js";
import type { ManagedTexture } from "../resources/texture.js";
import type { ShaderSpecialization } from "../accel/shader-config.js";
import type { VolumeAccelerationBuffers } from "../accel/volume-acceleration.js";

/**
 * Hard cap on simultaneously-composited volume "layers" (item 7 of the feature plan, shelved/unused —
 * bound but never sampled by the shader today; see `viewer/state/layer-manager.ts`). WebGPU has no 3D
 * texture arrays and no reliable bindless-texture support, so each layer needs its own fixed
 * bind-group slot — this is that ceiling.
 *
 * Reduced from 6 to 5 when the second mask/annotation slot was added: the guaranteed-minimum
 * `maxSampledTexturesPerShaderStage` every conformant WebGPU implementation must support is 16, and
 * this pass's fixed sampled-texture count (6 existing + `MAX_LAYERS` shelved layer slots + 1 shared
 * TF atlas + 4 mask-slot textures with two mask slots) must not exceed that floor without an explicit,
 * checked reason to assume a higher device limit. At `MAX_LAYERS = 6` the total would be 17 (over
 * budget); at 5 it's exactly 16 (at the floor, not over it — safe on every conformant device). These
 * slots are unused today, so shrinking the reservation costs nothing now; it only lowers the ceiling
 * available if/when that shelved feature is ever built out for real, at which point this trade should
 * be revisited (e.g. via texture atlasing, per that feature's own design note) rather than exceeding
 * the guaranteed floor. The viewer's `LayerManager` imports this constant rather than redefining it.
 */
export const MAX_LAYERS = 5;

/**
 * First binding index after the (shelved) `MAX_LAYERS` slots + TF atlas. Two independent mask/
 * annotation slots (item 7 Phase B, extended to two slots so a host app can show two independent
 * per-voxel class predictions at once) each take two bindings: `MASK_BINDING_BASE + slot*2` (density
 * texture, `r8uint`) and `MASK_BINDING_BASE + slot*2 + 1` (palette, `rgba8unorm`) — unrelated to and
 * independent of the shelved layer-slot bindings above, both read via `textureLoad` (no sampler —
 * class IDs must never be interpolated), so no new sampler binding is needed either.
 */
export const MASK_BINDING_BASE = 14 + MAX_LAYERS + 1;

/** Fixed number of independent mask/annotation slots (see `MASK_BINDING_BASE`'s doc). Exactly two,
 * not generalized to N — see the task brief this was added for. */
export const MASK_SLOT_COUNT = 2;

/**
 * The subset of `VolumeAcceleration`'s shape the bind group needs. A structural type (rather than
 * importing the concrete class) keeps this module decoupled — same pattern as
 * `volume-uniforms.ts`'s `VolumeAccelerationLike`.
 */
export interface VolumeAccelerationBindingsLike {
  bindBuffers(spec: ShaderSpecialization): VolumeAccelerationBuffers;
  readonly lightBuffer: GPUBuffer;
  readonly visWriteBuffer: GPUBuffer;
  readonly shadowMapTexture: ManagedTexture;
  readonly densityPyramidTexture: ManagedTexture;
}

/** Per-frame resources the volume bind group reads. */
export interface VolumeBindingsParams {
  layout: GPUBindGroupLayout;
  frameUniform: ManagedBuffer;
  volumeTex: ManagedTexture;
  volumeSampler: GPUSampler;
  tfTex: ManagedTexture;
  tfSampler: GPUSampler;
  brickTex: ManagedTexture | undefined;
  preintTex: ManagedTexture;
  spec: ShaderSpecialization;
  acceleration: VolumeAccelerationBindingsLike;
  /**
   * Per-slot layer density textures (index = GPU slot, `0..MAX_LAYERS-1`). A missing/`undefined` slot
   * binds `volumeTex` as a dummy, same fallback pattern as `brickTex ?? volumeTex` — nothing samples
   * these bindings yet, this only keeps the bind group valid for every declared layout entry.
   */
  layerTex?: readonly (ManagedTexture | undefined)[];
  /** Shared transfer-function atlas (one row per layer slot). Falls back to `tfTex` when unset. */
  layerTfTex?: ManagedTexture;
  /**
   * Two independent mask/annotation density textures (`r8uint`) and their palettes (`rgba8unorm`, one
   * row's worth of class-id → color+opacity entries each), index = slot (`0..MASK_SLOT_COUNT-1`).
   * Required (not optional with an internal fallback) — the caller resolves real-vs-dummy itself, same
   * pattern as `preintTex`, since a dummy must be a genuinely valid `r8uint`/`rgba8unorm` texture
   * (unlike `brickTex`, nothing else bound here has a compatible format to reuse as a fallback).
   */
  maskTex: readonly [ManagedTexture, ManagedTexture];
  maskPaletteTex: readonly [ManagedTexture, ManagedTexture];
}

/** Owns the volume ray-march pass's single per-frame `GPUBindGroup`. */
export class VolumeBindings {
  private bindGroup: GPUBindGroup | undefined;

  public constructor(private readonly device: GPUDevice) {}

  /** Force the next `ensure()` call to rebuild (e.g. a texture/buffer binding changed). */
  public invalidate(): void {
    this.bindGroup = undefined;
  }

  /** Build (or reuse) the bind group for the current frame's resources. */
  public ensure(params: VolumeBindingsParams): GPUBindGroup {
    if (this.bindGroup) return this.bindGroup;
    const { occBuf, prefixBuf, tileBuf } = params.acceleration.bindBuffers(params.spec);
    this.bindGroup = this.device.createBindGroup({
      label: "volume",
      layout: params.layout,
      entries: [
        { binding: 0, resource: { buffer: params.frameUniform.gpu } },
        { binding: 1, resource: params.volumeTex.createView({ dimension: "3d" }) },
        { binding: 2, resource: params.volumeSampler },
        { binding: 3, resource: params.tfTex.createView({ dimension: "2d" }) },
        { binding: 4, resource: params.tfSampler },
        { binding: 5, resource: { buffer: params.acceleration.lightBuffer } },
        {
          binding: 6,
          resource: (params.brickTex ?? params.volumeTex).createView({ dimension: "3d" }),
        },
        { binding: 7, resource: { buffer: params.acceleration.visWriteBuffer } },
        { binding: 8, resource: { buffer: occBuf } },
        { binding: 9, resource: { buffer: prefixBuf } },
        { binding: 10, resource: { buffer: tileBuf } },
        { binding: 11, resource: params.preintTex.createView({ dimension: "2d" }) },
        {
          binding: 12,
          resource: params.acceleration.shadowMapTexture.createView({ dimension: "3d" }),
        },
        {
          binding: 13,
          resource: params.acceleration.densityPyramidTexture.createView({ dimension: "3d" }),
        },
        ...Array.from({ length: MAX_LAYERS }, (_, i) => ({
          binding: 14 + i,
          resource: (params.layerTex?.[i] ?? params.volumeTex).createView({ dimension: "3d" as const }),
        })),
        {
          binding: 14 + MAX_LAYERS,
          resource: (params.layerTfTex ?? params.tfTex).createView({ dimension: "2d" }),
        },
        ...Array.from({ length: MASK_SLOT_COUNT }, (_, slot) => [
          {
            binding: MASK_BINDING_BASE + slot * 2,
            resource: params.maskTex[slot]!.createView({ dimension: "3d" as const }),
          },
          {
            binding: MASK_BINDING_BASE + slot * 2 + 1,
            resource: params.maskPaletteTex[slot]!.createView({ dimension: "2d" as const }),
          },
        ]).flat(),
      ],
    });
    return this.bindGroup;
  }
}
