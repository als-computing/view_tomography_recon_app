/**
 * Demo 26 — OME-Zarr volume viewer (Cosmovis / itk-vtk-viewer style).
 *
 * Panels: Data · TF · Render · Slices · Crop · Measure (click-to-pick feature).
 * Pan: Space+drag, Shift/Alt+left, middle, right, or trackpad sideways. Zoom toward cursor.
 * Pick: P then click, or Ctrl+click.
 */

import { units } from "@zarr-viewer/core";
import {
  openOmeZarr,
  httpStore,
  physicalSizeSim,
  volumeMaxExtentMeters,
  listUploadableLevels,
  pickConnectedFeature,
  type VolumeSource,
  type Store,
  type PickedFeature,
} from "@zarr-viewer/io";
import {
  createContext,
  VolumeLoader,
  type VolumeLevelResult,
  BrickLoader,
  chooseBrickRegion,
  type BrickResult,
  VolumeRenderer,
  composeTransferFunction,
  OpacityCurveEditor,
  type ColorMapName,
  type VolumeBlendMode,
  type VolumeViewMode,
  type ShaderConfigName,
  rankVisibilityBins,
  visBinUvwBox,
  stampCanvasPng,
} from "@zarr-viewer/render";
import { Scene, Node } from "@zarr-viewer/scene";
import { OrbitControls } from "@zarr-viewer/controls";
import { Mat4, Vec3 } from "@zarr-viewer/math";
import { bloom, tonemap, fxaa, sharpen, vignette, type ToneMapOperator, type Effect } from "@prism/fx";
import {
  createDemoSession,
  createDemoHud,
  type DemoHandle,
  resizeDemoCanvas,
} from "./demo-session.js";
import { ensureHudStyles } from "./hud-theme.js";
import { ViewportOverlay } from "./render/overlay/viewport-overlay.js";
import { FxPipeline } from "./render/post/fx-pipeline.js";
import { TemporalAccumulator } from "./render/accel/taau.js";
import {
  getLastRendering,
  setLastRendering,
  listPresetNames,
  getPreset,
  savePreset,
  deletePreset,
} from "./rendering-presets.js";
import {
  type WebGpuRenderingState,
  type WebGpuCroppingState,
  defaultRenderingState,
  defaultCroppingState,
  mergeDefined,
} from "./viewer/RenderingState.js";
import { zarrUrlFromQuery, pickZarrStore } from "./viewer/util.js";
import { autoWindow, buildEqualizeRemap, rebinThroughRemap } from "./viewer/histogram.js";
import { type PanelId, section, fmt } from "./viewer/ui/html.js";
import { cropIsSet, focalRoiUvw, rayDir } from "./viewer/volume/roi-geometry.js";
import { buildFrameLights } from "./viewer/rendering/lighting.js";
import {
  computeCameraBasis,
  computeNearFar,
  computeMeasurePlaneDepth,
  computeRuler,
  applyTaauJitter,
} from "./viewer/rendering/frameMath.js";
import {
  type CameraContext,
  frameSliceCamera as frameSliceCameraPure,
  enterViewMode as enterViewModePure,
  activeSlice as activeSlicePure,
  setActiveSlice as setActiveSlicePure,
} from "./viewer/camera/sliceView.js";
import { dataPanelBody } from "./viewer/ui/panels/dataPanel.js";
import { tfPanelBody } from "./viewer/ui/panels/tfPanel.js";
import { renderPanelBody } from "./viewer/ui/panels/renderPanel.js";
import { slicesPanelBody } from "./viewer/ui/panels/slicesPanel.js";
import { cropPanelBody } from "./viewer/ui/panels/cropPanel.js";
import { measurePanelBody } from "./viewer/ui/panels/measurePanel.js";
import { postfxPanelBody } from "./viewer/ui/panels/postfxPanel.js";
import { lightingPanelBody } from "./viewer/ui/panels/lightingPanel.js";
import { presetsPanelBody, sanitizeSelectedPreset } from "./viewer/ui/panels/presetsPanel.js";

export type { WebGpuRenderingState, WebGpuCroppingState } from "./viewer/RenderingState.js";

/** Change events emitted by a {@link WebGpuViewerInstance}. */
export type WebGpuViewerEvent = "cameraChange" | "renderingChange" | "croppingChange";

/**
 * Full, trackball-accurate camera pose (target + raw orbit offset + tumbling gaze-up + distance).
 * Mirrors the OrbitControls state so a pose copies between linked panes without losing roll.
 */
export interface WebGpuCameraState {
  target: [number, number, number];
  offset: [number, number, number];
  gazeUp: [number, number, number];
  distance: number;
}

/**
 * Imperative handle over a running WebGPU OME-Zarr viewer. Mirrors the shape of ItkVtkViewerInstance
 * so the split view can link two panes: get/set for camera, rendering and cropping, plus change
 * events that fire when the *user* drives those groups (never when a value is applied via a setter,
 * so a linked peer can apply a value without looping). `dispose()` tears the viewer down.
 */
export interface WebGpuViewerInstance {
  getCamera: () => WebGpuCameraState;
  setCamera: (state: WebGpuCameraState) => void;
  getRendering: () => WebGpuRenderingState;
  setRendering: (state: WebGpuRenderingState) => void;
  getCropping: () => WebGpuCroppingState;
  setCropping: (state: WebGpuCroppingState) => void;
  on: (event: WebGpuViewerEvent, cb: () => void) => void;
  off: (event: WebGpuViewerEvent, cb: () => void) => void;
  dispose: () => void;
}

