/**
 * GPU texture helpers: 2D/3D/cube textures, depth targets, and uploads. 3D textures back volume
 * rendering.
 *
 * @packageDocumentation
 */

import { PrismError } from "@zarr-viewer/core";
import type { Disposable } from "@zarr-viewer/core";

/** Description for creating a texture. */
export interface TextureDesc {
  size: readonly [number, number, number];
  format: GPUTextureFormat;
  dimension?: GPUTextureDimension;
  usage: GPUTextureUsageFlags;
  mipLevelCount?: number;
  sampleCount?: number;
}

/**
 * Bytes per texel for the `GPUTextureFormat`s this codebase actually creates (volume/mask/render-
 * target/depth textures — see call sites of `ManagedTexture`/`device.createTexture`). Not a complete
 * `GPUTextureFormat` table — Phase 4c hardening (GPU memory accounting) only needs formats already in
 * use; an unrecognized format falls back to a documented estimate rather than throwing, since this
 * feeds a best-effort memory *estimate*, not something that should crash the app.
 */
export function bytesPerTexel(format: GPUTextureFormat): number {
  switch (format) {
    case "r8unorm":
    case "r8uint":
      return 1;
    case "r16float":
      return 2;
    case "rgba8unorm":
    case "r32float":
    case "depth24plus":
    case "depth32float":
      return 4;
    case "rg32float":
    case "rgba16float":
      return 8;
    case "rgba32float":
      return 16;
    default:
      return 4; // unrecognized format — reasonable middle-ground estimate, not exact
  }
}

/** A managed GPU texture with a cached default view. */
export class ManagedTexture implements Disposable {
  private texture: GPUTexture | undefined;

  public constructor(
    public readonly device: GPUDevice,
    public readonly desc: TextureDesc,
  ) {
    this.texture = device.createTexture({
      size: { width: desc.size[0], height: desc.size[1], depthOrArrayLayers: desc.size[2] },
      format: desc.format,
      dimension: desc.dimension ?? "2d",
      usage: desc.usage,
      mipLevelCount: desc.mipLevelCount ?? 1,
      sampleCount: desc.sampleCount ?? 1,
    });
  }

  /** Convenience constructor for a depth (and optional stencil) target sized to the canvas. */
  public static depthTarget(
    device: GPUDevice,
    width: number,
    height: number,
    format: GPUTextureFormat = "depth24plus",
    sampleCount = 1,
  ): ManagedTexture {
    return new ManagedTexture(device, {
      size: [width, height, 1],
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
      sampleCount,
    });
  }

  /**
   * Multisampled color target used as an MSAA render attachment that resolves into the canvas
   * swapchain (which itself cannot be multisampled in WebGPU).
   */
  public static msaaColorTarget(
    device: GPUDevice,
    width: number,
    height: number,
    format: GPUTextureFormat,
    sampleCount: number,
  ): ManagedTexture {
    return new ManagedTexture(device, {
      size: [width, height, 1],
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
      sampleCount,
    });
  }

  /** Estimated GPU bytes this texture occupies — full mip chain, `sampleCount` multiplied in (MSAA
   * targets store one sample-plane per sample). Phase 4c hardening: lets memory-accounting code (e.g.
   * `getMemoryStats()`) read a texture's size generically instead of each caller re-deriving it. */
  public get sizeBytes(): number {
    const [w, h, d] = this.desc.size;
    const texelBytes = bytesPerTexel(this.desc.format);
    const mipLevelCount = this.desc.mipLevelCount ?? 1;
    let total = 0;
    for (let level = 0; level < mipLevelCount; level++) {
      const lw = Math.max(1, w >> level);
      const lh = Math.max(1, h >> level);
      const ld = Math.max(1, d >> level);
      total += lw * lh * ld * texelBytes;
    }
    return total * (this.desc.sampleCount ?? 1);
  }

  /** The underlying GPU texture. */
  public get gpu(): GPUTexture {
    if (!this.texture) throw new PrismError("gpu_error", "ManagedTexture has been disposed");
    return this.texture;
  }

  /** Create a fresh default {@link GPUTextureView}. */
  public createView(descriptor?: GPUTextureViewDescriptor): GPUTextureView {
    return this.gpu.createView(descriptor);
  }

  public dispose(): void {
    this.texture?.destroy();
    this.texture = undefined;
  }
}
