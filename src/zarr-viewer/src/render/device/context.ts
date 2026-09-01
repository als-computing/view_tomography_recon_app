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
  /**
   * Whether the device's `maxColorAttachmentBytesPerSample` covers the volume pass's current 6-target
   * pipeline (1 `rgba16float` color + 1 `r16float` depth + 4 `rgba16float` G-buffer = 42 bytes/sample —
   * see `GBUFFER_PIPELINE_BYTES_PER_SAMPLE`). The WebGPU spec only *guarantees* 32; this app requests
   * the adapter's real max (see `createContext`), so on typical desktop hardware this is `true`, but a
   * constrained device (older/mobile GPU) could genuinely be capped at the 32-byte floor. `false` here
   * means volume-pipeline creation will fail — checked eagerly (see `VolumePipeline.ensure()`) so that
   * shows up as one clear, actionable error instead of an opaque WebGPU pipeline-validation failure.
   * A true bandwidth-reduced pipeline variant that works within 32 bytes/sample is tracked as a
   * follow-up (see the hardening plan's Phase 1b) — this flag only lets the failure mode be legible in
   * the meantime, it doesn't yet make the app actually run on such a device.
   */
  readonly supportsGbufferTargets: boolean;
}

/** Bytes/sample the volume pass's current fixed pipeline needs: 1 rgba16float color (8) + 1 r16float
 * depth (2) + 4 rgba16float G-buffer targets (4×8=32) = 42. See `GpuContext.supportsGbufferTargets`. */
export const GBUFFER_PIPELINE_BYTES_PER_SAMPLE = 42;

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
  // pass's 6 MRT outputs (color + depth-centroid + the Milestone 6 / B3 G-buffer targets) total 42
  // bytes/sample (`GBUFFER_PIPELINE_BYTES_PER_SAMPLE`) — comfortably under typical desktop adapters'
  // real max, but the spec-default floor only guarantees 32 (see `GpuContext.supportsGbufferTargets`).
  const requiredLimits: Record<string, number> = {
    maxBufferSize: adapter.limits.maxBufferSize,
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    maxColorAttachmentBytesPerSample: adapter.limits.maxColorAttachmentBytesPerSample,
  };

  const device = await adapter.requestDevice({ requiredFeatures, requiredLimits });
  const supportsFloat32Filtering = device.features.has("float32-filterable");
  const supportsGbufferTargets =
    device.limits.maxColorAttachmentBytesPerSample >= GBUFFER_PIPELINE_BYTES_PER_SAMPLE;

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

  return { adapter, device, canvas, canvasContext, format, supportsFloat32Filtering, supportsGbufferTargets };
}
