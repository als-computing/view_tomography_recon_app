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
 * The subset of `VolumeAcceleration`'s shape the bind group needs. A structural type (rather than
 * importing the concrete class) keeps this module decoupled — same pattern as
 * `volume-uniforms.ts`'s `VolumeAccelerationLike`.
 */
export interface VolumeAccelerationBindingsLike {
  bindBuffers(spec: ShaderSpecialization): VolumeAccelerationBuffers;
  readonly lightBuffer: GPUBuffer;
  readonly visWriteBuffer: GPUBuffer;
  readonly shadowMapTexture: ManagedTexture;
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
  preintBuffer: ManagedBuffer;
  spec: ShaderSpecialization;
  acceleration: VolumeAccelerationBindingsLike;
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
        { binding: 11, resource: { buffer: params.preintBuffer.gpu } },
        {
          binding: 12,
          resource: params.acceleration.shadowMapTexture.createView({ dimension: "3d" }),
        },
      ],
    });
    return this.bindGroup;
  }
}
