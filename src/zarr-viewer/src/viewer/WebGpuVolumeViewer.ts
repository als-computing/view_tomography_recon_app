/**
 * OME-Zarr volume viewer (Cosmovis / itk-vtk-viewer style).
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
  finestTargetLevel as finestTargetLevelPure,
  type VolumeSource,
  type Store,
} from "@zarr-viewer/io";
import {
  createContext,
  VolumeLoader,
  type VolumeLevelResult,
  VolumeRenderer,
  composeTransferFunction,
  composeMultiBandTransferFunction,
  OpacityCurveEditor,
  type ColorMapName,
  type VolumeBlendMode,
  type VolumeViewMode,
  type ShaderConfigName,
  uploadMaskPalette,
  type ManagedTexture,
} from "@zarr-viewer/render";
import { Scene, Node } from "@zarr-viewer/scene";
import { OrbitControls } from "@zarr-viewer/controls";
import { Mat4, Vec3 } from "@zarr-viewer/math";
import { bloom, tonemap, fxaa, sharpen, vignette, type ToneMapOperator, type Effect } from "@zarr-viewer/fx";
import {
  createViewerSession,
  createViewerHud,
  type ViewerHandle,
  resizeViewerCanvas,
} from "../viewer-session.js";
import { ensureHudStyles } from "../hud-theme.js";
import { ViewportOverlay } from "../render/overlay/viewport-overlay.js";
import { FxPipeline } from "../render/post/fx-pipeline.js";
import { TemporalAccumulator } from "../render/accel/taau.js";
import {
  getLastRendering,
  setLastRendering,
  listPresetNames,
  getPreset,
  savePreset,
  deletePreset,
} from "../rendering-presets.js";
import {
  type WebGpuRenderingState,
  type WebGpuCroppingState,
  defaultRenderingState,
  defaultCroppingState,
  mergeDefined,
} from "./RenderingState.js";
import { zarrUrlFromQuery, pickZarrStore } from "./util.js";
import { autoWindow, buildEqualizeRemap, rebinThroughRemap } from "./histogram.js";
import { type PanelId, type HudTab, VOLUME_TAB_PANELS, RENDER_TAB_PANELS, section, fmt } from "./ui/html.js";
import { controlsPanelBody } from "./ui/panels/controlsPanel.js";
import { ResidencyController } from "./volume/ResidencyController.js";
import { PickingController } from "./interaction/PickingController.js";
import { CropDragController } from "./interaction/CropDragController.js";
import { cropWorldBox, boxCorners, worldToScreen } from "./volume/crop-drag-geometry.js";
import { bindHudEvents, type HudEventContext } from "./ui/hudEvents.js";
import { buildFrameLights } from "./rendering/lighting.js";
import {
  computeCameraBasis,
  derollCameraBasis,
  computeNearFar,
  computeMeasurePlaneDepth,
  computeRuler,
  applyTaauJitter,
} from "./rendering/frameMath.js";
import {
  type CameraContext,
  frameSliceCamera as frameSliceCameraPure,
  enterViewMode as enterViewModePure,
  activeSlice as activeSlicePure,
  setActiveSlice as setActiveSlicePure,
} from "./camera/sliceView.js";
import { camsEqual } from "./camera/compare.js";
import { dataPanelBody } from "./ui/panels/dataPanel.js";
import { tfPanelBody } from "./ui/panels/tfPanel.js";
import { renderPanelBody } from "./ui/panels/renderPanel.js";
import { slicesPanelBody } from "./ui/panels/slicesPanel.js";
import { cropPanelBody } from "./ui/panels/cropPanel.js";
import { measurePanelBody } from "./ui/panels/measurePanel.js";
import { postfxPanelBody } from "./ui/panels/postfxPanel.js";
import { lightingPanelBody } from "./ui/panels/lightingPanel.js";
import { presetsPanelBody, sanitizeSelectedPreset } from "./ui/panels/presetsPanel.js";
import { annotationsPanelBody } from "./ui/panels/annotationsPanel.js";
import { loadMaskVolume, loadMaskFromArray } from "./volume/load-mask.js";
import { discoverMaskClasses, buildMaskPalette, type MaskClassState } from "./state/mask-classes.js";

export type { WebGpuRenderingState, WebGpuCroppingState } from "./RenderingState.js";

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
  /**
   * Mask/annotation layers (item 7 Phase B): exactly two independent, fixed slots — not generalized to
   * N. A host app drives these directly (no HUD interaction required); the built-in Annotations panel
   * calls the same underlying implementation, so either path produces the identical visual result.
   */
  loadMask: (slot: 0 | 1, url: string) => void;
  /** Upload a caller-supplied class-id array directly — no network access, no level/pyramid logic. */
  loadMaskFromArray: (slot: 0 | 1, data: Uint8Array, dims: readonly [number, number, number]) => void;
  removeMask: (slot: 0 | 1) => void;
  setMaskClassColor: (slot: 0 | 1, id: number, rgb: readonly [number, number, number]) => void;
  setMaskClassOpacity: (slot: 0 | 1, id: number, opacity: number) => void;
  toggleMaskClassVisible: (slot: 0 | 1, id: number) => void;
  /** `undefined` until that slot has a mask loaded (or after `removeMask`). */
  getMaskClasses: (slot: 0 | 1) => readonly MaskClassState[] | undefined;
  /** Phase 4c hardening, scoped (not a budget-everything audit): estimated GPU bytes for the
   * resource categories Phase 1 of the hardening pass already touches, plus the existing ROI-brick
   * texture. `totalEstimatedGpuBytes` is the sum of the other three — NOT total GPU memory (the main
   * displayed volume texture, mask textures, shadow map, occupancy grid, and TAAU history buffers are
   * real GPU allocations not yet counted here; extend to more categories later if this proves useful). */
  getMemoryStats: () => GpuMemoryStats;
  dispose: () => void;
}

/** See {@link WebGpuViewerInstance.getMemoryStats}. */
export interface GpuMemoryStats {
  gpuBrickBytes: number;
  densityPyramidBytes: number;
  renderTargetBytes: number;
  totalEstimatedGpuBytes: number;
}

