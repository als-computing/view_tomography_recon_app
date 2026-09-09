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
import {
  createContext,
  VolumeRenderer,
  TransferFunction,
  BrickAtlas,
  uploadRegionToAtlasSlot,
} from "@zarr-viewer/render";
import {
  constantVolume,
  sphereVolume,
  uploadSyntheticVolume,
  multiRegionVolume,
  chunkedMultiLevelSource,
  downsample2x,
  elongatedMarkerVolume,
  uploadAnisotropicVolume,
  type SyntheticVolume,
} from "./fixtures.js";

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
  /** Item 9 stage 9c's multi-brick fixture only: a second sample set from an otherwise-identical render
   * with both brick slots disabled, so the spec can directly compare "with bricks" vs "without" instead
   * of reasoning about absolute pixel values. */
  samplesNoBrick?: Record<SampleName, [number, number, number, number]>;
  /** The anisotropic-occlusion fixture only: a second sample set from the SAME scene/camera rendered
   * with `shaderConfig: "baseline"` (no occupancy/tiles at all) instead of `"fast"` — the ground-truth
   * comparison, since baseline can't wrongly cull/leap-skip real content by construction. */
  samplesBaseline?: Record<SampleName, [number, number, number, number]>;
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

/** The camera every fixture in this harness shares: a fixed front-on perspective view looking down -z
 * at the origin. Kept as one shared setup (not per-fixture) so a world position's approximate on-screen
 * placement is consistent and reusable across fixtures (e.g. the multi-brick fixture below places its
 * two regions at world x = ∓0.25 specifically because that's the scale `sphereVolume`'s own nearLeft/
 * nearRight symmetry checks already prove maps cleanly onto this exact camera's UV 0.4/0.6). */
function makeCamera(): { eye: { x: number; y: number; z: number }; viewProj: Mat4; fovY: number; aspect: number } {
  const eye = { x: 0, y: 0, z: 2.2 };
  const fovY = (42 * Math.PI) / 180;
  const aspect = WIDTH / HEIGHT;
  const view = new Mat4().lookAt(eye, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
  const proj = new Mat4().perspective(fovY, aspect, 0.1, 10);
  const viewProj = new Mat4().multiplyMatrices(proj, view);
  return { eye, viewProj, fovY, aspect };
}

/** Record one offscreen frame from an already-configured `renderer` and read back the named sample
 * points. Shared by every fixture below so the G-buffer/pipeline-attachment boilerplate (real, and
 * easy to get subtly wrong — see this file's own header comment on the swapchain-vs-offscreen finding)
 * lives in exactly one place. */
async function renderAndSample(
  ctx: Awaited<ReturnType<typeof createContext>>,
  renderer: VolumeRenderer,
): Promise<Record<SampleName, [number, number, number, number]>> {
  const { eye, viewProj, fovY, aspect } = makeCamera();
  // The ray-march shader deliberately builds its ray direction from this explicit camera-basis state
  // (right/up/forward + FOV), NOT from invViewProj (which loses float32 precision at extreme zoom-out —
  // see volume-raymarch.ts's own comment on `rd`). Skipping this call leaves the renderer's default
  // basis (forward=[0,0,1]) in effect regardless of the actual eye/viewProj, pointing every ray away
  // from wherever the camera is actually set up to look — found by hand this session: without it,
  // density data never affects the render at all (every ray misses), easy to mistake for an upload/
  // binding bug since nothing else about it is wrong.
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
  return samples;
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

    const samples = await renderAndSample(ctx, renderer);
    if (gpuErrors.length > 0) return { ok: false, error: gpuErrors.join(" | "), samples };
    return { ok: true, samples };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? `${err.message}\n${err.stack}` : String(err) };
  }
}

/**
 * Item 9 stage 9c: two disjoint fine ("hot spot") regions, each uploaded into its own `BrickAtlas`
 * slot via the real production `uploadRegionToAtlasSlot` path (the same code `ResidencyController`
 * uses), placed over the left/right halves of a uniform, dim `baseline`-density coarse volume (with a
 * real gap around world x=0). Renders twice — once with both slots enabled, once with both disabled
 * (blend 0, same coarse volume/camera/TF otherwise) — so the spec can directly compare "with bricks" vs
 * "without" rather than reasoning about absolute pixel values: `nearLeft`/`nearRight` should each change
 * between the two renders (and differ from each other, since the two regions hold different density
 * values), while `center` — in the gap between them — should not change at all.
 */
