/**
 * WebGPU device/context acquisition and canvas configuration.
 *
 * {@link createContext} is the entry point for every visual demo: it requests an adapter/device,
 * obtains a `webgpu` canvas context, and configures the preferred swapchain format. The returned
 * {@link GpuContext} is passed to {@link "../renderer".Renderer}.
 *
 * @packageDocumentation
 */

import { PrismError } from "@zarr-viewer/core";

/** Options for acquiring a WebGPU device. */
export interface DeviceOptions {
  /** Prefer a high-performance (discrete) adapter. */
  powerPreference?: GPUPowerPreference;
  /** Required device features (e.g. "float32-filterable" for volume rendering). */
  requiredFeatures?: GPUFeatureName[];
  /** Canvas alpha compositing mode. Defaults to "opaque". */
  alphaMode?: GPUCanvasAlphaMode;
}

/** The acquired GPU context bundle. */
export interface GpuContext {
  readonly adapter: GPUAdapter;
  readonly device: GPUDevice;
  readonly canvas: HTMLCanvasElement;
  readonly canvasContext: GPUCanvasContext;
  /** The preferred canvas texture format for the current platform. */
  readonly format: GPUTextureFormat;
  /**
   * Whether the device can *linearly filter* 32-bit-float textures. When true the volume can use a
   * filterable `r32float` texture for full precision; otherwise `r16float` is the highest-precision
   * filterable option.
   */
  readonly supportsFloat32Filtering: boolean;
}

/**
 * Acquire a WebGPU device and configure the canvas for rendering.
 *
 * @throws {@link @zarr-viewer/core#PrismError} with code `gpu_error` if WebGPU is unavailable or no
 * adapter/device can be acquired.
 * @example
 * ```ts
 * const ctx = await createContext(canvas, { powerPreference: "high-performance" });
 * ```
 */
export async function createContext(
  canvas: HTMLCanvasElement,
  options: DeviceOptions = {},
): Promise<GpuContext> {
  const gpu = (globalThis.navigator as Navigator | undefined)?.gpu;
  if (!gpu) {
    throw new PrismError("gpu_error", "WebGPU is not available in this environment (navigator.gpu is undefined)");
  }

  const adapter = await gpu.requestAdapter({
    powerPreference: options.powerPreference ?? "high-performance",
  });
  if (!adapter) {
    throw new PrismError("gpu_error", "No suitable GPU adapter was found");
  }

  // Auto-enable float32 linear filtering when the adapter supports it, so the volume can opt into a
  // filterable r32float texture for full precision. Merged (deduped) with any caller-required features.
  const wantFloat32Filterable = adapter.features.has("float32-filterable");
  const requiredFeatures = Array.from(
    new Set<GPUFeatureName>([
      ...(options.requiredFeatures ?? []),
      ...(wantFloat32Filterable ? (["float32-filterable"] as GPUFeatureName[]) : []),
      ...(adapter.features.has("timestamp-query") ? (["timestamp-query"] as GPUFeatureName[]) : []),
    ]),
  );

  // Volume uploads go through an internal WebGPU staging buffer sized to the whole level, which can be
  // hundreds of MiB — well past the 256 MiB default `maxBufferSize`. Raise the buffer/binding limits to
  // what the adapter actually supports so `writeTexture` for a large level doesn't fail validation.
  // `maxColorAttachmentBytesPerSample` similarly needs raising past the 32-byte default: the volume
  // pass's 5 MRT outputs (color + depth-centroid + the Milestone 6 / B3 G-buffer targets) total 34
  // bytes/sample, and the spec-default limit only guarantees 32.
  const requiredLimits: Record<string, number> = {
    maxBufferSize: adapter.limits.maxBufferSize,
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    maxColorAttachmentBytesPerSample: adapter.limits.maxColorAttachmentBytesPerSample,
  };

  const device = await adapter.requestDevice({ requiredFeatures, requiredLimits });
  const supportsFloat32Filtering = device.features.has("float32-filterable");

  const canvasContext = canvas.getContext("webgpu");
  if (!canvasContext) {
    throw new PrismError("gpu_error", "Failed to acquire a 'webgpu' canvas context");
  }

  const format = gpu.getPreferredCanvasFormat();
  canvasContext.configure({
    device,
    format,
    alphaMode: options.alphaMode ?? "opaque",
  });

  return { adapter, device, canvas, canvasContext, format, supportsFloat32Filtering };
}
