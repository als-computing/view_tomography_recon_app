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

  const device = await adapter.requestDevice({
    requiredFeatures: options.requiredFeatures ?? [],
  });

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

  return { adapter, device, canvas, canvasContext, format };
}