async function runMultiBrickFixture(): Promise<FixtureResult> {
  try {
    const canvas = document.getElementById("gpu-canvas") as HTMLCanvasElement;
    const ctx = await createContext(canvas, { powerPreference: "high-performance" });
    const gpuErrors: string[] = [];
    ctx.device.addEventListener("uncapturederror", (e) => {
      gpuErrors.push((e as GPUUncapturedErrorEvent).error.message);
    });

    // sampleDensity()'s brick blend deliberately requires the COARSE volume to already show some
    // signal (`smoothstep(0.02, 0.08, coarse)`) before it engages at all - "sharpen where coarse
    // already has signal," never inject brand-new detail into empty-looking coarse air (see
    // volume-raymarch.ts's own comment). So `BASELINE` must clear ~0.08 with real margin, or the brick
    // blend gets suppressed regardless of how different the brick's own density is.
    const BASELINE = 0.15;
    const coarseTexture = await uploadSyntheticVolume(ctx.device, constantVolume(32, BASELINE));

    // A 64^3 finest-level source with two distinct hot-value cubes, chunked (chunkSize=16, so each
    // 16-voxel-wide hotspot spans multiple chunks - a real chunk-boundary-crossing readRegion fetch,
    // not a single-chunk shortcut) and given a real (if unused-here) coarser level 1 via downsample2x,
    // exercising the same multi-level `VolumeSource` shape `chooseAtlasBrickRegion` searches over.
    const HOT_A = 1.0;
    const HOT_B = 0.25;
    const fineLevel0 = multiRegionVolume(64, BASELINE, [
      { center: [16, 32, 32], halfSize: 8, value: HOT_A },
      { center: [48, 32, 32], halfSize: 8, value: HOT_B },
    ]);
    const source = chunkedMultiLevelSource([fineLevel0, downsample2x(fineLevel0)], 16);

    const SLOT_SIZE = 16;
    const atlas = new BrickAtlas(ctx.device, 2, 1, 1, SLOT_SIZE, "r16float");
    await uploadRegionToAtlasSlot(ctx.device, atlas, 0, source, 0, [8, 24, 24], [24, 40, 40]);
    await uploadRegionToAtlasSlot(ctx.device, atlas, 1, source, 0, [40, 24, 24], [56, 40, 40]);

    const renderer = new VolumeRenderer(ctx, {
      colorFormat: OFFSCREEN_FORMAT,
      blendMode: "composite",
      densityScale: 3,
      stepSize: 1 / 128,
      exposure: 1.5,
      ambient: 0.4,
    });
    renderer.setVolume(coarseTexture);
    renderer.setTransferFunction(
      new TransferFunction([
        { position: 0, color: [1, 1, 1, 0] },
        { position: 1, color: [1, 1, 1, 1] },
      ]),
    );
    renderer.setBrickAtlas(atlas.texture, SLOT_SIZE);
    // Deliberately generous, half-volume-sized world boxes (not a small cube tightly matching the
    // uploaded voxel extent) - since each atlas slot's whole 16^3 content is a UNIFORM hot value (the
    // extracted voxel range exactly equals the hotspot's own extent, see above), stretching its world
    // placement doesn't introduce any non-uniformity, and a big box removes the fragile dependency on
    // hand-computing exactly where a perspective camera ray crosses a small world-space box. Left half
    // (x in [-0.5,-0.05]) for slot 0, right half (x in [0.05,0.5]) for slot 1, leaving a real gap around
    // x=0 that must stay coarse-only.
    renderer.setBrickSlot(0, {
      worldMin: [-0.5, -0.5, -0.5],
      worldMax: [-0.05, 0.5, 0.5],
      atlasOrigin: atlas.slotVoxelOrigin(0),
    });
    renderer.setBrickSlot(1, {
      worldMin: [0.05, -0.5, -0.5],
      worldMax: [0.5, 0.5, 0.5],
      atlasOrigin: atlas.slotVoxelOrigin(1),
    });

    renderer.setBrickSlotBlend(0, 1);
    renderer.setBrickSlotBlend(1, 1);
    const samples = await renderAndSample(ctx, renderer);

    renderer.setBrickSlotBlend(0, 0);
    renderer.setBrickSlotBlend(1, 0);
    const samplesNoBrick = await renderAndSample(ctx, renderer);

    atlas.dispose();
    if (gpuErrors.length > 0) return { ok: false, error: gpuErrors.join(" | "), samples, samplesNoBrick };
    return { ok: true, samples, samplesNoBrick };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? `${err.message}\n${err.stack}` : String(err) };
  }
}

/**
 * A genuinely anisotropic (non-cubic) elongated volume, viewed end-on down its own long axis from a
 * zoomed-out camera — the exact scenario found live this session to trigger real occupancy-grid/tile-
 * culling bugs (`fast`/`quality` only; `baseline` never uses either), and one no prior fixture in this
 * file could reproduce at all (every other fixture is a cube). A single small, bright marker sits near
 * the FAR end of the long axis (away from the camera), with empty space filling almost the entire rest
 * of the volume in between — a ray straight down the view axis must correctly traverse that whole empty
 * span (via the occupancy empty-space leap) and still composite the marker at the far end. Renders the
 * SAME scene/camera twice: once with `shaderConfig: "fast"` (occupancy + tiles both on) and once with
 * `"baseline"` (neither) as ground truth — if `fast` wrongly leaps past or culls the marker, its
 * `center` sample will read as background while baseline's doesn't.
 */
