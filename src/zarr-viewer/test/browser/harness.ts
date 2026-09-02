/**
 * Playwright/WebGPU browser-test harness driver. Runs entirely in-page (loaded by `harness.html` via
 * Vite dev server) — sets up a bare `VolumeRenderer` (no `WebGpuVolumeViewer.ts`/HUD/session
 * machinery, none of which this needs), renders one synthetic fixture, and reads back sample pixels
 * for the Playwright test (`render.spec.ts`) to assert on.
 *
 * Renders to an **offscreen** `GPUTexture`, not the canvas swapchain (`VolumeRenderer.recordInto()`
 * directly, not its `render()` convenience wrapper which targets `canvasContext.getCurrentTexture()`).
 * Confirmed by hand this session: canvas swapchain presentation (`getCurrentTexture()`) is itself
 * broken under this headless-Chromium setup — even a minimal `configure()` + `getCurrentTexture()` +
 * `createView()` with no renderer involved fails validation ("invalid due to a previous error") in
 * this environment, independent of anything this codebase does. Rendering to a plain
 * `RENDER_ATTACHMENT | COPY_SRC` texture and reading it back via `copyTextureToBuffer`/`mapAsync`
 * sidesteps the swapchain entirely — a real GPU still does the actual rendering, this is purely a
 * different destination for the output, matching how `RenderGraph`/`FxPipeline` already render into
 * managed textures rather than the canvas directly.
 *
 * @packageDocumentation
 */

import { Mat4 } from "@zarr-viewer/math";
import { createContext, VolumeRenderer, TransferFunction } from "@zarr-viewer/render";
import { constantVolume, sphereVolume, uploadSyntheticVolume, type SyntheticVolume } from "./fixtures.js";

// Must match volume-pipeline.ts's fixed 6-target G-buffer pipeline exactly (colorFormat, depth,
// 4x G-buffer) - VolumeRenderer.recordInto() always records against this pipeline regardless of
// shaderConfig (see Phase 1b's own finding: "the main pipeline always declares 6 targets... and
// writes all 6 every frame regardless of whether the deferred pass runs"), so a render pass with
// fewer attachments is a pipeline/pass mismatch, not a valid "I don't need the G-buffer" shortcut.
const VOLUME_DEPTH_FORMAT: GPUTextureFormat = "r16float";
const GBUFFER_FORMAT: GPUTextureFormat = "rgba16float";

const FIXTURES: Record<string, () => SyntheticVolume> = {
  constant: () => constantVolume(),
  sphere: () => sphereVolume(),
};

const WIDTH = 256;
const HEIGHT = 256;
const OFFSCREEN_FORMAT: GPUTextureFormat = "rgba8unorm";

/** Normalized-UV sample points read back after rendering, shared by every test so the spec file can
 * name them instead of hardcoding pixel coordinates. */
export const SAMPLE_POINTS = {
  center: [0.5, 0.5],
  nearLeft: [0.4, 0.5],
  nearRight: [0.6, 0.5],
  nearTop: [0.5, 0.4],
  nearBottom: [0.5, 0.6],
  corner: [0.05, 0.05],
} as const;

export type SampleName = keyof typeof SAMPLE_POINTS;

export interface FixtureResult {
  ok: boolean;
  error?: string;
  samples?: Record<SampleName, [number, number, number, number]>;
}