export async function run(
  canvas: HTMLCanvasElement,
  options?: { zarrUrl?: string; hudMount?: HTMLElement },
): Promise<WebGpuViewerInstance> {
  const session = createDemoSession(canvas);
  resizeDemoCanvas(canvas);

  const ctx = await createContext(canvas, { powerPreference: "high-performance" });
  const maxTex = ctx.device.limits.maxTextureDimension3D;
  // Free the GPU device when the session disposes. Registered first so it runs LAST (dispose is
  // LIFO), after the volume textures/buffers are released — important when the host app repeatedly
  // toggles this renderer on and off, so WebGPU devices don't accumulate.
  session.onDispose(() => ctx.device.destroy());

  const valueRange: [number, number] = [-40, 40];
  // Everything that shapes the volume's appearance (transfer function + render params + view mode).
  // Everything that shapes the volume's appearance, and the ROI crop box + slice planes. Defaults
  // (see defaultRenderingState/defaultCroppingState) reproduce the viewer's original look.
  const rendering: WebGpuRenderingState = defaultRenderingState();
  let equalizeRemap: Float32Array | undefined; // CDF remap LUT while equalizeOn
  const cropping: WebGpuCroppingState = defaultCroppingState();
  const openSections = new Set<PanelId>(["tf", "render"]);
  let loading = false;
  // One-shot guard: apply the last-used rendering snapshot once, after this viewer's first level (and
  // thus its histogram) is ready. A ?share= link applied later by the app still wins.
  let bootRestoreDone = false;
  // Name currently chosen in the Presets dropdown (drives Apply/Delete; survives HUD rebuilds).
  let selectedPreset = "";
  let baseStep = 1 / 220;
  // Finer march step (world units) tied to a resident high-res ROI brick's voxel size. `baseStep` is
  // sized for the COARSE displayed level, so when zoomed into an L0/L1 brick the coarse step
  // under-samples it — the empty-space skip then steps right over thin fine structures and the region
  // looks sparse/blank. While a brick is up we march at its (floored) Nyquist step instead.
  let brickStep: number | undefined;
  let pickMode = false;
  let measuring = false;
  let lastPick: PickedFeature | undefined;
  let pickStatus = "";
  const invViewProj = new Mat4();
  const lastViewProj = new Mat4();
  // Scratch for the TAAU sub-pixel-jittered projection used only for the volume render (the un-jittered
  // viewProj still drives ROI/overlay). Reused each frame to avoid per-frame allocation.
  const jitterProj = new Mat4();
  const jitterViewProj = new Mat4();
  // Render-on-demand budget (see the frame loop). Any interaction / still-converging process tops it up;
  // at zero with a still camera the loop skips the expensive volume march and the last frame persists.
  let renderFrames = 3;
  let lastRenderCam: WebGpuCameraState | null = null;
  let lastRenderW = 0;
  let lastRenderH = 0;
  const requestRender = (): void => {
    renderFrames = Math.max(renderFrames, 3);
  };

  // Snapshot the rendering / cropping groups from the live closure state. Defined up here so the
  // early error-path instances (below) can expose them too. opacityPoints/cropMin/cropMax are
  // defensively copied so a caller mutating the returned object can't corrupt internal state.
  const readRendering = (): WebGpuRenderingState => ({
    ...rendering,
    opacityPoints: rendering.opacityPoints.map((p) => [p[0], p[1]] as const),
  });
  const readCropping = (): WebGpuCroppingState => ({
    ...cropping,
    cropMin: [cropping.cropMin[0], cropping.cropMin[1], cropping.cropMin[2]],
    cropMax: [cropping.cropMax[0], cropping.cropMax[1], cropping.cropMax[2]],
  });

  // Minimal instance for the failure paths (bad store / no uploadable LOD) — real get/set exist only
  // once the volume + controls are live. Keeps the return type uniform so callers always get a handle.
  const errorInstance = (handle: DemoHandle): WebGpuViewerInstance => ({
    getCamera: () => ({ target: [0, 0, 0], offset: [0, 0, 5], gazeUp: [0, 1, 0], distance: 5 }),
    setCamera: () => {},
    getRendering: readRendering,
    setRendering: () => {},
    getCropping: readCropping,
    setCropping: () => {},
    on: () => {},
    off: () => {},
    dispose: () => handle.dispose(),
  });

  const resolvedZarrUrl = options?.zarrUrl ?? zarrUrlFromQuery();
  // Identity for per-sample last-used rendering memory: switching back to a tab restores this sample's
  // own look rather than whatever another tab touched most recently (tabs are 1:1 with their Zarr URL).
  const sampleKey = resolvedZarrUrl;
  let store: Store = httpStore(resolvedZarrUrl);
  let source: VolumeSource;
  try {
    source = await openOmeZarr(store, { skipRangeEstimate: true, valueRange });
  } catch (err) {
    const hud = createDemoHud({ position: "bottom-left", pointerEvents: true });
    session.mountHud(hud);
    hud.innerHTML = `<strong>26 · OME-Zarr</strong><div style="margin-top:8px">${
      err instanceof Error ? err.message : String(err)
    }</div><div>Press O to open a folder.</div>`;
    return errorInstance(session.handle());
  }

  const allowedLevels = (): number[] =>
    listUploadableLevels(source, { maxTextureDimension: maxTex });

  let levels = allowedLevels();

  // Finest multiscale level we auto-stream to. 0 = finest/largest; higher = coarser. Full-res levels
  // (0/1) are too large to hold comfortably in a browser GPU for now, so the progressive loader stops
  // at level 2. Manual level buttons / `[` `]` remain escape hatches to go finer.
  const MIN_DISPLAY_LEVEL = 2;
  // Finest level we're willing to display: the finest available that isn't below MIN_DISPLAY_LEVEL,
  // or the coarsest level if the dataset has nothing that fine. `levels` is ascending (0 first).
  const finestTargetLevel = (): number =>
    levels.find((lv) => lv >= MIN_DISPLAY_LEVEL) ?? levels[levels.length - 1]!;

  if (levels.length === 0) {
    const hud = createDemoHud({ position: "bottom-left" });
    session.mountHud(hud);
    hud.textContent = `No uploadable LOD (GPU max 3D texture ${maxTex}).`;
    return errorInstance(session.handle());
  }
  let level = levels[levels.length - 1]!;

  const volumeRenderer = new VolumeRenderer(ctx, {
    stepSize: baseStep,
    densityScale: rendering.densityScale,
    // Safety cap only; the renderer derives per-frame step count from the box diagonal so the whole
    // depth is always marched (no backside clipping) regardless of orientation or sample distance.
    maxSteps: 4096,
    exposure: rendering.exposure,
    ambient: 0.22,
    clearColor: [0.015, 0.02, 0.035, 1],
    blendMode: rendering.blendMode,
    gradientOpacity: rendering.gradOpacity,
    gradientOpacityScale: rendering.gradScale,
    lightingStrength: rendering.lighting,
    // Render into a linear-HDR target so the post stack tonemaps once (the shader skips its inline
    // ACES+gamma). Both are construct-time only.
    colorFormat: "rgba16float",
    linearOutput: true,
  });

  // Post-processing driver: volume → linear HDR → bloom/tonemap/fxaa/sharpen/vignette → swapchain.
  const fxPipeline = new FxPipeline(ctx);
  // Milestone 5: progressive temporal accumulation (still-camera supersampling/denoise). Default off.
  const taau = new TemporalAccumulator(ctx.device);
  session.onDispose(() => taau.dispose());
  const rebuildFxStack = (): void => {
    const effects: Effect[] = [];
    // HDR-space effects first (bloom operates on linear HDR), then the mandatory tonemap maps
    // HDR→sRGB LDR, then the LDR effects (fxaa → sharpen → vignette).
    if (rendering.fxBloom) {
      effects.push(bloom({ threshold: rendering.fxBloomThreshold, intensity: rendering.fxBloomIntensity }));
    }
    effects.push(tonemap(rendering.fxOperator, { exposureStops: rendering.fxExposure }));
    if (rendering.fxFxaa) effects.push(fxaa());
    if (rendering.fxSharpen) effects.push(sharpen({ amount: rendering.fxSharpenAmount }));
    if (rendering.fxVignette) effects.push(vignette({ amount: rendering.fxVignetteAmount }));
    fxPipeline.setStack(effects);
  };
  rebuildFxStack();

  // Push the (non-per-frame) lighting params to the renderer + set the half-res lever. Called on any
  // Lighting-panel change; the light *positions* themselves are rebuilt per frame (below).
  const applyLighting = (): void => {
    requestRender();
    taau.reset(); // lighting changed → restart temporal accumulation
    volumeRenderer.setLightingParams({
      masterAmbient: rendering.lightAmbient,
      specStrength: rendering.lightSpecular,
      roughness: rendering.lightRoughness,
      shadowEnable: rendering.shadowOn,
      shadowSteps: rendering.shadowQuality,
      shadowStrength: rendering.shadowStrength,
      shadowSoftness: rendering.shadowSoftness,
      aoEnable: rendering.aoOn,
      aoRadius: rendering.aoRadius,
      aoIntensity: rendering.aoIntensity,
      aoSamples: rendering.aoSamples,
    });
    fxPipeline.setRenderScale(rendering.halfRes ? 0.5 : 1);
  };

  applyLighting();

  const scene = new Scene();
  const camera = new Node("Camera");
  scene.root.add(camera);
  scene.attach(camera, {
    kind: "camera",
    enabled: true,
    projection: "perspective",
    fovY: (42 * Math.PI) / 180,
    near: 0.01,
    far: 1e6,
  });
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0, 0);
  controls.panSpeed = 2.4;
  controls.zoomToCursor = true;
  controls.fovY = (42 * Math.PI) / 180;
  controls.damping = 10;
  // Keep minDistance large enough that perspective near/far stay float32-stable for DVR rays.
  controls.minDistance = 0.05;
  controls.maxDistance = 1e6;
  controls.filterPointer = (e) => {
    // In slice views, plain wheel scrubs the plane; Ctrl/Meta+wheel still zooms.
    // Trackpad sideways / Shift+wheel still reach OrbitControls for pan.
    if (e instanceof WheelEvent && rendering.viewMode !== "volume" && !e.ctrlKey && !e.metaKey) {
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.25) return true;
      return false;
    }
    // Pick mode / Ctrl+click: don't orbit (Shift+left remains pan).
    if (
      e instanceof PointerEvent &&
      e.type === "pointerdown" &&
      e.button === 0 &&
      (pickMode || e.ctrlKey || e.metaKey)
    ) {
      return false;
    }
    return true;
  };
  session.onDispose(() => controls.dispose());

  // Bottom-left overlay over the render viewport: axis gizmo + physical scale bar (redrawn each frame).
  const overlay = new ViewportOverlay(canvas.parentElement ?? document.body);
  session.onDispose(() => overlay.dispose());

  const readCamera = (): WebGpuCameraState => controls.getState();

  const sim = units.UNIT_PRESETS.microscopy;
  const sizeSim = new Vec3();
  let histogram: Float32Array | undefined; // the DISPLAYED histogram (equalized when equalizeOn)
  let rawHistogram: Float32Array | undefined; // the true distribution (percentiles + toggling equalize)
  let curveEditor: OpacityCurveEditor | undefined;

  // Progressive coarse→fine loader: owns the per-level GPU textures and streams finer levels toward
  // `targetLevel`, never downgrading what's displayed. `level` tracks the level currently on screen.
  const loader = new VolumeLoader(ctx.device, {
    supportsFloat32Filtering: ctx.supportsFloat32Filtering,
  });
  session.onDispose(() => loader.dispose());
  let loaderOpened = false;
  let targetLevel = level;
  let frameExtent = 1;

  // High-res ROI brick: stream + composite a fine sub-volume over the coarse base when zoomed in (or a
  // crop ROI is set), and fade it out / discard on zoom-out (see BrickLoader + the shader composite).
  const brickLoader = new BrickLoader(ctx.device, {
    supportsFloat32Filtering: ctx.supportsFloat32Filtering,
  });
  session.onDispose(() => brickLoader.dispose());
  let roiEnabled = false;
  let brickBlendCurrent = 0;
  let brickBlendTarget = 0;
  let brickLevel: number | undefined;
  let lastRoiKey = "";
  let lastRegion:
    | { level: number; voxelMin: [number, number, number]; voxelMax: [number, number, number] }
    | null = null;
  let roiIdle = 0;
  // Adaptive sampling: while the camera moves, coarsen the ray step (≥ NAV_SAMPLE_DIST) for a smooth
  // framerate, then ease back to the configured `sampleDist` once settled. `navSampleDist` is the
  // eased, currently-applied multiplier.
  const NAV_SAMPLE_DIST = 1.5; // coarse step multiplier held during navigation
  const NAV_SETTLE = 0.15; // seconds of camera stillness before refining back to the configured value
  let navSampleDist = 1;
  let taauPrevSettled = false; // tracks the moving↔settled edge so TAAU reseeds fine detail on settle
  let roiRequestInFlight = false; // a brick request is streaming (drives the reset guard + progress bar)
  let roiReqSeq = 0; // monotonic id so a superseded request's finally() can't clobber a newer one
  let prevRoiCam = controls.getState();
  const ROI_SETTLE = 0.2; // seconds of camera stillness before (re)streaming
  // Milestone 1: only consult the visibility feedback once the camera has been still long enough for the
  // async vis-bin readback to reflect the current view — using it during motion is what made it thrash.
  const ROI_HINT_SETTLE = 0.45;

  // ROI stream progress for the HUD bar. Updated per chunk; the bar's DOM is patched directly (rAF-
  // throttled) so per-chunk progress never triggers a full HUD rebuild.
  let roiProgress: { loaded: number; total: number } | null = null;
  let roiProgressPaintQueued = false;
  const paintRoiProgress = (): void => {
    if (roiProgressPaintQueued) return;
    roiProgressPaintQueued = true;
    requestAnimationFrame(() => {
      roiProgressPaintQueued = false;
      const wrap = ui.querySelector<HTMLElement>("#roiProgressWrap");
      if (!wrap) return;
      if (!roiProgress) {
        wrap.style.display = "none";
        return;
      }
      wrap.style.display = "";
      const pct = roiProgress.total ? Math.round((roiProgress.loaded / roiProgress.total) * 100) : 0;
      const fill = ui.querySelector<HTMLElement>("#roiProgressFill");
      const label = ui.querySelector<HTMLElement>("#roiProgressLabel");
      if (fill) fill.style.width = `${pct}%`;
      if (label) label.textContent = `${roiProgress.loaded}/${roiProgress.total} chunks`;
    });
  };

  brickLoader.onBrick((b: BrickResult) => {
    volumeRenderer.setBrick(b.texture, b.worldMin, b.worldMax);
    brickLevel = b.level;
    // March at the brick's voxel size (floored so the step count stays well under maxSteps and the ray
    // still reaches the far face) instead of the coarse level's — otherwise the fine brick is
    // under-sampled and looks sparse/blank when zoomed in.
    const [bsx, bsy, bsz] = source.spacingAt(b.level);
    brickStep = Math.max(
      Math.max(
        units.toSim(new units.Quantity(bsx, units.LENGTH), sim),
        units.toSim(new units.Quantity(bsy, units.LENGTH), sim),
        units.toSim(new units.Quantity(bsz, units.LENGTH), sim),
      ) * 0.55,
      frameExtent / 2000,
      // Perf cap: never shrink the GLOBAL step more than ~2.9× vs coarse (the fine step is marched
      // across the whole ray, so an unbounded fine step explodes the step count).
      baseStep * 0.35,
    );
    applyRender();
    brickBlendTarget = 1;
    renderUi();
  });
  brickLoader.onClear(() => {
    volumeRenderer.setBrick(null);
    brickLevel = undefined;
    brickStep = undefined;
    applyRender();
    roiProgress = null;
    paintRoiProgress();
    renderUi();
  });
  brickLoader.onProgress((loaded, total) => {
    roiProgress = { loaded, total };
    paintRoiProgress();
  });

  // Per-frame ROI update: derive the region (crop override, else frustum when zoomed in), pick the
  // finest fitting level, and (debounced) request the brick; hysteresis + fade drive smooth zoom-out.
  const updateRoi = (dt: number): void => {
    const cs = controls.getState();
    if (!camsEqual(cs, prevRoiCam)) { roiIdle = 0; prevRoiCam = cs; } else { roiIdle += dt; }

    let want = 0; // brick blend target this frame (a loaded brick is on screen)
    let desired = false; // we intend to keep a high-res brick this frame (a finer region applies)
    if (roiEnabled) {
      const cropSet = cropIsSet(cropping.cropMin, cropping.cropMax);
      // Crop box overrides the focal box; otherwise use the depth-bounded frustum slab.
      const roi: { min: [number, number, number]; max: [number, number, number] } | null = cropSet
        ? { min: [cropping.cropMin[0], cropping.cropMin[1], cropping.cropMin[2]], max: [cropping.cropMax[0], cropping.cropMax[1], cropping.cropMax[2]] }
        : focalRoiUvw(invViewProj, lastViewProj, sizeSim, camera.position);
      if (roi) {
        const vis = volumeRenderer.visibility;
        let visHint: { min: [number, number, number]; max: [number, number, number] } | undefined;
        if (roiEnabled && vis.enabled && roiIdle >= ROI_HINT_SETTLE) {
          const ranked = rankVisibilityBins(vis.lastQuantized, vis.grid, {
            levelCount: source.levelCount,
            boxExtent: Math.max(sizeSim.x, sizeSim.y, sizeSim.z),
            eye: [camera.position.x, camera.position.y, camera.position.z],
            boxHalf: [sizeSim.x * 0.5, sizeSim.y * 0.5, sizeSim.z * 0.5],
            residentLevelOf: (x, y, z) => {
              const box = visBinUvwBox(x, y, z, vis.grid);
              const cx = (box.min[0] + box.max[0]) * 0.5;
              const cy = (box.min[1] + box.max[1]) * 0.5;
              const cz = (box.min[2] + box.max[2]) * 0.5;
              const brick = brickLoader.currentBrick;
              if (brick) {
                const wx = cx * sizeSim.x - sizeSim.x * 0.5;
                const wy = cy * sizeSim.y - sizeSim.y * 0.5;
                const wz = cz * sizeSim.z - sizeSim.z * 0.5;
                if (
                  wx >= brick.worldMin[0] && wx <= brick.worldMax[0] &&
                  wy >= brick.worldMin[1] && wy <= brick.worldMax[1] &&
                  wz >= brick.worldMin[2] && wz <= brick.worldMax[2]
                ) {
                  return brick.level;
                }
              }
              return level;
            },
          });
          const top = ranked[0];
          if (top && top.priority > 0) {
            const box = visBinUvwBox(top.x, top.y, top.z, vis.grid);
            const pad = 0.05;
            visHint = {
              min: [
                Math.max(0, box.min[0] - pad),
                Math.max(0, box.min[1] - pad),
                Math.max(0, box.min[2] - pad),
              ],
              max: [
                Math.min(1, box.max[0] + pad),
                Math.min(1, box.max[1] + pad),
                Math.min(1, box.max[2] + pad),
              ],
            };
          }
        }
        // Region to stream = the stable frustum/crop box (uniform coverage over the whole visible slab).
        // Milestone 1's visibility feedback does NOT replace it (a single resident brick can't chase a
        // per-bin hint without thrash/eviction); instead `visHint` steers the shrink below toward the
        // most-looked-at sub-region when the box is too big to admit a finer level.
        const regionBox = roi;
        const regionOpts = { maxTextureDimension: maxTex };
        let region = chooseBrickRegion(source, regionBox.min, regionBox.max, regionOpts);
        // If the generous box is too big for a finer-than-displayed level (typical when the far
        // frustum inflates from one viewing side), shrink toward the box center until one fits.
        if (!(region && region.level < level)) {
          // Shrink toward the most-looked-at sub-region (visibility hint) when we have one, else the box
          // centre. Clamp into the box so the shrink stays valid. This is the ray-guided part of M1: when
          // the visible slab is too big for a finer level, prioritise the detail the user is fixated on.
          const clampToBox = (v: number, a: number): number =>
            Math.min(regionBox.max[a]!, Math.max(regionBox.min[a]!, v));
          const cu: [number, number, number] = visHint
            ? [
                clampToBox((visHint.min[0] + visHint.max[0]) * 0.5, 0),
                clampToBox((visHint.min[1] + visHint.max[1]) * 0.5, 1),
                clampToBox((visHint.min[2] + visHint.max[2]) * 0.5, 2),
              ]
            : [
                (regionBox.min[0] + regionBox.max[0]) * 0.5,
                (regionBox.min[1] + regionBox.max[1]) * 0.5,
                (regionBox.min[2] + regionBox.max[2]) * 0.5,
              ];
          let mn: [number, number, number] = [regionBox.min[0], regionBox.min[1], regionBox.min[2]];
          let mx: [number, number, number] = [regionBox.max[0], regionBox.max[1], regionBox.max[2]];
          for (let k = 0; k < 8 && !(region && region.level < level); k++) {
            for (let a = 0; a < 3; a++) {
              mn[a] = cu[a]! + (mn[a]! - cu[a]!) * 0.7;
              mx[a] = cu[a]! + (mx[a]! - cu[a]!) * 0.7;
            }
            region = chooseBrickRegion(source, mn, mx, regionOpts);
          }
        }
        // Engage whenever a finer-than-displayed level fits the focal box (no zoom threshold — the
        // depth-bounded box only admits a finer level once you're zoomed in enough for it to fit).
        if (region && region.level < level) {
          desired = true; // a finer region applies → hold onto its request key across the load
          const dims = source.dimensionsAt(region.level);
          // Snap the voxel box to a grid so sub-voxel camera drift doesn't re-request (and abort) the
          // brick every frame; the ROI only changes when it moves by ≥ Q voxels.
          const Q = 32;
          const voxelMin: [number, number, number] = [0, 0, 0];
          const voxelMax: [number, number, number] = [0, 0, 0];
          for (let a = 0; a < 3; a++) {
            const d = dims[a]!;
            voxelMin[a] = Math.max(0, Math.floor(region.voxelMin[a]! / Q) * Q);
            voxelMax[a] = Math.min(d, Math.max(voxelMin[a] + Q, Math.ceil(region.voxelMax[a]! / Q) * Q));
          }
          // Skip if the resident brick (same level) already covers this box — small moves reuse it.
          const covered =
            lastRegion !== null &&
            lastRegion.level === region.level &&
            voxelMin[0] >= lastRegion.voxelMin[0] && voxelMin[1] >= lastRegion.voxelMin[1] &&
            voxelMin[2] >= lastRegion.voxelMin[2] && voxelMax[0] <= lastRegion.voxelMax[0] &&
            voxelMax[1] <= lastRegion.voxelMax[1] && voxelMax[2] <= lastRegion.voxelMax[2];
          const key = `${region.level}:${voxelMin.join(",")}:${voxelMax.join(",")}`;
          // (Re)stream a genuinely new, settled region. A newer region SUPERSEDES an in-flight one
          // (request() aborts the stale fetch), so the brick for where the user actually is loads
          // promptly instead of waiting out the old load. Finishing the stale brick first is what made
          // the high-res ROI briefly drop to coarse / go blank when moving mid-load. Same-key requests
          // are still blocked (key === lastRoiKey) and ROI_SETTLE debounces motion, so this can't flood.
          if (!covered && key !== lastRoiKey && roiIdle >= ROI_SETTLE) {
            lastRoiKey = key;
            lastRegion = { level: region.level, voxelMin, voxelMax };
            const half = [sizeSim.x * 0.5, sizeSim.y * 0.5, sizeSim.z * 0.5];
            const full = [sizeSim.x, sizeSim.y, sizeSim.z];
            const wmin: [number, number, number] = [0, 0, 0];
            const wmax: [number, number, number] = [0, 0, 0];
            for (let a = 0; a < 3; a++) {
              wmin[a] = -half[a]! + (voxelMin[a] / dims[a]!) * full[a]!;
              wmax[a] = -half[a]! + (voxelMax[a] / dims[a]!) * full[a]!;
            }
            const reqId = ++roiReqSeq;
            roiRequestInFlight = true;
            void brickLoader
              .request({ source, level: region.level, voxelMin, voxelMax, worldMin: wmin, worldMax: wmax })
              .finally(() => {
                if (reqId !== roiReqSeq) return; // superseded — the newer request owns the flag + bar
                roiRequestInFlight = false;
                roiProgress = null; // hide the bar once the latest stream settles (loaded / failed)
                paintRoiProgress();
              });
          }
          if (brickLoader.currentBrick) want = 1;
        }
      }
    }
    // Forget the resident request key only when no brick is desired (ROI off / zoomed out) and nothing
    // is mid-flight — NOT merely because the brick isn't visible yet. Resetting while a request was in
    // flight made the loader re-request the same box on the frame it finished (and endlessly retry a
    // failed/aborted fetch), flooding the network and never settling on higher-res detail.
    if (!desired && !roiRequestInFlight) {
      lastRoiKey = "";
      lastRegion = null;
    }
    brickBlendTarget = want;

    // Fade the brick weight toward the target (~150 ms); clear once fully faded out.
    const diff = brickBlendTarget - brickBlendCurrent;
    brickBlendCurrent += Math.sign(diff) * Math.min(Math.abs(diff), 6 * dt);
    volumeRenderer.setBrickBlend(brickBlendCurrent);
    if (brickBlendCurrent <= 0.001 && brickBlendTarget === 0 && brickLoader.currentBrick) {
      brickLoader.clear();
    }
  };

  ensureHudStyles();
  const docked = options?.hudMount != null;
  const ui = document.createElement("div");
  ui.className = docked ? "whud whud--docked" : "whud whud--floating";
  if (docked) {
    options!.hudMount!.appendChild(ui);
    session.onDispose(() => ui.remove());
  } else {
    session.mountHud(ui);
  }
  session.onDispose(() => curveEditor?.dispose());

  // --- Change-event fan-out (for linking two split panes) -----------------------------------------
  // Listeners fire only from genuine user actions (HUD handlers + the camera poll in the render
  // loop), never from the set* methods below — so a linked peer can apply a value without looping.
  const viewerListeners: Record<WebGpuViewerEvent, Set<() => void>> = {
    cameraChange: new Set(),
    renderingChange: new Set(),
    croppingChange: new Set(),
  };
  const emit = (event: WebGpuViewerEvent): void => {
    for (const cb of viewerListeners[event]) {
      try {
        cb();
      } catch (err) {
        console.warn(`webgpu viewer ${event} listener failed:`, err);
      }
    }
  };
  // Auto-remember the current look as "last used" so a new sample/session inherits it. Debounced so
  // dragging a slider doesn't hammer localStorage; the trailing write captures the settled value.
  let lastRenderingSaveTimer: ReturnType<typeof setTimeout> | undefined;
  const emitRendering = (): void => {
    emit("renderingChange");
    if (lastRenderingSaveTimer) clearTimeout(lastRenderingSaveTimer);
    lastRenderingSaveTimer = setTimeout(() => {
      setLastRendering(readRendering() as unknown as Record<string, unknown>, sampleKey);
    }, 400);
  };
  session.onDispose(() => {
    if (lastRenderingSaveTimer) clearTimeout(lastRenderingSaveTimer);
  });
  const emitCropping = (): void => emit("croppingChange");
  // Clear the crop box back to "no crop" (the full [0,1]^3 volume) and repaint.
  const resetCrop = (): void => {
    cropping.cropMin = [0, 0, 0];
    cropping.cropMax = [1, 1, 1];
    applyRender();
    renderUi();
    emitCropping();
  };
  // Baseline for the render-loop camera poll: last pose we announced (or applied from a peer), so the
  // poll only emits on a real delta and never echoes a value pushed in via setCamera().
  let lastCam: WebGpuCameraState | null = null;

  // --- Whole-panel collapse ----------------------------------------------------------------------
  // Collapses the entire docked sidebar to a thin strip (or the floating panel to just its header),
  // leaving a chevron to re-expand. The canvas backing store re-fits to its widened CSS box on the
  // next render-loop frame (resizeDemoCanvas runs every frame); we also nudge it immediately.
  let collapsed = false;
  const expandedWidth = docked ? options!.hudMount!.style.width || "320px" : "";
  const applyCollapsed = (): void => {
    ui.classList.toggle("whud--collapsed", collapsed);
    if (docked) {
      const host = options!.hudMount!;
      host.style.width = collapsed ? "30px" : expandedWidth;
      host.style.overflow = collapsed ? "hidden" : "auto";
    }
    // Reading clientWidth below forces a synchronous reflow, so the canvas picks up its new box now.
    resizeDemoCanvas(canvas);
  };

  const lengthUnit = (): units.Unit =>
    units.resolveLengthUnit(source.spacingUnitName) ?? units.micrometer;
  const um3 = (): units.Unit =>
    lengthUnit().pow(3).labeled(`${lengthUnit().symbol}³`, `cubic ${lengthUnit().name}`);

  const applyTf = (): void => {
    const tf = composeTransferFunction({
      opacity: rendering.opacityPoints,
      colorMap: rendering.colorMap,
      colorRange: [rendering.colorLo, rendering.colorHi],
      opacityScale: rendering.opacityScale,
      samples: 48,
      intensityRemap: rendering.equalizeOn ? equalizeRemap : undefined,
    });
    volumeRenderer.setTransferFunction(tf, 512);
    requestRender();
    taau.reset(); // transfer function / colormap changed → restart temporal accumulation
    curveEditor?.setColorMap(rendering.colorMap);
    curveEditor?.setPoints(rendering.opacityPoints);
    curveEditor?.setColorRange([rendering.colorLo, rendering.colorHi]);
  };

  // Recompute the equalize remap + displayed histogram from the raw distribution and current toggle.
  const recomputeEqualize = (): void => {
    if (rendering.equalizeOn && rawHistogram) {
      equalizeRemap = buildEqualizeRemap(rawHistogram, rendering.equalizeClip);
      histogram = rebinThroughRemap(rawHistogram, equalizeRemap);
    } else {
      equalizeRemap = undefined;
      histogram = rawHistogram;
    }
  };

  const applyRender = (): void => {
    requestRender();
    taau.reset(); // any render-setting change → restart temporal accumulation
    volumeRenderer.setParams({
      densityScale: rendering.densityScale,
      exposure: rendering.exposure,
      stepSize: Math.min(brickStep ?? baseStep, baseStep) * rendering.sampleDist,
      blendMode: rendering.blendMode,
      gradientOpacity: rendering.gradOpacity,
      gradientOpacityScale: rendering.gradScale,
      lightingStrength: rendering.lighting,
    });
    volumeRenderer.setViewMode(rendering.viewMode);
    volumeRenderer.setSlices(cropping.sliceX, cropping.sliceY, cropping.sliceZ);
    volumeRenderer.setSliceEnabled("x", cropping.enX);
    volumeRenderer.setSliceEnabled("y", cropping.enY);
    volumeRenderer.setSliceEnabled("z", cropping.enZ);
    volumeRenderer.setSlicePlanesVisible(cropping.showPlanes);
    volumeRenderer.setCrop(cropping.cropMin, cropping.cropMax);
    volumeRenderer.setShaderConfig(rendering.shaderConfig);
    // Visibility feedback drives Milestone 1's ray-guided streaming (steers the ROI shrink toward the
    // most-looked-at region). Only consulted once the camera settles (ROI_HINT_SETTLE), so it no longer
    // thrashes. The per-sample accumulation is a bounded atomicAdd below the empty-space skip.
    volumeRenderer.setVisibilityFeedback(roiEnabled);
  };

  const cameraCtx: CameraContext = { controls, camera, sizeSim };

  /** Frame camera looking along the active slice normal (itk-vtk style). */
  const frameSliceCamera = (): void =>
    frameSliceCameraPure(cameraCtx, rendering.viewMode, {
      x: cropping.sliceX,
      y: cropping.sliceY,
      z: cropping.sliceZ,
    });

  const enterViewMode = (mode: VolumeViewMode, reframe = true): void =>
    enterViewModePure(cameraCtx, mode, rendering, cropping, applyRender, reframe);

  // Switch view mode (and, for the plane modes, the slice it enables) then notify listeners — view
  // mode carries both a render mode and slice enables/overlays, so both change events fire together.
  const setViewModeAndEmit = (
    mode: VolumeViewMode,
    opts?: { openSlices?: boolean; skipRenderUi?: boolean },
  ): void => {
    enterViewMode(mode, true);
    if (opts?.openSlices) openSections.add("slices");
    if (!opts?.skipRenderUi) renderUi();
    emitRendering();
    emitCropping();
  };

  const activeSlice = (): { axis: "x" | "y" | "z"; value: number } | null =>
    activeSlicePure(rendering, cropping);

  const setActiveSlice = (v: number): void => setActiveSlicePure(v, rendering, cropping, applyRender);

  const sliceWorldLabel = (axis: "x" | "y" | "z", t: number): string => {
    const u = lengthUnit();
    const size = axis === "x" ? sizeSim.x : axis === "y" ? sizeSim.y : sizeSim.z;
    // sizeSim is already in microscopy units (µm-scale numbers). Convert via SI for display.
    const halfSi = units.fromSim(size * 0.5, units.LENGTH, sim);
    const pos = halfSi.mul(2 * t - 1);
    return `${pos.to(u).toFixed(1)} ${u.symbol}`;
  };

  // Apply a (possibly partial) rendering snapshot: every field falls back to the current value, so this
  // safely restores a saved preset / last-used look, a linked peer's full state, or a Share link. It
  // deliberately touches only appearance — never camera or cropping. Callers decide whether to emit.
  const applyRenderingState = (state: Partial<WebGpuRenderingState>): void => {
    requestRender();
    // shaderConfig gets its own runtime validation (state may come from untyped localStorage/preset
    // JSON) — strip it from the generic merge unless it's one of the three known-valid names.
    const { shaderConfig: rawShaderConfig, opacityPoints: rawOpacityPoints, ...rest } = state;
    mergeDefined(rendering, rest);
    if (rawShaderConfig === "baseline" || rawShaderConfig === "fast" || rawShaderConfig === "quality") {
      rendering.shaderConfig = rawShaderConfig;
    }
    if (Array.isArray(rawOpacityPoints)) {
      rendering.opacityPoints = rawOpacityPoints.map((p) => [p[0], p[1]] as const);
    }
    taau.setEnabled(rendering.temporalAA);
    recomputeEqualize(); // rebuild the remap + displayed histogram from this viewer's own data
    applyTf();
    applyRender();
    rebuildFxStack();
    applyLighting();
    renderUi();
  };

  // Called by the loader each time a (finer) level's texture becomes ready. Swaps the volume, updates
  // the histogram + ray step for the displayed resolution, and clears "loading" once target is reached.
  const onDisplayedLevel = (result: VolumeLevelResult): void => {
    level = result.level;
    volumeRenderer.setVolume(result.texture);
    rawHistogram = result.histogram;
    recomputeEqualize(); // sets `histogram` (equalized when on) + refreshes the remap for this level
    // First frame with real data: inherit the last-used look so a new sample/session picks up where the
    // user left off. Runs once; equalize/histogram are ready by now so the restore is faithful.
    if (!bootRestoreDone) {
      bootRestoreDone = true;
      const saved = getLastRendering(sampleKey);
      if (saved) {
        try {
          applyRenderingState(saved as Partial<WebGpuRenderingState>);
          // Pin the restored look as this sample's own memory immediately, so a later remount (after the
          // keep-alive grace expires) restores what this tab showed — even if another tab has since
          // changed the shared/global snapshot.
          setLastRendering(readRendering() as unknown as Record<string, unknown>, sampleKey);
        } catch (err) {
          console.warn("rendering-presets: boot restore failed:", err);
        }
      }
    }
    if (histogram) curveEditor?.setHistogram(histogram);
    if (rendering.equalizeOn) applyTf(); // the remap changed with the new level's distribution
    const [sx, sy, sz] = source.spacingAt(level);
    baseStep = Math.max(
      Math.max(
        units.toSim(new units.Quantity(sx, units.LENGTH), sim),
        units.toSim(new units.Quantity(sy, units.LENGTH), sim),
        units.toSim(new units.Quantity(sz, units.LENGTH), sim),
      ) * 0.55,
      frameExtent / 400,
    );
    loading = level !== targetLevel; // still streaming toward a finer target
    applyRender();
    renderUi();
  };
  loader.onLevel(onDisplayedLevel);

  // Aim the loader at `next` and (re)frame. Framing is level-independent (all multiscale levels cover
  // the same physical extent), so it's applied from the target before any texture lands. The loader
  // streams coarsest→target and never downgrades what's shown, so requesting a level coarser than the
  // one displayed is a no-op ("avoid going back to low res").
  const applyLevel = (next: number, reframe = false): void => {
    if (!levels.includes(next)) return;
    targetLevel = next;
    lastPick = undefined;
    pickStatus = "";
    physicalSizeSim(sizeSim, source, sim, next);
    volumeRenderer.setBoxHalfSize(sizeSim.x * 0.5, sizeSim.y * 0.5, sizeSim.z * 0.5);
    frameExtent = Math.max(sizeSim.x, sizeSim.y, sizeSim.z);
    controls.minDistance = Math.max(frameExtent * 0.001, 0.01); // was frameExtent * 0.02
    // Cap zoom-out so the volume can't recede to a sub-pixel speck (and so eye-space magnitudes stay
    // float32-stable). ~20× the largest extent still frames the whole volume comfortably.
    controls.maxDistance = frameExtent * 20;
    // Pin the orbit pivot to the volume's bounds. With zoom-to-cursor, scrolling out with the cursor
    // over empty background otherwise slides the target off into the void; the eye trails it at a fixed
    // maxDistance and the volume recedes past float32 range and vanishes. Bounding the pivot to the box
    // (the AABB is centred at the world origin with half-extents sizeSim/2) caps the eye's absolute
    // distance from the data. See OrbitControls.targetBounds.
    controls.targetBounds = {
      min: new Vec3(-sizeSim.x * 0.5, -sizeSim.y * 0.5, -sizeSim.z * 0.5),
      max: new Vec3(sizeSim.x * 0.5, sizeSim.y * 0.5, sizeSim.z * 0.5),
    };
    if (reframe) {
      if (rendering.viewMode === "volume") {
        controls.distance = frameExtent * 2.2;
        camera.position.set(frameExtent * 1.2, frameExtent * 0.85, frameExtent * 1.2);
        controls.syncFromNode();
        controls.update(0);
      } else {
        frameSliceCamera();
      }
    }
    loading = true;
    if (!loaderOpened) {
      loaderOpened = true;
      loader.open(source, levels, targetLevel);
    } else {
      loader.setTargetLevel(targetLevel);
    }
    renderUi();
  };

  const runPickAt = async (clientX: number, clientY: number): Promise<void> => {
    if (measuring || loading) return;
    measuring = true;
    pickStatus = "Picking…";
    renderUi();
    try {
      const rect = canvas.getBoundingClientRect();
      const u = ((clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1;
      const v = -(((clientY - rect.top) / Math.max(rect.height, 1)) * 2 - 1);
      invViewProj.copy(lastViewProj);
      if (!invViewProj.invert()) {
        pickStatus = "Pick failed (bad camera matrix).";
        lastPick = undefined;
        return;
      }
      const [dx, dy, dz] = rayDir(invViewProj, u, v);
      const eye = camera.position;
      const feature = await pickConnectedFeature(source, {
        level,
        ray: {
          origin: [eye.x, eye.y, eye.z],
          direction: [dx, dy, dz],
        },
        boxHalf: [sizeSim.x * 0.5, sizeSim.y * 0.5, sizeSim.z * 0.5],
        hitDensity: Math.max(valueRange[1] * 0.15, 2),
        relativeLow: 0.55,
        maxRegionVoxels: 2_000_000,
      });
      if (!feature) {
        lastPick = undefined;
        pickStatus = "No feature under cursor (try a denser region or lower LOD).";
        return;
      }
      lastPick = feature;
      cropping.cropMin = [...feature.cropMin] as [number, number, number];
      cropping.cropMax = [...feature.cropMax] as [number, number, number];
      applyRender();
      const u3 = um3();
      pickStatus = `Selected ${feature.voxelCount.toLocaleString()} voxels · ${feature.volume.to(u3).toExponential(3)} ${u3.symbol}`;
      openSections.add("measure");
    } catch (err) {
      lastPick = undefined;
      pickStatus = err instanceof Error ? err.message : String(err);
    } finally {
      measuring = false;
      renderUi();
    }
  };

  const renderUi = (): void => {
    requestRender(); // catch-all: any HUD interaction that rebuilds the panel also repaints the canvas
    curveEditor?.dispose();
    curveEditor = undefined;

    const [dx, dy, dz] = source.dimensionsAt(level);
    const unit = lengthUnit();

    const dataBody = dataPanelBody({ source, levels, level, loading, maxTex, unit });
    const tfBody = tfPanelBody(rendering);
    const renderBody = renderPanelBody(rendering);

    const active = activeSlice();
    const [nx, ny, nz] = source.dimensionsAt(level);
    const axisVoxelCount = active ? (active.axis === "x" ? nx : active.axis === "y" ? ny : nz) : 0;
    const slicesBody = slicesPanelBody({
      rendering,
      cropping,
      active,
      sliceWorldLabel: active ? sliceWorldLabel(active.axis, active.value) : "",
      axisVoxelCount,
    });

    const cropBody = cropPanelBody(cropping);
    const measureBody = measurePanelBody({ rendering, pickMode, pickStatus, lastPick, u3: um3() });
    const postfxBody = postfxPanelBody(rendering);
    const lightingBody = lightingPanelBody({ rendering, roiEnabled, roiProgress });

    // Presets section — sanitize the selection against the current preset list before rendering, so
    // it stays valid across preset add/remove and HUD rebuilds.
    const presetNames = listPresetNames();
    selectedPreset = sanitizeSelectedPreset(selectedPreset, presetNames);
    const presetsBody = presetsPanelBody(presetNames, selectedPreset);

    ui.innerHTML = [
      `<div class="whud__header">` +
        `<span class="whud__title">OME-Zarr viewer</span>` +
        `<button type="button" class="whud__collapse-btn" data-act="toggleCollapse" ` +
        `title="${collapsed ? "Expand panel" : "Collapse panel"}" ` +
        `aria-label="${collapsed ? "Expand panel" : "Collapse panel"}">${collapsed ? "\u2039" : "\u203A"}</button>` +
        `</div>`,
      `<div class="whud__status">L${level} · ${dx}×${dy}×${dz}${loading ? " · loading…" : ""}${pickMode ? " · PICK" : ""}${brickLevel !== undefined ? ` · ROI L${brickLevel}` : ""}</div>`,
      section(openSections, "data", "Data", dataBody),
      section(openSections, "tf", "Transfer Function", tfBody),
      section(openSections, "render", "Render", renderBody),
      section(openSections, "lighting", "Lighting", lightingBody),
      section(openSections, "slices", "Slices", slicesBody),
      section(openSections, "crop", "Crop", cropBody),
      section(openSections, "measure", "Measure", measureBody),
      section(openSections, "postfx", "Post FX", postfxBody),
      section(openSections, "presets", "Presets", presetsBody),
      `<div class="whud__hint">Pan: Space+drag / Shift / middle / right · wheel zooms to cursor · P / Ctrl+click pick · [ ] LOD · O open</div>`,
    ].join("");

    for (const el of ui.querySelectorAll<HTMLDetailsElement>("details.whud__section")) {
      const id = el.dataset.section as PanelId | undefined;
      if (!id) continue;
      el.addEventListener("toggle", () => {
        if (el.open) openSections.add(id);
        else openSections.delete(id);
      });
    }

    if (!collapsed && openSections.has("tf")) {
      const c = ui.querySelector<HTMLCanvasElement>("#opacity-curve");
      if (c) {
        curveEditor = new OpacityCurveEditor(c, rendering.opacityPoints, {
          colorMap: rendering.colorMap,
          colorRange: [rendering.colorLo, rendering.colorHi],
          onChange: (pts) => {
            rendering.opacityPoints = pts.map((p) => [p[0], p[1]] as const);
            applyTf();
            emitRendering();
          },
        });
        if (histogram) curveEditor.setHistogram(histogram);
      }
    }

    // Re-assert collapsed styling after the innerHTML rebuild (class + sidebar width).
    applyCollapsed();
  };

  ui.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button") as HTMLButtonElement | null;
    if (!btn) return;
    if (btn.dataset.act === "toggleCollapse") {
      collapsed = !collapsed;
      renderUi();
      return;
    }
    if (btn.dataset.level != null) {
      void applyLevel(Number(btn.dataset.level));
      return;
    }
    if (btn.dataset.blend) {
      rendering.blendMode = btn.dataset.blend as VolumeBlendMode;
      applyRender();
      renderUi();
      emitRendering();
      return;
    }
    if (btn.dataset.shader) {
      rendering.shaderConfig = btn.dataset.shader as ShaderConfigName;
      applyRender();
      renderUi();
      emitRendering();
      return;
    }
    if (btn.dataset.act === "exportPng") {
      void (async () => {
        const blob = await stampCanvasPng(
          canvas,
          volumeRenderer.provenance(fxPipeline.renderScale),
        );
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `tomo-${rendering.shaderConfig}.png`;
        a.click();
        URL.revokeObjectURL(url);
      })();
      return;
    }
    if (btn.dataset.view) {
      setViewModeAndEmit(btn.dataset.view as VolumeViewMode, { openSlices: true });
      return;
    }
    if (btn.dataset.act === "resetCrop") {
      resetCrop();
      return;
    }
    if (btn.dataset.act === "frameSlice") {
      frameSliceCamera();
      return;
    }
    if (btn.dataset.act === "autoContrast") {
      // Percentile auto-window from the true distribution → color levels; refresh UI + slider thumbs.
      if (rawHistogram) {
        [rendering.colorLo, rendering.colorHi] = autoWindow(rawHistogram, [
          rendering.colorLo,
          rendering.colorHi,
        ]);
        applyTf();
        renderUi();
        emitRendering();
      }
      return;
    }
    if (btn.dataset.act === "applyPreset") {
      const name = ui.querySelector<HTMLSelectElement>("#presetSelect")?.value || selectedPreset;
      if (name) {
        const preset = getPreset(name);
        if (preset) {
          selectedPreset = name;
          applyRenderingState(preset as Partial<WebGpuRenderingState>);
          renderUi();
          emitRendering(); // propagate to a linked peer + refresh the auto-remembered "last used"
        }
      }
      return;
    }
    if (btn.dataset.act === "savePreset") {
      const suggested = selectedPreset || "My preset";
      const name = window.prompt("Save current rendering as preset:", suggested)?.trim();
      if (name) {
        savePreset(name, readRendering() as unknown as Record<string, unknown>);
        selectedPreset = name;
        renderUi();
      }
      return;
    }
    if (btn.dataset.act === "deletePreset") {
      const name = ui.querySelector<HTMLSelectElement>("#presetSelect")?.value || selectedPreset;
      if (name && window.confirm(`Delete preset "${name}"?`)) {
        deletePreset(name);
        if (selectedPreset === name) selectedPreset = "";
        renderUi();
      }
      return;
    }
    if (btn.dataset.act === "clearPick") {
      lastPick = undefined;
      pickStatus = "";
      resetCrop();
    }
  });

  ui.addEventListener("change", (e) => {
    const t = e.target as HTMLSelectElement;
    if (t.id === "cmap") {
      rendering.colorMap = t.value as ColorMapName;
      applyTf();
      curveEditor?.setColorMap(rendering.colorMap);
      emitRendering();
    } else if (t.id === "fxop") {
      rendering.fxOperator = t.value as ToneMapOperator;
      rebuildFxStack();
      emitRendering();
    } else if (t.id === "presetSelect") {
      selectedPreset = t.value;
    }
  });

  const RENDERING_SLIDERS = new Set([
    "opacityScale",
    "sampleDist",
    "density",
    "exposure",
    "gradOp",
    "gradScale",
    "lighting",
    "equalizeClip",
    "measureDepth",
    "measureGray",
    "measureAlpha",
  ]);
  // Single-value sliders that emit a cropping change. (Crop min/max are dual-thumb `data-range`
  // groups handled separately below — they emit their own croppingChange.)
  const CROPPING_SLIDERS = new Set(["activeSlice", "sliceX", "sliceY", "sliceZ"]);
  // Post-FX sliders: each drives a stack rebuild (effect params are captured at build time) and
  // emits a rendering change so links / share carry the value.
  const FX_SLIDERS = new Set([
    "fxExposure",
    "fxBloomThreshold",
    "fxBloomIntensity",
    "fxSharpenAmount",
    "fxVignetteAmount",
  ]);
  // Lighting sliders: set the closure var, push params (applyLighting), and emit for links / share.
  const LIGHTING_SLIDERS = new Set([
    "lightGlobalIntensity",
    "lightAzimuth",
    "lightElevation",
    "lightFlashIntensity",
    "lightStageIntensity",
    "lightAmbient",
    "lightSpecular",
    "lightRoughness",
    "shadowQuality",
    "shadowStrength",
    "shadowSoftness",
    "aoRadius",
    "aoIntensity",
    "aoSamples",
    "flashConeDeg",
    "flashRange",
    "stageConeDeg",
    "stageRange",
  ]);

  ui.addEventListener("input", (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset.chk) {
      const on = t.checked;
      if (t.dataset.chk === "showPlanes") cropping.showPlanes = on;
      if (t.dataset.chk === "enX") cropping.enX = on;
      if (t.dataset.chk === "enY") cropping.enY = on;
      if (t.dataset.chk === "enZ") cropping.enZ = on;
      if (t.dataset.chk === "pickMode") {
        pickMode = on;
        canvas.style.cursor = pickMode ? "crosshair" : "";
        renderUi();
        return;
      }
      if (
        t.dataset.chk === "fxBloom" ||
        t.dataset.chk === "fxFxaa" ||
        t.dataset.chk === "fxSharpen" ||
        t.dataset.chk === "fxVignette"
      ) {
        if (t.dataset.chk === "fxBloom") rendering.fxBloom = on;
        else if (t.dataset.chk === "fxFxaa") rendering.fxFxaa = on;
        else if (t.dataset.chk === "fxSharpen") rendering.fxSharpen = on;
        else if (t.dataset.chk === "fxVignette") rendering.fxVignette = on;
        rebuildFxStack();
        emitRendering();
        return;
      }
      if (t.dataset.chk === "equalizeOn") {
        rendering.equalizeOn = on;
        recomputeEqualize();
        applyTf();
        renderUi(); // refresh the histogram (equalized vs raw) + curve editor
        emitRendering();
        return;
      }
      if (t.dataset.chk === "measurePlaneOn") {
        rendering.measurePlaneOn = on; // the render loop reads this live; just emit for links/share
        emitRendering();
        return;
      }
      if (t.dataset.chk === "roiEnabled") {
        roiEnabled = on; // the render loop reads this live (updateRoi); toggling off fades + discards
        volumeRenderer.setVisibilityFeedback(roiEnabled); // Milestone 1: ray-guided streaming signal
        return;
      }
      if (
        t.dataset.chk === "lightGlobalOn" ||
        t.dataset.chk === "lightFlashOn" ||
        t.dataset.chk === "lightStageOn" ||
        t.dataset.chk === "shadowOn" ||
        t.dataset.chk === "aoOn" ||
        t.dataset.chk === "halfRes" ||
        t.dataset.chk === "temporalAA" ||
        t.dataset.chk === "shadowCastGlobal" ||
        t.dataset.chk === "shadowCastFlash" ||
        t.dataset.chk === "shadowCastStage"
      ) {
        if (t.dataset.chk === "lightGlobalOn") rendering.lightGlobalOn = on;
        else if (t.dataset.chk === "lightFlashOn") rendering.lightFlashOn = on;
        else if (t.dataset.chk === "lightStageOn") rendering.lightStageOn = on;
        else if (t.dataset.chk === "shadowOn") rendering.shadowOn = on;
        else if (t.dataset.chk === "aoOn") rendering.aoOn = on;
        else if (t.dataset.chk === "halfRes") rendering.halfRes = on;
        else if (t.dataset.chk === "temporalAA") { rendering.temporalAA = on; taau.setEnabled(on); }
        else if (t.dataset.chk === "shadowCastGlobal") rendering.shadowCastGlobal = on;
        else if (t.dataset.chk === "shadowCastFlash") rendering.shadowCastFlash = on;
        else if (t.dataset.chk === "shadowCastStage") rendering.shadowCastStage = on;
        applyLighting();
        emitRendering();
        return;
      }
      applyRender();
      emitCropping();
      return;
    }
    if (t.dataset.color) {
      const cid = t.dataset.color;
      if (cid === "lightGlobalColor") rendering.lightGlobalColor = t.value;
      else if (cid === "lightFlashColor") rendering.lightFlashColor = t.value;
      else if (cid === "lightStageColor") rendering.lightStageColor = t.value;
      emitRendering();
      return;
    }
    if (t.dataset.range) {
      // Dual-thumb range (color low/high, or per-axis crop min/max). Everything is scoped to this
      // group's `.whud__range` wrapper so multiple ranges coexist. Keep lo <= hi (a thumb dragged past
      // its partner pushes it), reflect the filled band + label in place, then dispatch by group.
      const [group, end] = t.dataset.range.split(":"); // e.g. "cropX", "lo"
      const wrap = t.closest<HTMLElement>(".whud__range");
      if (!wrap) return;
      const loEl = wrap.querySelector<HTMLInputElement>('[data-range$=":lo"]');
      const hiEl = wrap.querySelector<HTMLInputElement>('[data-range$=":hi"]');
      if (!loEl || !hiEl) return;
      let lo = Number(loEl.value);
      let hi = Number(hiEl.value);
      if (lo > hi) {
        if (end === "lo") hi = lo;
        else lo = hi;
        loEl.value = String(lo);
        hiEl.value = String(hi);
      }
      const fill = wrap.querySelector<HTMLElement>("[data-range-fill]");
      if (fill) {
        fill.style.left = `${lo * 100}%`;
        fill.style.width = `${(hi - lo) * 100}%`;
      }
      const vals = wrap.nextElementSibling?.querySelector("[data-range-vals]");
      if (vals) vals.textContent = `${fmt(lo)} – ${fmt(hi)}`;
      if (group === "color") {
        rendering.colorLo = lo;
        rendering.colorHi = hi;
        applyTf();
        curveEditor?.setColorRange([rendering.colorLo, rendering.colorHi]);
        emitRendering();
      } else if (group === "cropX" || group === "cropY" || group === "cropZ") {
        const axis = group === "cropX" ? 0 : group === "cropY" ? 1 : 2;
        cropping.cropMin[axis] = lo;
        cropping.cropMax[axis] = hi;
        applyRender();
        emitCropping();
      }
      return;
    }
    if (!t.dataset.slider) return;
    const id = t.dataset.slider;
    const v = Number(t.value);
    const lab = ui.querySelector(`[data-val="${id}"]`);
    if (lab) lab.textContent = fmt(v);
    switch (id) {
      case "opacityScale":
        rendering.opacityScale = v;
        applyTf();
        break;
      case "measureDepth":
        rendering.measureDepth = v; // the render loop reads these live (ruler + plane depth/appearance)
        break;
      case "measureGray":
        rendering.measurePlaneGray = v;
        break;
      case "measureAlpha":
        rendering.measurePlaneAlpha = v;
        break;
      case "equalizeClip":
        rendering.equalizeClip = v;
        if (rendering.equalizeOn) {
          recomputeEqualize();
          applyTf();
          if (histogram) curveEditor?.setHistogram(histogram);
        }
        break;
      case "sampleDist":
        rendering.sampleDist = v;
        applyRender();
        break;
      case "density":
        rendering.densityScale = v;
        applyRender();
        break;
      case "exposure":
        rendering.exposure = v;
        applyRender();
        break;
      case "gradOp":
        rendering.gradOpacity = v;
        applyRender();
        break;
      case "gradScale":
        rendering.gradScale = v;
        applyRender();
        break;
      case "lighting":
        rendering.lighting = v;
        applyRender();
        break;
      case "activeSlice":
        setActiveSlice(v);
        if (openSections.has("slices")) {
          // Refresh µm / index labels without rebuilding the whole panel (keeps focus).
          const active = activeSlice();
          if (active) {
            const n =
              active.axis === "x"
                ? source.dimensionsAt(level)[0]!
                : active.axis === "y"
                  ? source.dimensionsAt(level)[1]!
                  : source.dimensionsAt(level)[2]!;
            const idx = Math.min(n - 1, Math.floor(active.value * n));
            const info = ui.querySelector("[data-slice-info]");
            if (info) {
              info.textContent = `${sliceWorldLabel(active.axis, active.value)} · index ${idx}/${n - 1}`;
            }
          }
        }
        break;
      case "sliceX":
        cropping.sliceX = v;
        applyRender();
        break;
      case "sliceY":
        cropping.sliceY = v;
        applyRender();
        break;
      case "sliceZ":
        cropping.sliceZ = v;
        applyRender();
        break;
      case "fxExposure":
        rendering.fxExposure = v;
        rebuildFxStack();
        break;
      case "fxBloomThreshold":
        rendering.fxBloomThreshold = v;
        rebuildFxStack();
        break;
      case "fxBloomIntensity":
        rendering.fxBloomIntensity = v;
        rebuildFxStack();
        break;
      case "fxSharpenAmount":
        rendering.fxSharpenAmount = v;
        rebuildFxStack();
        break;
      case "fxVignetteAmount":
        rendering.fxVignetteAmount = v;
        rebuildFxStack();
        break;
      case "lightGlobalIntensity":
        rendering.lightGlobalIntensity = v;
        break;
      case "lightAzimuth":
        rendering.lightAzimuth = v;
        break;
      case "lightElevation":
        rendering.lightElevation = v;
        break;
      case "lightFlashIntensity":
        rendering.lightFlashIntensity = v;
        break;
      case "lightStageIntensity":
        rendering.lightStageIntensity = v;
        break;
      case "lightAmbient":
        rendering.lightAmbient = v;
        applyLighting();
        break;
      case "lightSpecular":
        rendering.lightSpecular = v;
        applyLighting();
        break;
      case "lightRoughness":
        rendering.lightRoughness = v;
        applyLighting();
        break;
      case "shadowQuality":
        rendering.shadowQuality = v;
        applyLighting();
        break;
      case "shadowStrength":
        rendering.shadowStrength = v;
        applyLighting();
        break;
      case "aoRadius":
        rendering.aoRadius = v;
        applyLighting();
        break;
      case "aoIntensity":
        rendering.aoIntensity = v;
        applyLighting();
        break;
      case "shadowSoftness":
        rendering.shadowSoftness = v;
        applyLighting();
        break;
      case "aoSamples":
        rendering.aoSamples = v;
        applyLighting();
        break;
      // Cone/range feed buildFrameLights (rebuilt per frame) — just store the value.
      case "flashConeDeg":
        rendering.flashConeDeg = v;
        break;
      case "flashRange":
        rendering.flashRange = v;
        break;
      case "stageConeDeg":
        rendering.stageConeDeg = v;
        break;
      case "stageRange":
        rendering.stageRange = v;
        break;
      default:
        break;
    }
    if (RENDERING_SLIDERS.has(id)) emitRendering();
    else if (CROPPING_SLIDERS.has(id)) emitCropping();
    else if (FX_SLIDERS.has(id)) emitRendering();
    else if (LIGHTING_SLIDERS.has(id)) emitRendering();
  });

  // Ctrl/Meta+click or pick-mode click → feature pick (Shift left free for pan).
  let pickDown: { x: number; y: number } | null = null;
  const onPickPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    if (!(pickMode || e.ctrlKey || e.metaKey)) return;
    pickDown = { x: e.clientX, y: e.clientY };
  };
  const onPickPointerUp = (e: PointerEvent): void => {
    if (!pickDown) return;
    const dx = e.clientX - pickDown.x;
    const dy = e.clientY - pickDown.y;
    pickDown = null;
    if (dx * dx + dy * dy > 36) return; // drag → ignore
    void runPickAt(e.clientX, e.clientY);
  };
  canvas.addEventListener("pointerdown", onPickPointerDown);
  canvas.addEventListener("pointerup", onPickPointerUp);
  session.onDispose(() => {
    canvas.removeEventListener("pointerdown", onPickPointerDown);
    canvas.removeEventListener("pointerup", onPickPointerUp);
  });

  // Slice scrub with wheel in plane views.
  const onSliceWheel = (e: WheelEvent): void => {
    if (rendering.viewMode === "volume" || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    const n =
      rendering.viewMode === "xPlane"
        ? source.dimensionsAt(level)[0]!
        : rendering.viewMode === "yPlane"
          ? source.dimensionsAt(level)[1]!
          : source.dimensionsAt(level)[2]!;
    const step = 1 / Math.max(n, 2);
    const dir = e.deltaY > 0 ? 1 : -1;
    setActiveSlice((activeSlice()?.value ?? 0.5) + dir * step);
    if (openSections.has("slices")) renderUi();
  };
  canvas.addEventListener("wheel", onSliceWheel, { passive: false });
  session.onDispose(() => canvas.removeEventListener("wheel", onSliceWheel));

  // Render-on-demand safety net: any direct canvas interaction (camera drag start, pick, wheel scrub)
  // tops up the render budget even if it doesn't route through the HUD chokepoints. Camera drags then
  // sustain themselves via the per-frame camera-moved check.
  const bumpRender = (): void => requestRender();
  canvas.addEventListener("pointerdown", bumpRender, { passive: true });
  canvas.addEventListener("wheel", bumpRender, { passive: true });
  session.onDispose(() => {
    canvas.removeEventListener("pointerdown", bumpRender);
    canvas.removeEventListener("wheel", bumpRender);
  });

  // Auto-stream coarsest→level 2 (progressive hi-res, capped so full-res levels don't blow up the GPU).
  applyLevel(finestTargetLevel(), true);
  applyTf();
  applyRender();
  renderUi();

  session.onKeyDown((e) => {
    void (async () => {
      const idx = levels.indexOf(level);
      if (e.code === "BracketLeft" && idx < levels.length - 1) applyLevel(levels[idx + 1]!);
      else if (e.code === "BracketRight" && idx > 0) applyLevel(levels[idx - 1]!);
      else if (e.code === "Digit1") {
        setViewModeAndEmit("xPlane", { openSlices: true });
      } else if (e.code === "Digit2") {
        setViewModeAndEmit("yPlane", { openSlices: true });
      } else if (e.code === "Digit3") {
        setViewModeAndEmit("zPlane", { openSlices: true });
      } else if (e.code === "Digit4") {
        setViewModeAndEmit("volume", { openSlices: true });
      } else if (e.code === "KeyF") {
        frameSliceCamera();
      } else if (e.code === "KeyP") {
        pickMode = !pickMode;
        canvas.style.cursor = pickMode ? "crosshair" : "";
        openSections.add("measure");
        renderUi();
      } else if (e.code === "KeyS") {
        cropping.showPlanes = !cropping.showPlanes;
        if (cropping.showPlanes) {
          cropping.enX = cropping.enY = cropping.enZ = true;
        }
        applyRender();
        renderUi();
        emitCropping();
      } else if (e.code === "KeyR") {
        setViewModeAndEmit("volume", { skipRenderUi: true });
      } else if (e.code === "KeyO") {
        const next = await pickZarrStore();
        if (!next) return;
        store = next;
        source = await openOmeZarr(store, { skipRangeEstimate: true, valueRange });
        levels = allowedLevels();
        lastPick = undefined;
        pickStatus = "";
        loaderOpened = false; // new dataset → reopen the loader (drops old resident textures)
        brickLoader.clear(); // drop the old dataset's ROI brick
        lastRoiKey = "";
        lastRegion = null;
        if (levels.length) applyLevel(finestTargetLevel(), true);
      } else if (e.code === "KeyE") {
        lastPick = undefined;
        pickStatus = "";
        resetCrop();
      }
    })();
  });

  const proj = new Mat4();
  const view = new Mat4();
  const viewProj = new Mat4();
  console.info(
    "[prism] demo 26 — levels",
    levels,
    "maxTex",
    maxTex,
    "extent m",
    volumeMaxExtentMeters(source, level),
  );

  const camsEqual = (a: WebGpuCameraState | null, b: WebGpuCameraState | null): boolean => {
    if (!a || !b) return false;
    const close = (x: number, y: number): boolean =>
      Math.abs(x - y) <= 1e-4 * (1 + Math.abs(x) + Math.abs(y));
    return (
      close(a.distance, b.distance) &&
      a.target.every((v, i) => close(v, b.target[i]!)) &&
      a.offset.every((v, i) => close(v, b.offset[i]!)) &&
      a.gazeUp.every((v, i) => close(v, b.gazeUp[i]!))
    );
  };

  session.loop((dt) => {
    resizeDemoCanvas(canvas);
    controls.update(dt); // the orbit pivot is clamped to the volume bounds inside update() via targetBounds
    // Render on demand: the volume ray-march is expensive, so re-render only while something is actually
    // changing — otherwise a continuous 60 fps march saturates the GPU and janks the whole browser
    // (scrolling included). `renderFrames` is a small budget any interaction or still-converging process
    // (camera motion, settings change, TAAU accumulation, adaptive refine, ROI brick fade, resize) tops
    // up; when it hits zero and the camera is still, we skip the frame and the last image persists.
    const camNow = controls.getState();
    if (viewerListeners.cameraChange.size > 0 && !camsEqual(camNow, lastCam)) {
      lastCam = camNow;
      emit("cameraChange");
    }
    // Drive render-on-demand off the controls' own activity signal, NOT just camsEqual. camsEqual uses a
    // relative tolerance (1e-4·(1+|a|+|b|)) that grows with coordinate magnitude: zoomed far out — or with
    // a short/thin volume framed so the camera sits far along the thin axis — the offset components are
    // large, the tolerance balloons to several world units, and a slow drag moves the pose less than that
    // per frame, so camsEqual falsely reports "unchanged" and the canvas freezes mid-interaction while the
    // UI keeps responding. isAnimating compares normalized directions + relative distance error, so it is
    // scale-independent and stays true throughout any drag / damping catch-up.
    if (controls.isAnimating || !camsEqual(camNow, lastRenderCam)) requestRender();
    if (canvas.width !== lastRenderW || canvas.height !== lastRenderH) requestRender();
    if (renderFrames <= 0) return;
    renderFrames -= 1;
    // Near/far bracket the volume CENTER's depth ALONG THE VIEW AXIS (the box is centered at the world
    // origin), from its actual projected depth (not the bounding sphere). We project the center onto
    // the actual view direction rather than use the straight-line eye→origin distance: under
    // zoom-to-cursor the orbit target drifts off the origin, so the camera's forward stops pointing at
    // the box center. Using the straight-line distance then overestimates the center's depth, pushing
    // the near plane in front of the box and clipping its front — which read as the volume "inverting"
    // when zoomed far out. A sphere-radius margin would also hugely over-bracket a thin/wide slab,
    // forcing `near` to clamp to a tiny fraction of `far`, skewing the DVR ray reconstruction; the
    // projected half-depth is orientation-aware and keeps the near/far ratio well-conditioned. See
    // computeNearFar()/computeCameraBasis() for the full margin-growth rationale.
    const wm = camera.worldMatrix().elements;
    const basis = computeCameraBasis(wm);
    const { near, far, extent, centerDepth, halfDepth } = computeNearFar(sizeSim, camera.position, basis.forward);
    proj.perspective(
      (42 * Math.PI) / 180,
      canvas.width / Math.max(1, canvas.height),
      near,
      far,
    );
    view.copy(camera.worldMatrix()).invert();
    viewProj.multiplyMatrices(proj, view);
    lastViewProj.copy(viewProj);
    // Rebuild the procedural light set from the camera basis so flashlight / stage lights track the
    // view. Global stays fixed-direction. Must run before recordInto (uploads the light buffer).
    // Feed the camera basis + FOV so the shader builds primary rays without invViewProj (which loses
    // float32 precision at extreme zoom-out → the volume vanishes / inverts). Must match the projection
    // above (42° vertical FOV, canvas aspect).
    volumeRenderer.setCameraBasis(
      basis.right,
      basis.up,
      basis.forward,
      (42 * Math.PI) / 180,
      canvas.width / Math.max(1, canvas.height),
    );
    volumeRenderer.setLights(
      buildFrameLights(
        rendering,
        camera.position,
        basis.right,
        basis.up,
        basis.forward,
        extent,
      ),
    );
    // Milestone 7.1: the opacity shadow map is a *directional* structure — exact only for the global
    // "sun" light. For positional lights (flashlight at the eye, stage spots) the directional
    // approximation misplaces occluders and stripes the shadows, so those fall back to the per-sample
    // brute march (which marches toward the actual light position). Map on only when the global light is
    // the caster.
    let shadowDir: [number, number, number] | null = null;
    if (rendering.shadowOn && rendering.lightGlobalOn && rendering.shadowCastGlobal) {
      const el = (rendering.lightElevation * Math.PI) / 180;
      const az = (rendering.lightAzimuth * Math.PI) / 180;
      shadowDir = [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];
    }
    volumeRenderer.setShadowMap(shadowDir !== null, shadowDir ?? [0.45, 0.85, 0.35]);
    // Measure plane depth in world units along the view axis. `measureDepth` is a 0..1 fraction across
    // the volume's actual depth footprint (0 = front face nearest the camera, 1 = back face), so the
    // plane and its calibrated ruler track zoom instead of a fixed multiple of the extent. Clamp the
    // front to `near` (usable when the eye is inside the volume); see computeMeasurePlaneDepth().
    const planeDepth = computeMeasurePlaneDepth(centerDepth, halfDepth, near, rendering.measureDepth);
    updateRoi(dt);
    // Adaptive sampling: coarsen the ray step while navigating (camera moving) for a smooth framerate,
    // then refine once settled. `roiIdle` is seconds since the camera last moved (updated in updateRoi).
    // Coarsen instantly for responsiveness; ease back to the configured `sampleDist` over ~0.4 s so the
    // sharpening isn't a visible pop. max(NAV_SAMPLE_DIST, sampleDist) keeps a coarse slider still coarse.
    const navTarget = roiIdle < NAV_SETTLE ? Math.max(NAV_SAMPLE_DIST, rendering.sampleDist) : rendering.sampleDist;
    if (navTarget > navSampleDist) navSampleDist = navTarget;
    else navSampleDist += (navTarget - navSampleDist) * Math.min(1, dt * 8);
    volumeRenderer.setParams({ stepSize: Math.min(brickStep ?? baseStep, baseStep) * navSampleDist });
    // Measure plane: depth-composited grey sheet at `planeDepth` along the view axis. Must run before
    // recordInto (writes the frame uniform).
    volumeRenderer.setMeasurePlane({
      enabled: rendering.measurePlaneOn,
      depth: planeDepth,
      gray: rendering.measurePlaneGray,
      alpha: rendering.measurePlaneAlpha,
      forward: basis.forward,
    });
    // Volume → linear HDR, then the post stack to the swapchain (one encoder / one submit). The DOM
    // overlay (gizmo + scale bar) draws to a separate canvas and is unaffected.
    const rw = Math.max(1, Math.round(canvas.width * fxPipeline.renderScale));
    const rh = Math.max(1, Math.round(canvas.height * fxPipeline.renderScale));
    volumeRenderer.setInternalSize(rw, rh);
    volumeRenderer.setReprojectFar(far); // normalize the depth-centroid output for TAAU reprojection
    // Milestone 5: accumulate only once fully settled — the camera stopped AND the adaptive step has
    // finished refining (else we'd blend coarse-in-motion frames with the sharp ones). Anything else
    // resets the history so a moving view shows the live frame with no ghosting. When accumulating, jitter
    // the projection sub-pixel so successive converged frames supersample; the un-jittered viewProj still
    // drives ROI/overlay.
    let renderViewProj = viewProj;
    if (rendering.temporalAA) {
      // "Settled" = camera stopped AND the adaptive step has finished refining. On the moving→settled
      // edge, reseed accumulation so the sharp frames replace the coarse in-motion history; a moving view
      // keeps converging via reprojection rather than resetting.
      const settled = roiIdle >= NAV_SETTLE && Math.abs(navSampleDist - rendering.sampleDist) < 0.02;
      if (settled && !taauPrevSettled) taau.reset();
      taauPrevSettled = settled;
      // Reprojection inputs use the UN-jittered matrices (jitter is only for the render's sub-pixel
      // supersampling). While moving, reproject history at the orbit-pivot depth; when settled, plain avg.
      invViewProj.copy(viewProj);
      if (invViewProj.invert()) {
        taau.setReprojection(
          invViewProj.elements,
          viewProj.elements,
          [camera.position.x, camera.position.y, camera.position.z],
          far,
          !settled,
        );
      }
      applyTaauJitter(jitterProj, jitterViewProj, proj, view, taau.jitterPixels(), rw, rh);
      renderViewProj = jitterViewProj;
    } else {
      taau.reset();
    }
    fxPipeline.render(
      { r: 0.015, g: 0.02, b: 0.035, a: 1 },
      (pass) => {
        volumeRenderer.recordInto(pass, renderViewProj, camera.position);
      },
      (encoder) => {
        volumeRenderer.recordPrePasses(encoder, renderViewProj, camera.position);
      },
      taau,
    );
    volumeRenderer.afterSubmit();

    // Bottom-left overlay: axis gizmo (camera world basis) + physical scale bar.
    // Edge rulers: world (sim µm) per CSS pixel at the calibration depth. Perspective ⇒ exact only on
    // the fronto-parallel plane at that depth; isotropic, so X and Y share one scale. The depth is the
    // orbit-pivot distance by default, or the camera-linked measure plane depth (a fraction across the
    // volume's view-axis footprint) when the plane is on (the plane itself is rendered by the volume
    // shader). ~80px major spacing.
    const measureDist = rendering.measurePlaneOn ? planeDepth : controls.distance;
    const rulerUnit = lengthUnit();
    const ruler = computeRuler({
      measureDist,
      fovY: controls.fovY,
      cssHeight: canvas.clientHeight,
      worldPerPxToDisplay: (worldPerPx) => units.fromSim(worldPerPx, units.LENGTH, sim).to(rulerUnit),
      unitSymbol: rulerUnit.symbol,
    });
    overlay.draw({
      right: basis.right,
      up: basis.up,
      forward: basis.forward,
      ruler,
      banner: volumeRenderer.approximateShadingBanner(),
    });

    // Record what we just rendered, and keep the budget alive while anything is still converging so the
    // image finishes refining after the camera stops (adaptive step easing, TAAU accumulating, ROI brick
    // fading in) — then it naturally goes idle.
    lastRenderCam = camNow;
    lastRenderW = canvas.width;
    lastRenderH = canvas.height;
    const adaptiveEasing = Math.abs(navSampleDist - rendering.sampleDist) > 0.005;
    const taauConverging = rendering.temporalAA && taau.sampleCount < taau.maxAccum;
    const brickFading = brickBlendCurrent !== brickBlendTarget;
    if (adaptiveEasing || taauConverging || brickFading) requestRender();
  });

  session.onDispose(() => {
    fxPipeline.dispose();
    volumeRenderer.dispose();
  });

  const handle = session.handle();
  const instance: WebGpuViewerInstance = {
    getCamera: readCamera,
    setCamera: (state) => {
      controls.setState(state);
      // Re-baseline so the loop's poll doesn't echo this peer-applied pose back out.
      lastCam = controls.getState();
    },
    getRendering: readRendering,
    setRendering: applyRenderingState,
    getCropping: readCropping,
    setCropping: (state) => {
      Object.assign(cropping, state);
      // Defensive copies so a caller mutating their own `state` object afterward can't reach in.
      cropping.cropMin = [state.cropMin[0], state.cropMin[1], state.cropMin[2]];
      cropping.cropMax = [state.cropMax[0], state.cropMax[1], state.cropMax[2]];
      applyRender();
      renderUi();
    },
    on: (event, cb) => {
      viewerListeners[event].add(cb);
    },
    off: (event, cb) => {
      viewerListeners[event].delete(cb);
    },
    dispose: () => handle.dispose(),
  };
  return instance;
}