async function runAnisotropicOcclusionFixture(): Promise<FixtureResult> {
  try {
    const canvas = document.getElementById("gpu-canvas") as HTMLCanvasElement;
    const ctx = await createContext(canvas, { powerPreference: "high-performance" });
    const gpuErrors: string[] = [];
    ctx.device.addEventListener("uncapturederror", (e) => {
      gpuErrors.push((e as GPUUncapturedErrorEvent).error.message);
    });

    // 32x32x133: the long (z) axis is deliberately NOT a multiple of MACROCELL_VOXELS (8) - 133/8 =
    // 16.625 - so the occupancy grid's own construction (voxel-anchored, truncated-at-the-edge cells)
    // and the raymarch shader's cell lookup have real room to drift apart if they ever disagree.
    const dims: readonly [number, number, number] = [32, 32, 133];
    // Marker near voxel z=4 (close to the volume's z=0 face) - since the shared camera looks down -z
    // from the +z side, this is the FAR face from the camera's point of view, requiring the ray to
    // traverse almost the entire long axis of (empty) space before reaching it.
    const volume = elongatedMarkerVolume(dims, 0, [{ center: [16, 16, 4], halfSize: 3, value: 1 }]);
    const texture = await uploadAnisotropicVolume(ctx.device, volume);

    const renderer = new VolumeRenderer(ctx, {
      colorFormat: OFFSCREEN_FORMAT,
      blendMode: "composite",
      densityScale: 3,
      stepSize: 1 / 128,
      exposure: 1.5,
      ambient: 0.4,
      shaderConfig: "fast",
    });
    renderer.setVolume(texture);
    // Normalize world box half-extents to the volume's own aspect ratio (long axis half-extent 0.5,
    // matching the shared camera's own framing distance/near-far) instead of the default unit cube -
    // the whole point of this fixture is a genuinely elongated world box, not just elongated voxel
    // counts inside a cubic box.
    const maxDim = Math.max(dims[0], dims[1], dims[2]);
    renderer.setBoxHalfSize((0.5 * dims[0]) / maxDim, (0.5 * dims[1]) / maxDim, (0.5 * dims[2]) / maxDim);
    renderer.setTransferFunction(
      new TransferFunction([
        { position: 0, color: [1, 1, 1, 0] },
        { position: 1, color: [1, 1, 1, 1] },
      ]),
    );

    const { eye, viewProj, fovY, aspect } = makeCamera();
    renderer.setCameraBasis([1, 0, 0], [0, 1, 0], [0, 0, -1], fovY, aspect);

    const renderOnce = async (): Promise<Record<SampleName, [number, number, number, number]>> => {
      const target = ctx.device.createTexture({
        size: [WIDTH, HEIGHT, 1],
        format: OFFSCREEN_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      const gbuffer = [VOLUME_DEPTH_FORMAT, GBUFFER_FORMAT, GBUFFER_FORMAT, GBUFFER_FORMAT, GBUFFER_FORMAT].map(
        (format) =>
          ctx.device.createTexture({
            size: [WIDTH, HEIGHT, 1],
            format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
          }),
      );
      const encoder = ctx.device.createCommandEncoder({ label: "aniso-occlusion-frame" });
      // Occupancy rebuild + tile classify/compact - recordInto() itself never runs these (see this
      // file's own comment on VolumeRenderer.recordInto not calling runPrePasses), matching exactly how
      // the production render loop calls them as a separate step before the render pass.
      renderer.recordPrePasses(encoder, viewProj, eye);
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
      return samples;
    };

    const samples = await renderOnce();
    renderer.setShaderConfig("baseline");
    const samplesBaseline = await renderOnce();

    if (gpuErrors.length > 0) return { ok: false, error: gpuErrors.join(" | "), samples, samplesBaseline };
    return { ok: true, samples, samplesBaseline };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? `${err.message}\n${err.stack}` : String(err) };
  }
}

declare global {
  interface Window {
    runFixture: typeof runFixture;
    runMultiBrickFixture: typeof runMultiBrickFixture;
    runAnisotropicOcclusionFixture: typeof runAnisotropicOcclusionFixture;
  }
}
window.runFixture = runFixture;
window.runMultiBrickFixture = runMultiBrickFixture;
window.runAnisotropicOcclusionFixture = runAnisotropicOcclusionFixture;