/** Copy `tex` (RGBA8, `WIDTH`x`HEIGHT`) into a mappable buffer and read back just the sample points. */
async function readbackSamples(
  device: GPUDevice,
  tex: GPUTexture,
): Promise<Record<SampleName, [number, number, number, number]>> {
  const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;
  const buffer = device.createBuffer({
    size: bytesPerRow * HEIGHT,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: tex },
    { buffer, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const bytes = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();

  const out = {} as Record<SampleName, [number, number, number, number]>;
  for (const [name, [u, v]] of Object.entries(SAMPLE_POINTS) as [SampleName, readonly [number, number]][]) {
    const x = Math.min(WIDTH - 1, Math.max(0, Math.round(u * WIDTH)));
    const y = Math.min(HEIGHT - 1, Math.max(0, Math.round(v * HEIGHT)));
    const off = y * bytesPerRow + x * 4;
    out[name] = [bytes[off]!, bytes[off + 1]!, bytes[off + 2]!, bytes[off + 3]!];
  }
  return out;
}

async function runFixture(name: string): Promise<FixtureResult> {
  try {
    const build = FIXTURES[name];
    if (!build) return { ok: false, error: `unknown fixture: ${name}` };

    const canvas = document.getElementById("gpu-canvas") as HTMLCanvasElement;
    const ctx = await createContext(canvas, { powerPreference: "high-performance" });
    const gpuErrors: string[] = [];
    ctx.device.addEventListener("uncapturederror", (e) => {
      gpuErrors.push((e as GPUUncapturedErrorEvent).error.message);
    });

    const texture = await uploadSyntheticVolume(ctx.device, build());

    const renderer = new VolumeRenderer(ctx, {
      colorFormat: OFFSCREEN_FORMAT,
      blendMode: "composite",
      densityScale: 3,
      stepSize: 1 / 128,
      exposure: 1.5,
      ambient: 0.4,
    });
    renderer.setVolume(texture);
    // Plain linear ramp: alpha == density, color always white - the simplest tractable mapping, so
    // rendered brightness/opacity tracks density directly instead of some opinionated window/level
    // shaping getting in the way of the test's own assertions.
    renderer.setTransferFunction(
      new TransferFunction([
        { position: 0, color: [1, 1, 1, 0] },
        { position: 1, color: [1, 1, 1, 1] },
      ]),
    );

    const eye = { x: 0, y: 0, z: 2.2 };
    const fovY = (42 * Math.PI) / 180;
    const aspect = WIDTH / HEIGHT;
    const view = new Mat4().lookAt(eye, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    const proj = new Mat4().perspective(fovY, aspect, 0.1, 10);
    const viewProj = new Mat4().multiplyMatrices(proj, view);
    // The ray-march shader deliberately builds its ray direction from this explicit camera-basis
    // state (right/up/forward + FOV), NOT from invViewProj (which loses float32 precision at extreme
    // zoom-out — see volume-raymarch.ts's own comment on `rd`). Skipping this call leaves the
    // renderer's default basis (forward=[0,0,1]) in effect regardless of the actual eye/viewProj,
    // pointing every ray away from wherever the camera is actually set up to look — found by hand
    // this session: without it, density data never affects the render at all (every ray misses),
    // easy to mistake for an upload/binding bug since nothing else about it is wrong.
    renderer.setCameraBasis([1, 0, 0], [0, 1, 0], [0, 0, -1], fovY, aspect);

    const target = ctx.device.createTexture({
      size: [WIDTH, HEIGHT, 1],
      format: OFFSCREEN_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    // Depth-centroid + 4 G-buffer targets the pipeline always writes but this harness never reads -
    // still need real attachments (format/size must match what the pipeline was created for).
    const gbuffer = [VOLUME_DEPTH_FORMAT, GBUFFER_FORMAT, GBUFFER_FORMAT, GBUFFER_FORMAT, GBUFFER_FORMAT].map(
      (format) =>
        ctx.device.createTexture({
          size: [WIDTH, HEIGHT, 1],
          format,
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
        }),
    );
    const encoder = ctx.device.createCommandEncoder({ label: "browser-test-frame" });
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: target.createView(),
          clearValue: { r: 0.02, g: 0.03, b: 0.05, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
        ...gbuffer.map((tex) => ({
          view: tex.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear" as const,
          storeOp: "store" as const,
        })),
      ],
    });
    renderer.recordInto(pass, viewProj, eye);
    pass.end();
    ctx.device.queue.submit([encoder.finish()]);
    for (const tex of gbuffer) tex.destroy();

    const samples = await readbackSamples(ctx.device, target);
    target.destroy();
    if (gpuErrors.length > 0) return { ok: false, error: gpuErrors.join(" | "), samples };
    return { ok: true, samples };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? `${err.message}\n${err.stack}` : String(err) };
  }
}

declare global {
  interface Window {
    runFixture: typeof runFixture;
  }
}
window.runFixture = runFixture;