export async function run(
  canvas: HTMLCanvasElement,
  options?: { zarrUrl?: string; hudMount?: HTMLElement },
): Promise<WebGpuViewerInstance> {
  const session = createViewerSession(canvas);
  resizeViewerCanvas(canvas);

  // Phase 4a hardening: set once an *unrequested* device loss is detected (driver crash/reset — see
  // `DeviceOptions.onDeviceLost`'s doc comment for why this stops at detection + a clear message
  // rather than attempting full automatic reconstruction). The render loop checks this every frame
  // and skips all GPU work once true, instead of throwing into a disposed/invalid device repeatedly.
  let deviceLost = false;
  const ctx = await createContext(canvas, {
    powerPreference: "high-performance",
    onDeviceLost: (info) => {
      deviceLost = true;
      const hud = createViewerHud({ position: "bottom-left", pointerEvents: true });
      session.mountHud(hud);
      hud.innerHTML = `<strong>GPU context lost</strong><div style="margin-top:8px">${
        info.message || "The GPU device was lost unexpectedly (driver crash or reset)."
      }</div><div style="margin-top:4px">Reload the page to continue.</div>`;
    },
  });
  const maxTex = ctx.maxTextureDimension3D;
  // Free the GPU device when the session disposes. Registered first so it runs LAST (dispose is
  // LIFO), after the volume textures/buffers are released — important when the host app repeatedly
  // toggles this renderer on and off, so WebGPU devices don't accumulate. Guarded: a device that's
  // already lost (unrequested) is typically no longer safe/meaningful to call destroy() on again.
  session.onDispose(() => {
    if (!deviceLost) ctx.device.destroy();
  });

  const valueRange: [number, number] = [-40, 40];
  // Everything that shapes the volume's appearance (transfer function + render params + view mode).
  // Everything that shapes the volume's appearance, and the ROI crop box + slice planes. Defaults
  // (see defaultRenderingState/defaultCroppingState) reproduce the viewer's original look.
  const rendering: WebGpuRenderingState = defaultRenderingState();
  let equalizeRemap: Float32Array | undefined; // CDF remap LUT while equalizeOn
  const cropping: WebGpuCroppingState = defaultCroppingState();
  const openSections = new Set<PanelId>(["tf"]);
  // Which top-level HUD tab is showing - "volume" (data/TF/slices/crop/measure/presets) or "render"
  // (render/lighting/postfx/controls). Only one panel within the active tab is open at a time (see
  // renderUi()'s <details> toggle listener) so the sidebar never needs scrolling to find a section.
  let activeTab: HudTab = "volume";
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
  // Seconds since the last HUD-driven rendering change (TF curve drag, any render/lighting slider) -
  // the render loop's "settled" gate (half-res render scale + half-res lighting while moving) was
  // camera-only, so dragging a TF curve or slider kept re-running the full-cost per-sample
  // shadow/AO/multi-light path on every input tick, which is what made editing feel slow. Folded into
  // `settled` in the render loop below so an active HUD drag gets the same interaction-time cheap path
  // as camera motion, then refines back to full quality NAV_SETTLE seconds after the drag stops.
  let interactionIdle = Number.POSITIVE_INFINITY;
  const markInteracting = (): void => {
    interactionIdle = 0;
  };

  // Snapshot the rendering / cropping groups from the live closure state. Defined up here so the
  // early error-path instances (below) can expose them too. opacityPoints/cropMin/cropMax/tfBands are
  // defensively copied so a caller mutating the returned object can't corrupt internal state.
  const readRendering = (): WebGpuRenderingState => ({
    ...rendering,
    opacityPoints: rendering.opacityPoints.map((p) => [p[0], p[1]] as const),
    tfBands: rendering.tfBands?.map((band) => ({
      ...band,
      opacityPoints: band.opacityPoints.map((p) => [p[0], p[1]] as const),
    })),
  });
  const readCropping = (): WebGpuCroppingState => ({
    ...cropping,
    cropMin: [cropping.cropMin[0], cropping.cropMin[1], cropping.cropMin[2]],
    cropMax: [cropping.cropMax[0], cropping.cropMax[1], cropping.cropMax[2]],
  });

  // Minimal instance for the failure paths (bad store / no uploadable LOD) — real get/set exist only
  // once the volume + controls are live. Keeps the return type uniform so callers always get a handle.
  const errorInstance = (handle: ViewerHandle): WebGpuViewerInstance => ({
    getCamera: () => ({ target: [0, 0, 0], offset: [0, 0, 5], gazeUp: [0, 1, 0], distance: 5 }),
    setCamera: () => {},
    getRendering: readRendering,
    setRendering: () => {},
    getCropping: readCropping,
    setCropping: () => {},
    on: () => {},
    off: () => {},
    loadMask: () => {},
    loadMaskFromArray: () => {},
    removeMask: () => {},
    setMaskClassColor: () => {},
    setMaskClassOpacity: () => {},
    toggleMaskClassVisible: () => {},
    getMaskClasses: () => undefined,
    getMemoryStats: () => ({
      gpuBrickBytes: 0,
      densityPyramidBytes: 0,
      renderTargetBytes: 0,
      totalEstimatedGpuBytes: 0,
    }),
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
    const hud = createViewerHud({ position: "bottom-left", pointerEvents: true });
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
  // at level 2. Manual level buttons / `[` `]` remain escape hatches to go finer. Also governs mask/
  // annotation layers (see `loadMask`'s call to `loadMaskVolume`) so a loaded mask matches the primary
  // volume's own displayed fidelity instead of defaulting to the pyramid's absolute coarsest level.
  const MIN_DISPLAY_LEVEL = 2;
  // Finest level we're willing to display: the finest available that isn't below MIN_DISPLAY_LEVEL,
  // or the coarsest level if the dataset has nothing that fine. `levels` is ascending (0 first).
  const finestTargetLevel = (): number => finestTargetLevelPure(levels, MIN_DISPLAY_LEVEL);

  if (levels.length === 0) {
    const hud = createViewerHud({ position: "bottom-left" });
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
    markInteracting();
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
    // Keeps the actual TemporalAccumulator in sync with rendering.temporalAA - needed here (not just
    // the checkbox's own change handler) so the default state (and any restored preset/session) takes
    // effect on first load, since TemporalAccumulator itself defaults disabled regardless of what
    // rendering.temporalAA says.
    taau.setEnabled(rendering.temporalAA);
    // Milestone 6 (B3): actual render-scale selection is adaptive (moving vs. settled) and happens every
    // frame in the render loop below, not here — this one-time call just avoids a stale full-res scale
    // for the very first frame before the loop has run.
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
      (picking.pickMode || e.ctrlKey || e.metaKey)
    ) {
      return false;
    }
    // Crop mode: only veto orbit when the pointerdown actually hits a crop-box face - crop mode stays
    // on while the user rotates the view to see other sides of the box before dragging a face.
    if (e instanceof PointerEvent && e.type === "pointerdown" && e.button === 0 && cropDrag.wouldHit(e)) {
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
  // Which TF band the shared opacity-curve editor is currently showing (item 7 Phase A) - UI-only,
  // not part of the serializable WebGpuRenderingState (mirrors selectedPreset's pattern).
  let activeBandIndex = 0;

  // Mask/annotation layers (item 7 Phase B) - viewer-local state, not part of WebGpuRenderingState
  // (mirrors how the primary dataset's own URL/source isn't part of it either). Exactly two independent
  // slots, fixed - not generalized to N (see the task this was extended for).
  interface MaskSlotState {
    url: string;
    loading: boolean;
    error: string | undefined;
    // undefined = nothing loaded; an array (possibly empty, if the mask is all-background) once loaded.
    classes: MaskClassState[] | undefined;
    gpuTex: ManagedTexture | undefined;
    paletteGpuTex: ManagedTexture | undefined;
  }
  const newMaskSlotState = (): MaskSlotState => ({
    url: "",
    loading: false,
    error: undefined,
    classes: undefined,
    gpuTex: undefined,
    paletteGpuTex: undefined,
  });
  const maskSlots: [MaskSlotState, MaskSlotState] = [newMaskSlotState(), newMaskSlotState()];

  // Progressive coarse→fine loader: owns the per-level GPU textures and streams finer levels toward
  // `targetLevel`, never downgrading what's displayed. `level` tracks the level currently on screen.
  const loader = new VolumeLoader(ctx.device, {
    supportsFloat32Filtering: ctx.supportsFloat32Filtering,
  });
  session.onDispose(() => loader.dispose());
  let loaderOpened = false;
  let targetLevel = level;
  let frameExtent = 1;

  // Adaptive sampling: while the camera moves, coarsen the ray step (≥ NAV_SAMPLE_DIST) for a smooth
  // framerate, then ease back to the configured `sampleDist` once settled. `navSampleDist` is the
  // eased, currently-applied multiplier.
  const NAV_SAMPLE_DIST = 1.5; // coarse step multiplier held during navigation
  const NAV_SETTLE = 0.15; // seconds of camera stillness before refining back to the configured value
  // Backlog item: cap how long the settled/full-quality TAAU accumulation run itself takes, not just
  // how many samples it accumulates. taau.maxAccum (64 frames) bounds *quality*, but each of those
  // frames pays full per-sample heavy-lighting cost - on a slow GPU/large dataset that can run well
  // past a second, and resuming navigation mid-run has to wait out whatever's still in flight, which
  // reads as lag. Stopping early holds whatever's accumulated so far (usually visually converged long
  // before the sample cap) as the resting frame instead of grinding through the rest.
  const TAAU_SETTLE_TIME_CAP_S = 0.5;
  let navSampleDist = 1;
  let taauPrevSettled = false; // tracks the moving↔settled edge so TAAU reseeds fine detail on settle
  let settledElapsed = 0; // seconds since the moving→settled edge, reset whenever not settled
  // Milestone 6 (B3) Step 5, debug-only: KeyL shows the half-res lightAdd buffer instead of the real
  // image, for a visual sanity check of the new G-buffer lighting pass. Removed once B3 ships for real.
  let debugLightAdd = false;

  // High-res ROI brick: stream + composite a fine sub-volume over the coarse base when zoomed in (or a
  // crop ROI is set), and fade it out / discard on zoom-out. ROI stream progress is patched directly
  // into the HUD DOM (rAF-throttled) so per-chunk progress never triggers a full HUD rebuild.
  let roiProgressPaintQueued = false;
  const residency = new ResidencyController({
    device: ctx.device,
    supportsFloat32Filtering: ctx.supportsFloat32Filtering,
    getSource: () => source,
    sizeSim,
    getLevel: () => level,
    getFrameExtent: () => frameExtent,
    getBaseStep: () => baseStep,
    setBrickStep: (step) => {
      brickStep = step;
    },
    maxTex,
    camera,
    controls,
    cropping,
    volumeRenderer,
    invViewProj,
    lastViewProj,
    sim,
    applyRender: () => applyRender(),
    renderUi: () => renderUi(),
    notifyProgress: () => {
      if (roiProgressPaintQueued) return;
      roiProgressPaintQueued = true;
      requestAnimationFrame(() => {
        roiProgressPaintQueued = false;
        const wrap = ui.querySelector<HTMLElement>("#roiProgressWrap");
        if (!wrap) return;
        const p = residency.progress;
        if (!p) {
          wrap.style.display = "none";
          return;
        }
        wrap.style.display = "";
        const pct = p.total ? Math.round((p.loaded / p.total) * 100) : 0;
        const fill = ui.querySelector<HTMLElement>("#roiProgressFill");
        const label = ui.querySelector<HTMLElement>("#roiProgressLabel");
        if (fill) fill.style.width = `${pct}%`;
        if (label) label.textContent = `${p.loaded}/${p.total} chunks`;
      });
    },
  });
  session.onDispose(() => residency.dispose());

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
  // next render-loop frame (resizeViewerCanvas runs every frame); we also nudge it immediately.
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
    resizeViewerCanvas(canvas);
  };

  const lengthUnit = (): units.Unit =>
    units.resolveLengthUnit(source.spacingUnitName) ?? units.micrometer;
  const um3 = (): units.Unit =>
    lengthUnit().pow(3).labeled(`${lengthUnit().symbol}³`, `cubic ${lengthUnit().name}`);

  const applyTf = (): void => {
    // Bands mode (item 7 Phase A) recolors intensity sub-ranges of this same volume independently;
    // the single-TF fields below drive rendering unchanged whenever tfBands is unset/empty.
    const tf =
      rendering.tfBands && rendering.tfBands.length > 0
        ? composeMultiBandTransferFunction(rendering.tfBands)
        : composeTransferFunction({
            opacity: rendering.opacityPoints,
            colorMap: rendering.colorMap,
            colorRange: [rendering.colorLo, rendering.colorHi],
            opacityScale: rendering.opacityScale,
            samples: 48,
            intensityRemap: rendering.equalizeOn ? equalizeRemap : undefined,
          });
    volumeRenderer.setTransferFunction(tf, 512);
    requestRender();
    markInteracting();
    taau.reset(); // transfer function / colormap changed → restart temporal accumulation
    // Keep the shared curve editor showing whatever it should for the current mode: the active band
    // in Bands mode, the flat fields otherwise (bands use a fixed [0,1] local range - each band IS
    // already its own sub-domain, so there's nothing to additionally squeeze).
    const bands = rendering.tfBands;
    const activeBand = bands && bands.length > 0 ? bands[Math.min(activeBandIndex, bands.length - 1)] : undefined;
    if (activeBand) {
      curveEditor?.setColorMap(activeBand.colorMap);
      curveEditor?.setPoints(activeBand.opacityPoints);
      curveEditor?.setColorRange([0, 1]);
    } else {
      curveEditor?.setColorMap(rendering.colorMap);
      curveEditor?.setPoints(rendering.opacityPoints);
      curveEditor?.setColorRange([rendering.colorLo, rendering.colorHi]);
    }
  };

  // Rebuild + push mask slot `slot`'s palette texture from its current classes state (item 7 Phase B).
  // A no-op until that slot has a mask loaded. Always allocates a new texture (mirrors
  // setTransferFunction's own LUT-rebuild-on-every-change pattern) and disposes the previous one —
  // otherwise every color/opacity/visibility edit would leak a 1KB texture.
  const applyMaskPalette = (slot: 0 | 1): void => {
    const s = maskSlots[slot];
    if (!s.classes) return;
    const bytes = buildMaskPalette(s.classes);
    const next = uploadMaskPalette(ctx.device, bytes);
    s.paletteGpuTex?.dispose();
    s.paletteGpuTex = next;
    volumeRenderer.setMaskPalette(slot, next);
    requestRender();
    markInteracting();
  };

  // Shared tail for both load paths: swap in the new texture, discover classes, build the palette.
  const applyLoadedMask = (
    slot: 0 | 1,
    loaded: { texture: ManagedTexture; classCounts: Uint32Array },
  ): void => {
    const s = maskSlots[slot];
    s.gpuTex?.dispose();
    s.gpuTex = loaded.texture;
    volumeRenderer.setMask(slot, loaded.texture);
    s.classes = discoverMaskClasses(loaded.classCounts);
    applyMaskPalette(slot);
  };

  const loadMask = async (slot: 0 | 1, url: string): Promise<void> => {
    const s = maskSlots[slot];
    s.loading = true;
    s.error = undefined;
    s.url = url;
    renderUi();
    try {
      applyLoadedMask(slot, await loadMaskVolume(ctx, url, MIN_DISPLAY_LEVEL));
    } catch (err) {
      s.error = err instanceof Error ? err.message : String(err);
    } finally {
      s.loading = false;
      requestRender();
      renderUi();
    }
  };

  const loadMaskArray = async (
    slot: 0 | 1,
    data: Uint8Array,
    dims: readonly [number, number, number],
  ): Promise<void> => {
    const s = maskSlots[slot];
    s.loading = true;
    s.error = undefined;
    s.url = ""; // array-sourced - no URL to show/persist
    renderUi();
    try {
      applyLoadedMask(slot, await loadMaskFromArray(ctx, data, dims));
    } catch (err) {
      s.error = err instanceof Error ? err.message : String(err);
    } finally {
      s.loading = false;
      requestRender();
      renderUi();
    }
  };

  const removeMask = (slot: 0 | 1): void => {
    const s = maskSlots[slot];
    volumeRenderer.setMask(slot, null);
    volumeRenderer.setMaskPalette(slot, null);
    s.gpuTex?.dispose();
    s.gpuTex = undefined;
    s.paletteGpuTex?.dispose();
    s.paletteGpuTex = undefined;
    s.classes = undefined;
    s.error = undefined;
    requestRender();
    renderUi();
  };
  session.onDispose(() => {
    for (const s of maskSlots) {
      s.gpuTex?.dispose();
      s.paletteGpuTex?.dispose();
    }
  });

  // Shared per-class mutators - both the public WebGpuViewerInstance API and the built-in HUD's
  // hudEventCtx call these same functions, so driving a mask via a host app produces an identical
  // result to driving it through the panel.
  const setMaskClassColor = (slot: 0 | 1, id: number, rgb: readonly [number, number, number]): void => {
    const cls = maskSlots[slot].classes?.find((c) => c.id === id);
    if (cls) {
      cls.color = [...rgb];
      applyMaskPalette(slot);
    }
  };
  const setMaskClassOpacity = (slot: 0 | 1, id: number, opacity: number): void => {
    const cls = maskSlots[slot].classes?.find((c) => c.id === id);
    if (cls) {
      cls.opacity = opacity;
      applyMaskPalette(slot);
    }
  };
  const toggleMaskClassVisible = (slot: 0 | 1, id: number): void => {
    const cls = maskSlots[slot].classes?.find((c) => c.id === id);
    if (cls) {
      cls.visible = !cls.visible;
      applyMaskPalette(slot);
    }
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
    markInteracting();
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
    volumeRenderer.setVisibilityFeedback(residency.isEnabled);
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

  /** Recenter the camera on the whole volume, regardless of the current view mode (the "Home" button). */
  const homeCamera = (): void => {
    frameSliceCameraPure(cameraCtx, "volume", { x: cropping.sliceX, y: cropping.sliceY, z: cropping.sliceZ });
    applyRender();
  };

  // Floating "Home" button, hovering over the top-right of the canvas — reuses the same stage element
  // ViewportOverlay attaches into (see below), positioned above it (higher z-index) since the overlay
  // itself is pointer-events:none and would otherwise sit "on top" visually but never intercept clicks.
  const homeButton = document.createElement("button");
  homeButton.type = "button";
  homeButton.className = "whud-home-btn";
  homeButton.title = "Recenter on the whole volume";
  homeButton.setAttribute("aria-label", "Recenter on the whole volume");
  homeButton.textContent = "⌂";
  Object.assign(homeButton.style, {
    position: "absolute",
    top: "12px",
    right: "12px",
    zIndex: "3",
    width: "32px",
    height: "32px",
    borderRadius: "6px",
    border: "1px solid rgba(255,255,255,0.18)",
    background: "rgba(20,20,26,0.72)",
    color: "#e8e8ec",
    font: "16px system-ui, sans-serif",
    cursor: "pointer",
  });
  homeButton.addEventListener("click", () => homeCamera());
  (canvas.parentElement ?? document.body).appendChild(homeButton);
  session.onDispose(() => homeButton.remove());

  // Switch view mode (and, for the plane modes, the slice it enables) then notify listeners — view
  // mode carries both a render mode and slice enables/overlays, so both change events fire together.
  const setViewModeAndEmit = (
    mode: VolumeViewMode,
    opts?: { openSlices?: boolean; skipRenderUi?: boolean },
  ): void => {
    enterViewMode(mode, true);
    if (opts?.openSlices) {
      openSections.add("slices");
      activeTab = "volume";
    }
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
    const {
      shaderConfig: rawShaderConfig,
      opacityPoints: rawOpacityPoints,
      tfBands: rawTfBands,
      ...rest
    } = state;
    mergeDefined(rendering, rest);
    if (rawShaderConfig === "baseline" || rawShaderConfig === "fast" || rawShaderConfig === "quality") {
      rendering.shaderConfig = rawShaderConfig;
    }
    if (Array.isArray(rawOpacityPoints)) {
      rendering.opacityPoints = rawOpacityPoints.map((p) => [p[0], p[1]] as const);
    }
    // Unlike mergeDefined's usual "absent key = leave untouched" rule, tfBands must be set explicitly
    // either way: `state` came from a saved snapshot (localStorage last-used, a preset, a share-link)
    // that may predate this field, or was captured while in Single mode (no bands) — in both cases the
    // absence means "no bands," not "keep whatever's currently active." Leaving that ambiguous would
    // strand stale bands active after switching to an old/single-mode preset while every other TF field
    // updates, which is a confusing mixed state, not a real "cache."
    rendering.tfBands =
      Array.isArray(rawTfBands) && rawTfBands.length > 0
        ? rawTfBands.map((band) => ({
            ...band,
            opacityPoints: band.opacityPoints.map((p) => [p[0], p[1]] as const),
          }))
        : undefined;
    activeBandIndex = 0; // the restored band list (if any) may be a different length/order
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
    picking.clear();
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

  const picking = new PickingController({
    canvas,
    camera,
    invViewProj,
    lastViewProj,
    getSource: () => source,
    getLevel: () => level,
    sizeSim,
    cropping,
    valueRange,
    isLoading: () => loading,
    getVolumeUnit3: () => um3(),
    applyRender: () => applyRender(),
    renderUi: () => renderUi(),
    onPicked: () => {
      openSections.add("measure");
      activeTab = "volume";
    },
  });
  session.onDispose(() => picking.dispose());

  const cropDrag = new CropDragController({
    canvas,
    camera,
    invViewProj,
    lastViewProj,
    sizeSim,
    cropping,
    isVolumeView: () => rendering.viewMode === "volume",
    applyRender: () => applyRender(),
    onDragEnd: () => {
      renderUi();
      emitCropping();
    },
  });
  session.onDispose(() => cropDrag.dispose());

  const renderUi = (): void => {
    requestRender(); // catch-all: any HUD interaction that rebuilds the panel also repaints the canvas
    curveEditor?.dispose();
    curveEditor = undefined;

    const [dx, dy, dz] = source.dimensionsAt(level);
    const unit = lengthUnit();

    const dataBody = dataPanelBody({
      source,
      levels,
      level,
      loading,
      maxTex,
      unit,
      roiEnabled: residency.isEnabled,
      roiProgress: residency.progress,
    });
    const tfBody = tfPanelBody(rendering, activeBandIndex);
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

    const cropBody = cropPanelBody(cropping, cropDrag.cropMode);
    const measureBody = measurePanelBody({
      rendering,
      pickMode: picking.pickMode,
      pickStatus: picking.status,
      lastPick: picking.lastFeature,
      u3: um3(),
    });
    const postfxBody = postfxPanelBody(rendering);
    const lightingBody = lightingPanelBody({ rendering });

    // Presets section — sanitize the selection against the current preset list before rendering, so
    // it stays valid across preset add/remove and HUD rebuilds.
    const presetNames = listPresetNames();
    selectedPreset = sanitizeSelectedPreset(selectedPreset, presetNames);
    const presetsBody = presetsPanelBody(presetNames, selectedPreset);

    // Reassigning innerHTML resets the container's native scrollTop to 0 in every browser - since
    // renderUi() rebuilds the whole sidebar on many routine interactions (not just rare ones), that
    // reset was the actual cause of the HUD "feeling slow to scroll/interact with": every such
    // interaction silently snapped the sidebar back to the top. <details> open/close state already
    // survives via `openSections`; scroll position needs the same explicit save/restore.
    const controlsBody = controlsPanelBody(rendering);
    const annotationsBody = annotationsPanelBody([
      {
        maskUrl: maskSlots[0].url,
        maskLoading: maskSlots[0].loading,
        maskError: maskSlots[0].error,
        maskLoaded: maskSlots[0].classes !== undefined,
        classes: maskSlots[0].classes ?? [],
      },
      {
        maskUrl: maskSlots[1].url,
        maskLoading: maskSlots[1].loading,
        maskError: maskSlots[1].error,
        maskLoaded: maskSlots[1].classes !== undefined,
        classes: maskSlots[1].classes ?? [],
      },
    ]);
    const allPanels: { id: PanelId; title: string; body: string }[] = [
      { id: "data", title: "Data", body: dataBody },
      { id: "tf", title: "Transfer Function", body: tfBody },
      { id: "slices", title: "Slices", body: slicesBody },
      { id: "crop", title: "Crop", body: cropBody },
      { id: "measure", title: "Measure", body: measureBody },
      { id: "annotations", title: "Annotations", body: annotationsBody },
      { id: "presets", title: "Presets", body: presetsBody },
      { id: "render", title: "Render", body: renderBody },
      { id: "lighting", title: "Lighting", body: lightingBody },
      { id: "postfx", title: "Post FX", body: postfxBody },
      { id: "controls", title: "Controls", body: controlsBody },
    ];
    // Only the active tab's panels render at all - the other tab's <details> don't exist in the DOM,
    // so there's nothing to scroll past to find a section in the tab you're actually using.
    const tabPanelIds = activeTab === "volume" ? VOLUME_TAB_PANELS : RENDER_TAB_PANELS;
    const sectionsHtml = tabPanelIds
      .map((id) => allPanels.find((p) => p.id === id))
      .filter((p): p is (typeof allPanels)[number] => p !== undefined)
      .map((p) => section(openSections, p.id, p.title, p.body))
      .join("");

    const savedScrollTop = ui.scrollTop;
    ui.innerHTML = [
      `<div class="whud__header">` +
        `<span class="whud__title">Tomography Volume Renderer</span>` +
        `<button type="button" class="whud__tab-btn${activeTab === "volume" ? " whud__tab-btn--active" : ""}" ` +
        `data-act="setTab" data-tab="volume" title="Volume settings" aria-label="Volume settings">▣</button>` +
        `<button type="button" class="whud__tab-btn${activeTab === "render" ? " whud__tab-btn--active" : ""}" ` +
        `data-act="setTab" data-tab="render" title="Render settings" aria-label="Render settings">⚙</button>` +
        `<button type="button" class="whud__collapse-btn" data-act="toggleCollapse" ` +
        `title="${collapsed ? "Expand panel" : "Collapse panel"}" ` +
        `aria-label="${collapsed ? "Expand panel" : "Collapse panel"}">${collapsed ? "\u2039" : "\u203A"}</button>` +
        `</div>`,
      `<div class="whud__status">L${level} · ${dx}×${dy}×${dz}${loading ? " · loading…" : ""}${picking.pickMode ? " · PICK" : ""}${residency.brickLevel !== undefined ? ` · ROI L${residency.brickLevel}` : ""}</div>`,
      sectionsHtml,
      `<div class="whud__hint">Pan: Space+drag / Shift / middle / right · wheel zooms to cursor · P / Ctrl+click pick · [ ] LOD · O open</div>`,
    ].join("");
    ui.scrollTop = savedScrollTop;

    // Only one section open at a time, within the active tab - opening one closes the others (both in
    // openSections and in the live DOM, so the browser's own <details> state agrees immediately without
    // a full renderUi() rebuild).
    for (const el of ui.querySelectorAll<HTMLDetailsElement>("details.whud__section")) {
      const id = el.dataset.section as PanelId | undefined;
      if (!id) continue;
      el.addEventListener("toggle", () => {
        if (el.open) {
          openSections.clear();
          openSections.add(id);
          for (const other of ui.querySelectorAll<HTMLDetailsElement>("details.whud__section")) {
            if (other !== el) other.open = false;
          }
        } else {
          openSections.delete(id);
        }
      });
    }

    if (!collapsed && openSections.has("tf")) {
      const c = ui.querySelector<HTMLCanvasElement>("#opacity-curve");
      if (c) {
        // Bands mode: the shared editor edits whichever band is selected, in that band's own local
        // [0,1] range (each band is already its own sub-domain — no separate color-range squeeze).
        const bands = rendering.tfBands;
        const activeBand =
          bands && bands.length > 0 ? bands[Math.min(activeBandIndex, bands.length - 1)] : undefined;
        curveEditor = new OpacityCurveEditor(c, activeBand ? activeBand.opacityPoints : rendering.opacityPoints, {
          colorMap: activeBand ? activeBand.colorMap : rendering.colorMap,
          colorRange: activeBand ? [0, 1] : [rendering.colorLo, rendering.colorHi],
          onChange: (pts) => {
            if (activeBand) {
              activeBand.opacityPoints = pts.map((p) => [p[0], p[1]] as const);
            } else {
              rendering.opacityPoints = pts.map((p) => [p[0], p[1]] as const);
            }
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

  const hudEventCtx: HudEventContext = {
    ui,
    canvas,
    rendering,
    cropping,
    volumeRenderer,
    fxPipeline,
    taau,
    residency,
    picking,
    cropDrag,
    openSections,
    getSource: () => source,
    getLevel: () => level,
    getCurveEditor: () => curveEditor,
    getRawHistogram: () => rawHistogram,
    getHistogram: () => histogram,
    getSelectedPreset: () => selectedPreset,
    setSelectedPreset: (v) => {
      selectedPreset = v;
    },
    getActiveBandIndex: () => activeBandIndex,
    setActiveBandIndex: (v) => {
      activeBandIndex = v;
    },
    loadMask: (slot, url) => {
      void loadMask(slot, url);
    },
    removeMask: (slot) => removeMask(slot),
    setMaskClassColor,
    setMaskClassOpacity,
    toggleMaskClassVisible,
    getCollapsed: () => collapsed,
    setCollapsed: (v) => {
      collapsed = v;
    },
    getActiveTab: () => activeTab,
    setActiveTab: (v) => {
      activeTab = v;
    },
    applyLevel: (next) => void applyLevel(next),
    applyRender: () => applyRender(),
    applyTf: () => applyTf(),
    applyRenderingState: (state) => applyRenderingState(state),
    renderUi: () => renderUi(),
    emitRendering: () => emitRendering(),
    emitCropping: () => emitCropping(),
    setViewModeAndEmit: (mode, opts) => setViewModeAndEmit(mode, opts),
    resetCrop: () => resetCrop(),
    frameSliceCamera: () => frameSliceCamera(),
    recomputeEqualize: () => recomputeEqualize(),
    rebuildFxStack: () => rebuildFxStack(),
    applyLighting: () => applyLighting(),
    setActiveSlice: (v) => setActiveSlice(v),
    activeSlice: () => activeSlice(),
    sliceWorldLabel: (axis, t) => sliceWorldLabel(axis, t),
    readRendering: () => readRendering(),
  };
  bindHudEvents(hudEventCtx);

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
        picking.togglePickMode();
        openSections.add("measure");
        activeTab = "volume";
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
        picking.clear();
        loaderOpened = false; // new dataset → reopen the loader (drops old resident textures)
        residency.clearForNewDataset(); // drop the old dataset's ROI brick
        if (levels.length) applyLevel(finestTargetLevel(), true);
      } else if (e.code === "KeyE") {
        picking.clear();
        resetCrop();
      } else if (e.code === "KeyL") {
        debugLightAdd = !debugLightAdd;
        requestRender();
      } else if (e.code === "KeyC") {
        cropDrag.toggleCropMode();
        openSections.add("crop");
        activeTab = "volume";
        renderUi();
      }
    })();
  });

  const proj = new Mat4();
  const view = new Mat4();
  const viewProj = new Mat4();
  console.info(
    "[zarr-viewer] levels",
    levels,
    "maxTex",
    maxTex,
    "extent m",
    volumeMaxExtentMeters(source, level),
  );

  session.loop((dt) => {
    if (deviceLost) return; // Phase 4a hardening — stop all GPU work once the device is gone
    resizeViewerCanvas(canvas);
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
    // isAnimating's damping-convergence thresholds are intentionally tight (see its own doc comment),
    // so its exponential tail can keep reporting "still animating" for longer than the eye can tell the
    // difference - if TAAU has already fully converged (settled image, sampleCount at the cap), that
    // lingering true stops mattering: once the accumulated image is as good as it's going to get, more
    // frames only cost time (each one re-runs the full per-sample lighting path, since half-res/
    // half-res-lighting are both off once settled - see `settled` below) without improving anything, so
    // don't let isAnimating alone keep the loop rendering past that point. Also stop once the settled
    // run has been going for TAAU_SETTLE_TIME_CAP_S, regardless of sample count - see its own comment.
    const taauFullyConverged =
      rendering.temporalAA &&
      (taau.sampleCount >= taau.maxAccum || settledElapsed >= TAAU_SETTLE_TIME_CAP_S);
    if ((controls.isAnimating && !taauFullyConverged) || !camsEqual(camNow, lastRenderCam)) requestRender();
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
    residency.update(dt);
    // Adaptive sampling: coarsen the ray step while navigating (camera moving) for a smooth framerate,
    // then refine once settled. `residency.idle` is seconds since the camera last moved.
    // Coarsen instantly for responsiveness; ease back to the configured `sampleDist` over ~0.4 s so the
    // sharpening isn't a visible pop. max(NAV_SAMPLE_DIST, sampleDist) keeps a coarse slider still coarse.
    const navTarget = residency.idle < NAV_SETTLE ? Math.max(NAV_SAMPLE_DIST, rendering.sampleDist) : rendering.sampleDist;
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
    interactionIdle += dt; // seconds since the last TF-curve/slider drag (see markInteracting())
    // "Settled" = camera stopped AND the adaptive step has finished refining AND no HUD drag (TF curve,
    // any render/lighting slider) is actively in progress (else we'd blend coarse-in-motion frames with
    // the sharp ones, or drop back to full quality mid-drag and jank the editing itself). Drives TAAU
    // accumulation, and (Milestone 6/B3) the two half-res levers below: half-res render scale and
    // half-res G-buffer lighting both apply only while navigating/interacting, reverting to full quality
    // once still — so the toggles buy interaction-time smoothness without permanently baking their
    // approximations into the settled image people actually look at / screenshot.
    const settled =
      residency.idle >= NAV_SETTLE &&
      interactionIdle >= NAV_SETTLE &&
      Math.abs(navSampleDist - rendering.sampleDist) < 0.02;
    fxPipeline.setRenderScale(rendering.halfRes && !settled ? 0.5 : 1);
    controls.invertX = rendering.invertOrbitX;
    controls.invertY = rendering.invertOrbitY;
    // Volume → linear HDR, then the post stack to the swapchain (one encoder / one submit). The DOM
    // overlay (gizmo + scale bar) draws to a separate canvas and is unaffected.
    const rw = Math.max(1, Math.round(canvas.width * fxPipeline.renderScale));
    const rh = Math.max(1, Math.round(canvas.height * fxPipeline.renderScale));
    volumeRenderer.setInternalSize(rw, rh);
    volumeRenderer.setReprojectFar(far); // normalize the depth-centroid output for TAAU reprojection
    // Milestone 5: accumulate only once fully settled. Anything else resets the history so a moving view
    // shows the live frame with no ghosting. When accumulating, jitter the projection sub-pixel so
    // successive converged frames supersample; the un-jittered viewProj still drives ROI/overlay.
    let renderViewProj = viewProj;
    if (rendering.temporalAA) {
      // On the moving→settled edge, reseed accumulation so the sharp frames replace the coarse in-motion
      // history; a moving view keeps converging via reprojection rather than resetting.
      if (settled && !taauPrevSettled) {
        taau.reset();
        settledElapsed = 0;
      } else if (settled) {
        settledElapsed += dt;
      } else {
        settledElapsed = 0;
      }
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
    // Phase 1a hardening: the separate half-res LightingPass below only runs while `runLightingPass`
    // is true - the main ray march must defer its OWN heavy (AO/shadow/multi-scatter) cost exactly
    // when that's the case, or the "half-res lighting" toggle pays full heavy cost inline AND a second
    // half-res computation, which is strictly more expensive than not deferring at all. See
    // VolumeRenderer.setDeferLighting()'s doc comment for the shader-side mechanism.
    const runLightingPass = debugLightAdd || (rendering.gbufferLighting && !settled);
    volumeRenderer.setDeferLighting(runLightingPass);
    fxPipeline.render(
      { r: 0.015, g: 0.02, b: 0.035, a: 1 },
      (pass) => {
        volumeRenderer.recordInto(pass, renderViewProj, camera.position);
      },
      (encoder) => {
        volumeRenderer.recordPrePasses(encoder, renderViewProj, camera.position);
      },
      taau,
      runLightingPass
        ? {
            recordLighting: (graph, gbuffer, lw, lh) =>
              volumeRenderer.recordLighting(graph, gbuffer, lw, lh),
            mode: debugLightAdd ? "debug" : "composite",
          }
        : undefined,
    );
    if (debugLightAdd) requestRender(); // keep redrawing while the debug view is on (no idle path yet)
    volumeRenderer.afterSubmit();
    // Half-res render scale / lighting only apply while navigating (see `settled` above) — the settle
    // edge must trigger one more frame so the final full-quality image actually gets drawn and stays.
    if (!settled) requestRender();

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
    // Crop-box wireframe: only while crop mode is on (see item 6's plan - avoids visual clutter
    // otherwise). Projects the box's 8 world corners through the current (un-jittered) viewProj.
    const cropBox = cropDrag.cropMode && rendering.viewMode === "volume"
      ? (() => {
          const world = cropWorldBox(cropping.cropMin, cropping.cropMax, sizeSim);
          // Project in the WebGPU canvas's own backing-store aspect ratio - the same one
          // proj.perspective() above used (canvas.width / canvas.height) - then scale down to CSS
          // pixels for the overlay canvas's own (already dpr-transformed) drawing space. Using
          // canvas.clientWidth/clientHeight directly here would assume that ratio exactly matches
          // canvas.width/canvas.height's, which independent per-axis Math.floor(css*dpr) rounding
          // during canvas resize doesn't guarantee - a small mismatch reads as a skewed box.
          const bw = canvas.width || 1;
          const bh = canvas.height || 1;
          const cssPerBackingX = (canvas.clientWidth || 1) / bw;
          const cssPerBackingY = (canvas.clientHeight || 1) / bh;
          const corners = boxCorners(world.min, world.max).map(([x, y, z]) => {
            const p = worldToScreen(lastViewProj, x, y, z, bw, bh);
            return p ? ([p[0] * cssPerBackingX, p[1] * cssPerBackingY] as [number, number]) : null;
          });
          return { corners, highlight: cropDrag.activeFace };
        })()
      : undefined;
    // De-roll the gizmo's basis: "trackball" orbiting (this app's default) has no fixed up axis, so
    // the camera's *actual* right/up accumulate roll as you free-rotate. Passing the raw camera basis
    // to the gizmo makes the volume's fixed world axes look like they're spinning/tilting purely from
    // that incidental roll. derollCameraBasis reconstructs right/up as if roll were always zero
    // relative to a reference "up" axis, so the gizmo reads as "how is the volume oriented on screen"
    // rather than "how is the camera currently rolled" — forward is unaffected (roll doesn't change
    // view direction). The reference is world Z, not Y: this viewer's camera/orbit math is internally
    // Y-up (an arbitrary render-space choice, unrelated to the data), but for tomography data Z is the
    // dataset's own stack axis (world Z = dataset Z directly, no separate volume transform in this
    // app) and reads as "vertical" to the people looking at it - that's the axis the gizmo should hold
    // steady, independent of which axis OrbitControls happens to use internally for navigation.
    const gizmoBasis = derollCameraBasis(basis.forward, basis.right, basis.up, [0, 0, 1]);
    overlay.draw({
      right: gizmoBasis.right,
      up: gizmoBasis.up,
      forward: basis.forward,
      ruler,
      cropBox,
    });

    // Live total-GPU-ms readout in the Lighting panel for A/B-comparing the half-res lighting toggle's
    // perf impact, without a full renderUi() rebuild every frame. Total = sum of every timed pass
    // (volume + lighting-composite + TAAU currently - see FxPipeline.lastGpuMs's doc for what isn't
    // included yet); per-pass breakdown is in the tooltip so this stays a single-number HUD readout.
    const gpuMsLabel = ui.querySelector<HTMLElement>("#gpuMsLabel");
    if (gpuMsLabel) {
      const ms = fxPipeline.lastGpuMs;
      gpuMsLabel.textContent = ms === undefined ? "–" : ms.toFixed(2);
      gpuMsLabel.title =
        fxPipeline.lastGpuSamples.length > 0
          ? fxPipeline.lastGpuSamples.map((s) => `${s.label}: ${s.ms.toFixed(2)}ms`).join("\n")
          : "";
    }

    // Record what we just rendered, and keep the budget alive while anything is still converging so the
    // image finishes refining after the camera stops (adaptive step easing, TAAU accumulating, ROI brick
    // fading in) — then it naturally goes idle.
    lastRenderCam = camNow;
    lastRenderW = canvas.width;
    lastRenderH = canvas.height;
    const adaptiveEasing = Math.abs(navSampleDist - rendering.sampleDist) > 0.005;
    // Mirrors taauFullyConverged's sample-cap-OR-time-cap logic above (recomputed here rather than
    // reused, since settledElapsed was updated later in this same frame and this check runs after
    // that update — using the stale earlier value would keep requesting one extra frame past the cap).
    const taauConverging =
      rendering.temporalAA &&
      taau.sampleCount < taau.maxAccum &&
      settledElapsed < TAAU_SETTLE_TIME_CAP_S;
    const brickFading = residency.isFading;
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
    loadMask: (slot, url) => {
      void loadMask(slot, url);
    },
    loadMaskFromArray: (slot, data, dims) => {
      void loadMaskArray(slot, data, dims);
    },
    removeMask: (slot) => removeMask(slot),
    setMaskClassColor,
    setMaskClassOpacity,
    toggleMaskClassVisible,
    getMaskClasses: (slot) => maskSlots[slot].classes,
    getMemoryStats: () => {
      const gpuBrickBytes = residency.brickBytes;
      const densityPyramidBytes = volumeRenderer.densityPyramidBytes;
      const renderTargetBytes = fxPipeline.renderTargetBytes;
      return {
        gpuBrickBytes,
        densityPyramidBytes,
        renderTargetBytes,
        totalEstimatedGpuBytes: gpuBrickBytes + densityPyramidBytes + renderTargetBytes,
      };
    },
    dispose: () => handle.dispose(),
  };
  return instance;
}
