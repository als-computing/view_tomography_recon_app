/**
 * GPU storage buffer of {@link GpuLight}s (std430) + {@link LightingEnvironment} shared across
 * forward / volume / gem paths.
 *
 * @packageDocumentation
 */

import type { Disposable } from "@zarr-viewer/core";
import { Std430Builder } from "@zarr-viewer/math";
import type { Color3, Color3Like } from "@zarr-viewer/math";
import { asColor3 } from "@zarr-viewer/math";
import { ManagedBuffer } from "../resources/buffer.js";
import {
  GPU_LIGHT_STRIDE_BYTES,
  MAX_LIGHTS,
  type GpuLight,
} from "./types.js";
import { keyDirectionalFromLights } from "./extract.js";

/** Pack lights into a Float32Array with std430 layout (64 bytes / light). */
export function packLightsStd430(lights: readonly GpuLight[], maxLights = MAX_LIGHTS): Float32Array {
  const n = Math.min(lights.length, maxLights);
  const builder = new Std430Builder();
  for (let i = 0; i < n; i++) {
    const L = lights[i]!;
    builder.vec4(
      L.positionKind[0]!,
      L.positionKind[1]!,
      L.positionKind[2]!,
      L.positionKind[3]!,
    );
    builder.vec4(
      L.colorIntensity[0]!,
      L.colorIntensity[1]!,
      L.colorIntensity[2]!,
      L.colorIntensity[3]!,
    );
    builder.vec4(
      L.directionRange[0]!,
      L.directionRange[1]!,
      L.directionRange[2]!,
      L.directionRange[3]!,
    );
    builder.vec4(L.spotRect[0]!, L.spotRect[1]!, L.spotRect[2]!, L.spotRect[3]!);
  }
  // Always reserve at least one light slot so the storage buffer is non-empty for WebGPU.
  if (n === 0) {
    builder.vec4(0, 0, 0, 0);
    builder.vec4(0, 0, 0, 0);
    builder.vec4(0, 1, 0, 0);
    builder.vec4(0, 0, 0, 0);
  }
  return builder.finish();
}

/** Byte size for a light storage buffer holding up to `capacity` lights. */
export function lightBufferByteSize(capacity = MAX_LIGHTS): number {
  return Math.max(1, capacity) * GPU_LIGHT_STRIDE_BYTES;
}

/**
 * Shared lighting state: GPU light list + ambient. Forward binds the storage buffer; volume/gem
 * read {@link keyLightDirection} / {@link keyLightRadiance} for their single-key paths until full
 * multi-light volume shading lands.
 */
export class LightingEnvironment implements Disposable {
  private buffer: ManagedBuffer | undefined;
  private _lights: GpuLight[] = [];
  private _ambient: Color3 = [0.12, 0.13, 0.16];
  private _keyDir: [number, number, number] = [0.4, 1, 0.5];
  private _keyColor: [number, number, number] = [1, 1, 1];
  private _keyIntensity = 1;
  /** Phase 2 placeholder — set when IBL cubemaps exist. */
  public ibl: unknown = undefined;

  public constructor(
    public readonly device: GPUDevice,
    public readonly capacity = MAX_LIGHTS,
  ) {
    this.buffer = new ManagedBuffer(
      device,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      lightBufferByteSize(capacity),
    );
    this.upload([]);
  }

  public get lightCount(): number {
    return this._lights.length;
  }

  public get lights(): readonly GpuLight[] {
    return this._lights;
  }

  public get ambient(): Color3 {
    return this._ambient;
  }

  public setAmbient(color: Color3Like): void {
    this._ambient = asColor3(color, [0, 0, 0]);
  }

  /**
   * Phase 2 stub — attach prefiltered IBL (irradiance + specular mips + BRDF LUT).
   * No-op until the IBL compute pipeline lands; keeps the API surface stable.
   */
  public setIbl(_ibl: unknown): void {
    this.ibl = _ibl;
  }

  public get keyLightDirection(): readonly [number, number, number] {
    return this._keyDir;
  }

  /** Key light color × intensity (matches legacy `findLight` radiance). */
  public get keyLightRadiance(): readonly [number, number, number] {
    return [
      this._keyColor[0]! * this._keyIntensity,
      this._keyColor[1]! * this._keyIntensity,
      this._keyColor[2]! * this._keyIntensity,
    ];
  }

  public get gpu(): GPUBuffer {
    if (!this.buffer) throw new Error("LightingEnvironment disposed");
    return this.buffer.gpu;
  }

  /** Replace the light list and upload to the GPU. */
  public setLights(lights: readonly GpuLight[]): void {
    this.upload(lights);
  }

  private upload(lights: readonly GpuLight[]): void {
    const capped = lights.slice(0, this.capacity);
    this._lights = capped;
    const key = keyDirectionalFromLights(capped);
    this._keyDir = [key.dir[0]!, key.dir[1]!, key.dir[2]!];
    this._keyColor = [key.color[0]!, key.color[1]!, key.color[2]!];
    this._keyIntensity = key.intensity;
    const packed = packLightsStd430(capped, this.capacity);
    // Write only the used prefix (+ at least one slot).
    const bytes = Math.max(GPU_LIGHT_STRIDE_BYTES, capped.length * GPU_LIGHT_STRIDE_BYTES);
    this.buffer!.write(packed.subarray(0, bytes / 4));
  }

  public dispose(): void {
    this.buffer?.dispose();
    this.buffer = undefined;
    this._lights = [];
  }
}
