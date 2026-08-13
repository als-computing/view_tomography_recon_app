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
