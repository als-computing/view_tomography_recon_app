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
  fileSystemStore,
  physicalSizeQuantities,
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
  VolumeRenderer,
  composeTransferFunction,
  OpacityCurveEditor,
  DEFAULT_OPACITY_POINTS,
  colorMapNames,
  makeDirectionalLight,
  makeSpotLight,
  type GpuLight,
  type ColorMapName,
  type OpacityPoint,
  type VolumeBlendMode,
  type VolumeViewMode,
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

const DEFAULT_ZARR = "/datasets/petiole.zarr";

type PanelId = "data" | "tf" | "render" | "slices" | "crop" | "measure" | "postfx" | "lighting";

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

/** Everything that shapes the volume's appearance (transfer function + render params + view mode). */
export interface WebGpuRenderingState {
  colorMap: ColorMapName;
  colorLo: number;
  colorHi: number;
  opacityScale: number;
  opacityPoints: OpacityPoint[];
  densityScale: number;
  exposure: number;
  sampleDist: number;
  blendMode: VolumeBlendMode;
  gradOpacity: number;
  gradScale: number;
  lighting: number;
  viewMode: VolumeViewMode;
  // Post-processing FX (tonemap is always applied; the rest are toggle-gated).
  fxOperator: ToneMapOperator;
  fxExposure: number;
  fxBloom: boolean;
  fxBloomThreshold: number;
  fxBloomIntensity: number;
  fxFxaa: boolean;
  fxSharpen: boolean;
  fxSharpenAmount: number;
  fxVignette: boolean;
  fxVignetteAmount: number;
  // Lighting: per-mode on/off + color (sRGB hex) + intensity, shading params, shadows, AO, half-res.
  lightGlobalOn: boolean;
  lightGlobalColor: string;
  lightGlobalIntensity: number;
  lightAzimuth: number;
  lightElevation: number;
  lightFlashOn: boolean;
  lightFlashColor: string;
  lightFlashIntensity: number;
  lightStageOn: boolean;
  lightStageColor: string;
  lightStageIntensity: number;
  lightAmbient: number;
  lightSpecular: number;
  lightRoughness: number;
  shadowOn: boolean;
  shadowQuality: number;
  shadowStrength: number;
  aoOn: boolean;
  aoRadius: number;
  aoIntensity: number;
  halfRes: boolean;
}

/** The ROI crop box plus the slice planes (positions, per-axis enables, overlay visibility). */
export interface WebGpuCroppingState {
  cropMin: [number, number, number];
  cropMax: [number, number, number];
  sliceX: number;
  sliceY: number;
  sliceZ: number;
  enX: boolean;
  enY: boolean;
  enZ: boolean;
  showPlanes: boolean;
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

function mulMat4Vec4(
  m: Mat4,
  x: number,
  y: number,
  z: number,
  w: number,
): [number, number, number, number] {
  const e = m.elements;
  return [
    e[0]! * x + e[4]! * y + e[8]! * z + e[12]! * w,
    e[1]! * x + e[5]! * y + e[9]! * z + e[13]! * w,
    e[2]! * x + e[6]! * y + e[10]! * z + e[14]! * w,
    e[3]! * x + e[7]! * y + e[11]! * z + e[15]! * w,
  ];
}

/** Largest "nice" 1/2/5·10ⁿ value ≤ x — for a scale bar whose length never exceeds its pixel budget. */
function niceFloor125(x: number): number {
  const exp = Math.floor(Math.log10(x));
  const base = Math.pow(10, exp);
  const f = x / base; // in [1, 10)
  const m = f >= 5 ? 5 : f >= 2 ? 2 : 1;
  return m * base;
}

/** Format a nice-number for a scale-bar label, stripping float noise (e.g. 0.30000004 → "0.3"). */
function formatNice(v: number): string {
  return String(Number(v.toPrecision(6)));
}

function zarrUrlFromQuery(): string {
  const q = new URLSearchParams(window.location.search).get("zarr");
  return q && q.length > 0 ? q : DEFAULT_ZARR;
}

async function pickZarrStore(): Promise<Store | undefined> {
  const w = window as Window & {
    showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
  };
  if (typeof w.showDirectoryPicker !== "function") return undefined;
  return fileSystemStore(await w.showDirectoryPicker());
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
  let colorMap: ColorMapName = "bone";
  let colorLo = 0.15;
  let colorHi = 0.85;
  let opacityScale = 1;
  let opacityPoints: OpacityPoint[] = [...DEFAULT_OPACITY_POINTS];
  let densityScale = 1.45;
  let exposure = 1.2;
  let sampleDist = 1;
  let blendMode: VolumeBlendMode = "composite";
  let gradOpacity = 0.25;
  let gradScale = 0.12;
  let lighting = 0.85;
  let viewMode: VolumeViewMode = "volume";
  // Post FX state. Tonemap is always applied (the HDR→display map + exposure); everything else is
  // toggle-gated. Defaults reproduce today's look: ACES at exposure 0, all extras off.
  let fxOperator: ToneMapOperator = "aces";
  let fxExposure = 0;
  let fxBloom = false;
  let fxBloomThreshold = 1.1;
  let fxBloomIntensity = 0.6;
  let fxFxaa = false;
  let fxSharpen = false;
  let fxSharpenAmount = 0.5;
  let fxVignette = false;
  let fxVignetteAmount = 0.4;
  // Lighting state. Defaults preserve today's look: one warm global directional; flashlight / stage /
  // shadows / AO off, full-res. The light set is rebuilt per frame from the camera basis.
  let lightGlobalOn = true;
  let lightGlobalColor = "#fff2e0";
  let lightGlobalIntensity = 1;
  let lightAzimuth = 38; // degrees
  let lightElevation = 56; // degrees
  let lightFlashOn = false;
  let lightFlashColor = "#ffffff";
  let lightFlashIntensity = 1.2;
  let lightStageOn = false;
  let lightStageColor = "#cfe0ff";
  let lightStageIntensity = 0.6;
  let lightAmbient = 0.22;
  let lightSpecular = 0.4;
  let lightRoughness = 0.6;
  let shadowOn = false;
  let shadowQuality = 24;
  let shadowStrength = 0.85;
  let aoOn = false;
  let aoRadius = 0.08;
  let aoIntensity = 0.7;
  let halfRes = false;
  let sliceX = 0.5;
  let sliceY = 0.5;
  let sliceZ = 0.5;
  let enX = false;
  let enY = false;
  let enZ = false;
  let showPlanes = false;
  let cropMin: [number, number, number] = [0, 0, 0];
  let cropMax: [number, number, number] = [1, 1, 1];
  const openSections = new Set<PanelId>(["tf", "render"]);
  let loading = false;
  let baseStep = 1 / 220;
  let pickMode = false;
  let measuring = false;
  let lastPick: PickedFeature | undefined;
  let pickStatus = "";
  const invViewProj = new Mat4();
  const lastViewProj = new Mat4();

  // Snapshot the rendering / cropping groups from the live closure state. Defined up here so the
  // early error-path instances (below) can expose them too.
  const readRendering = (): WebGpuRenderingState => ({
    colorMap,
    colorLo,
    colorHi,
    opacityScale,
    opacityPoints: opacityPoints.map((p) => [p[0], p[1]] as const),
    densityScale,
    exposure,
    sampleDist,
    blendMode,
    gradOpacity,
    gradScale,
    lighting,
    viewMode,
    fxOperator,
    fxExposure,
    fxBloom,
    fxBloomThreshold,
    fxBloomIntensity,
    fxFxaa,
    fxSharpen,
    fxSharpenAmount,
    fxVignette,
    fxVignetteAmount,
    lightGlobalOn,
    lightGlobalColor,
    lightGlobalIntensity,
    lightAzimuth,
    lightElevation,
    lightFlashOn,
    lightFlashColor,
    lightFlashIntensity,
    lightStageOn,
    lightStageColor,
    lightStageIntensity,
    lightAmbient,
    lightSpecular,
    lightRoughness,
    shadowOn,
    shadowQuality,
    shadowStrength,
    aoOn,
    aoRadius,
    aoIntensity,
    halfRes,
  });
  const readCropping = (): WebGpuCroppingState => ({
    cropMin: [cropMin[0], cropMin[1], cropMin[2]],
    cropMax: [cropMax[0], cropMax[1], cropMax[2]],
    sliceX,
    sliceY,
    sliceZ,
    enX,
    enY,
    enZ,
    showPlanes,
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

  let store: Store = httpStore(options?.zarrUrl ?? zarrUrlFromQuery());
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
    densityScale,
    // Safety cap only; the renderer derives per-frame step count from the box diagonal so the whole
    // depth is always marched (no backside clipping) regardless of orientation or sample distance.
    maxSteps: 4096,
    exposure,
    ambient: 0.22,
    clearColor: [0.015, 0.02, 0.035, 1],
    blendMode,
    gradientOpacity: gradOpacity,
    gradientOpacityScale: gradScale,
    lightingStrength: lighting,
    // Render into a linear-HDR target so the post stack tonemaps once (the shader skips its inline
    // ACES+gamma). Both are construct-time only.
    colorFormat: "rgba16float",
    linearOutput: true,
  });

  // Post-processing driver: volume → linear HDR → bloom/tonemap/fxaa/sharpen/vignette → swapchain.
  const fxPipeline = new FxPipeline(ctx);
  const rebuildFxStack = (): void => {
    const effects: Effect[] = [];
    // HDR-space effects first (bloom operates on linear HDR), then the mandatory tonemap maps
    // HDR→sRGB LDR, then the LDR effects (fxaa → sharpen → vignette).
    if (fxBloom) {
      effects.push(bloom({ threshold: fxBloomThreshold, intensity: fxBloomIntensity }));
    }
    effects.push(tonemap(fxOperator, { exposureStops: fxExposure }));
    if (fxFxaa) effects.push(fxaa());
    if (fxSharpen) effects.push(sharpen({ amount: fxSharpenAmount }));
    if (fxVignette) effects.push(vignette({ amount: fxVignetteAmount }));
    fxPipeline.setStack(effects);
  };
  rebuildFxStack();

  // sRGB hex (from <input type="color">) → linear RGB for the HDR shading path.
  const srgbToLinear = (c: number): number =>
    c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const hexToLinearRgb = (hex: string): [number, number, number] => {
    const h = hex.replace("#", "");
    return [
      srgbToLinear(parseInt(h.slice(0, 2), 16) / 255),
      srgbToLinear(parseInt(h.slice(2, 4), 16) / 255),
      srgbToLinear(parseInt(h.slice(4, 6), 16) / 255),
    ];
  };

  // Push the (non-per-frame) lighting params to the renderer + set the half-res lever. Called on any
  // Lighting-panel change; the light *positions* themselves are rebuilt per frame (below).
  const applyLighting = (): void => {
    volumeRenderer.setLightingParams({
      masterAmbient: lightAmbient,
      specStrength: lightSpecular,
      roughness: lightRoughness,
      shadowEnable: shadowOn,
      shadowSteps: shadowQuality,
      shadowStrength,
      aoEnable: aoOn,
      aoRadius,
      aoIntensity,
      aoSamples: 6,
    });
    fxPipeline.setRenderScale(halfRes ? 0.5 : 1);
  };

  // Rebuild the GPU light list from the enabled modes + the camera basis. Global is a fixed-direction
  // directional (also drives the studio env); flashlight is a spot at the eye aimed at the sample;
  // stage lights are four spots pinned to the screen corners aiming inward for even fill.
  const buildFrameLights = (
    eye: { x: number; y: number; z: number },
    right: readonly [number, number, number],
    up: readonly [number, number, number],
    fwd: readonly [number, number, number],
    extent: number,
  ): GpuLight[] => {
    const lights: GpuLight[] = [];
    if (lightGlobalOn) {
      const el = (lightElevation * Math.PI) / 180;
      const az = (lightAzimuth * Math.PI) / 180;
      const dir: [number, number, number] = [
        Math.cos(el) * Math.cos(az),
        Math.sin(el),
        Math.cos(el) * Math.sin(az),
      ];
      lights.push(makeDirectionalLight(dir, hexToLinearRgb(lightGlobalColor), lightGlobalIntensity));
    }
    if (lightFlashOn) {
      lights.push(
        makeSpotLight(
          [eye.x, eye.y, eye.z],
          [-eye.x, -eye.y, -eye.z],
          hexToLinearRgb(lightFlashColor),
          lightFlashIntensity,
          { range: extent * 6, innerConeAngle: Math.PI * 0.28, outerConeAngle: Math.PI * 0.44 },
        ),
      );
    }
    if (lightStageOn) {
      const d = extent * 2.2; // in front of the eye along the view axis
      const k = extent * 1.7; // corner spread
      const col = hexToLinearRgb(lightStageColor);
      const corners: [number, number][] = [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ];
      for (const [sx, sy] of corners) {
        const pos: [number, number, number] = [
          eye.x + fwd[0] * d + right[0] * k * sx + up[0] * k * sy,
          eye.y + fwd[1] * d + right[1] * k * sx + up[1] * k * sy,
          eye.z + fwd[2] * d + right[2] * k * sx + up[2] * k * sy,
        ];
        lights.push(
          makeSpotLight(pos, [-pos[0], -pos[1], -pos[2]], col, lightStageIntensity, {
            range: extent * 8,
            innerConeAngle: Math.PI * 0.34,
            outerConeAngle: Math.PI * 0.48,
          }),
        );
      }
    }
    return lights;
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
    if (e instanceof WheelEvent && viewMode !== "volume" && !e.ctrlKey && !e.metaKey) {
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
  let histogram: Float32Array | undefined;
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
  const emitRendering = (): void => emit("renderingChange");
  const emitCropping = (): void => emit("croppingChange");
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
      opacity: opacityPoints,
      colorMap,
      colorRange: [colorLo, colorHi],
      opacityScale,
      samples: 48,
    });
    volumeRenderer.setTransferFunction(tf, 512);
    curveEditor?.setColorMap(colorMap);
    curveEditor?.setPoints(opacityPoints);
    curveEditor?.setColorRange([colorLo, colorHi]);
  };

  const applyRender = (): void => {
    volumeRenderer.setParams({
      densityScale,
      exposure,
      stepSize: baseStep * sampleDist,
      blendMode,
      gradientOpacity: gradOpacity,
      gradientOpacityScale: gradScale,
      lightingStrength: lighting,
    });
    volumeRenderer.setViewMode(viewMode);
    volumeRenderer.setSlices(sliceX, sliceY, sliceZ);
    volumeRenderer.setSliceEnabled("x", enX);
    volumeRenderer.setSliceEnabled("y", enY);
    volumeRenderer.setSliceEnabled("z", enZ);
    volumeRenderer.setSlicePlanesVisible(showPlanes);
    volumeRenderer.setCrop(cropMin, cropMax);
  };

  /** Frame camera looking along the active slice normal (itk-vtk style). */
  const frameSliceCamera = (): void => {
    const extent = Math.max(sizeSim.x, sizeSim.y, sizeSim.z) || 1;
    const px = (sliceX - 0.5) * sizeSim.x;
    const py = (sliceY - 0.5) * sizeSim.y;
    const pz = (sliceZ - 0.5) * sizeSim.z;
    const dist = extent * 1.65;
    if (viewMode === "xPlane") {
      controls.target.set(px, 0, 0);
      camera.position.set(px + dist, py * 0.05, pz * 0.05);
    } else if (viewMode === "yPlane") {
      controls.target.set(0, py, 0);
      camera.position.set(px * 0.05, py + dist, pz * 0.05);
    } else if (viewMode === "zPlane") {
      controls.target.set(0, 0, pz);
      camera.position.set(px * 0.05, py * 0.05, pz + dist);
    } else {
      controls.target.set(0, 0, 0);
      camera.position.set(extent * 1.2, extent * 0.85, extent * 1.2);
    }
    controls.syncFromNode();
    controls.update(0);
  };

  const enterViewMode = (mode: VolumeViewMode, reframe = true): void => {
    viewMode = mode;
    if (mode === "xPlane") {
      enX = true;
      showPlanes = true;
    } else if (mode === "yPlane") {
      enY = true;
      showPlanes = true;
    } else if (mode === "zPlane") {
      enZ = true;
      showPlanes = true;
    }
    applyRender();
    if (reframe) frameSliceCamera();
  };

  const activeSlice = (): { axis: "x" | "y" | "z"; value: number } | null => {
    if (viewMode === "xPlane") return { axis: "x", value: sliceX };
    if (viewMode === "yPlane") return { axis: "y", value: sliceY };
    if (viewMode === "zPlane") return { axis: "z", value: sliceZ };
    return null;
  };

  const setActiveSlice = (v: number): void => {
    const clamped = Math.min(1, Math.max(0, v));
    if (viewMode === "xPlane") sliceX = clamped;
    else if (viewMode === "yPlane") sliceY = clamped;
    else if (viewMode === "zPlane") sliceZ = clamped;
    else return;
    applyRender();
  };

  const sliceWorldLabel = (axis: "x" | "y" | "z", t: number): string => {
    const u = lengthUnit();
    const size = axis === "x" ? sizeSim.x : axis === "y" ? sizeSim.y : sizeSim.z;
    // sizeSim is already in microscopy units (µm-scale numbers). Convert via SI for display.
    const halfSi = units.fromSim(size * 0.5, units.LENGTH, sim);
    const pos = halfSi.mul(2 * t - 1);
    return `${pos.to(u).toFixed(1)} ${u.symbol}`;
  };

  // Called by the loader each time a (finer) level's texture becomes ready. Swaps the volume, updates
  // the histogram + ray step for the displayed resolution, and clears "loading" once target is reached.
  const onDisplayedLevel = (result: VolumeLevelResult): void => {
    level = result.level;
    volumeRenderer.setVolume(result.texture);
    histogram = result.histogram;
    curveEditor?.setHistogram(histogram);
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
    if (reframe) {
      if (viewMode === "volume") {
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
      const nearH = mulMat4Vec4(invViewProj, u, v, 0, 1);
      const farH = mulMat4Vec4(invViewProj, u, v, 1, 1);
      const nw = 1 / (nearH[3] || 1e-12);
      const fw = 1 / (farH[3] || 1e-12);
      const nx = nearH[0]! * nw;
      const ny = nearH[1]! * nw;
      const nz = nearH[2]! * nw;
      const fx = farH[0]! * fw;
      const fy = farH[1]! * fw;
      const fz = farH[2]! * fw;
      let dx = fx - nx;
      let dy = fy - ny;
      let dz = fz - nz;
      const len = Math.hypot(dx, dy, dz) || 1;
      dx /= len;
      dy /= len;
      dz /= len;
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
      cropMin = [...feature.cropMin] as [number, number, number];
      cropMax = [...feature.cropMax] as [number, number, number];
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

  const section = (id: PanelId, title: string, body: string): string =>
    `<details class="whud__section" data-section="${id}" ${openSections.has(id) ? "open" : ""}>` +
    `<summary>${title}</summary>` +
    `<div class="whud__section-body">${body}</div>` +
    `</details>`;

  const segBtn = (attr: string, val: string, label: string, active: boolean, disabled = false): string =>
    `<button type="button" ${attr}="${val}" class="whud__seg-btn${active ? " whud__seg-btn--active" : ""}"${
      disabled ? " disabled" : ""
    }>${label}</button>`;

  const slider = (
    id: string,
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
  ): string =>
    `<label class="whud__slider">` +
    `<span>${label}</span>` +
    `<input data-slider="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${value}"/>` +
    `<span data-val="${id}" class="whud__value">${fmt(value)}</span></label>`;

  function fmt(v: number): string {
    return Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
  }

  const colorRow = (id: string, label: string, value: string): string =>
    `<label class="whud__row" style="font-size:11px;align-items:center;gap:8px">${label} ` +
    `<input type="color" data-color="${id}" value="${value}" style="width:32px;height:20px;padding:0;border:none;background:none;cursor:pointer"/></label>`;

  // Dual-thumb [lo, hi] range slider. `group` scopes the pair (e.g. "color", "cropX") so one delegated
  // input handler drives every range: two overlaid range inputs, a visual track/fill, and a value label.
  const rangeSlider = (
    group: string,
    label: string,
    lo: number,
    hi: number,
    step = 0.005,
  ): string =>
    `<div class="whud__range" data-range-group="${group}">` +
    `<div class="whud__range-track"><div class="whud__range-fill" data-range-fill style="left:${lo * 100}%;width:${(hi - lo) * 100}%"></div></div>` +
    `<input class="whud__range-input" type="range" min="0" max="1" step="${step}" value="${lo}" data-range="${group}:lo" aria-label="${label} low"/>` +
    `<input class="whud__range-input" type="range" min="0" max="1" step="${step}" value="${hi}" data-range="${group}:hi" aria-label="${label} high"/>` +
    `</div>` +
    `<div class="whud__range-labels"><span>${label}</span><span data-range-vals>${fmt(lo)} – ${fmt(hi)}</span></div>`;

  const renderUi = (): void => {
    curveEditor?.dispose();
    curveEditor = undefined;

    const [dx, dy, dz] = source.dimensionsAt(level);
    const unit = lengthUnit();
    const [qx, qy, qz] = physicalSizeQuantities(source, level);
    const vx = new units.Quantity(source.spacingAt(level)[0]!, units.LENGTH).to(unit);

    const lodBtns = levels
      .map((lv) => {
        const [lx, ly, lz] = source.dimensionsAt(lv);
        return segBtn("data-level", String(lv), `L${lv} ${lx}×${ly}×${lz}`, lv === level, loading);
      })
      .join("");

    const blocked: string[] = [];
    for (let lv = 0; lv < source.levelCount; lv++) {
      if (levels.includes(lv)) continue;
      const [lx, ly, lz] = source.dimensionsAt(lv);
      if (lx > maxTex || ly > maxTex || lz > maxTex) {
        blocked.push(`L${lv} needs ${Math.max(lx, ly, lz)}³ (GPU max ${maxTex})`);
      }
    }

    // Data section
    const dataBody = [
      `<div class="whud__hint">Resolution (GPU max ${maxTex}³)</div>`,
      `<div class="whud__seg">${lodBtns}</div>`,
      `<div class="whud__hint">voxel ${vx.toFixed(3)} ${unit.symbol} · ${qx.to(unit).toFixed(0)}×${qy.to(unit).toFixed(0)}×${qz.to(unit).toFixed(0)} ${unit.symbol}</div>`,
      blocked.length ? `<div class="whud__hint">${blocked.join(" · ")}</div>` : "",
    ].join("");

    // TF section
    const maps = colorMapNames()
      .map((m) => `<option value="${m}" ${m === colorMap ? "selected" : ""}>${m}</option>`)
      .join("");
    const tfBody = [
      `<label class="whud__row" style="font-size:11px">Colormap <select id="cmap" class="whud__select">${maps}</select></label>`,
      slider("opacityScale", "Opacity ×", opacityScale, 0.05, 2, 0.01),
      `<div class="whud__hint">Opacity curve (drag · dbl-click add) · volume histogram behind</div>`,
      `<canvas id="opacity-curve" style="width:100%;height:84px;display:block;touch-action:none;cursor:crosshair"></canvas>`,
      // Dual-thumb color-range slider under the graph — both heads set [colorLo, colorHi] together.
      rangeSlider("color", "Color range", colorLo, colorHi, 0.005),
    ].join("");

    // Render section
    const blends: VolumeBlendMode[] = ["composite", "mip", "minip", "average"];
    const blendBtns = blends
      .map((b) => segBtn("data-blend", b, b, blendMode === b))
      .join("");
    const renderBody = [
      `<div class="whud__seg">${blendBtns}</div>`,
      slider("sampleDist", "Sample dist", sampleDist, 0.35, 3, 0.05),
      slider("density", "Density", densityScale, 0.2, 4, 0.05),
      slider("exposure", "Exposure", exposure, 0.2, 4, 0.05),
      slider("gradOp", "Grad opacity", gradOpacity, 0, 1, 0.01),
      slider("gradScale", "Grad scale", gradScale, 0.02, 0.5, 0.01),
      slider("lighting", "Lighting", lighting, 0, 1, 0.01),
    ].join("");

    // Slices section
    const modes: [VolumeViewMode, string][] = [
      ["volume", "3D"],
      ["xPlane", "X (sagittal)"],
      ["yPlane", "Y (coronal)"],
      ["zPlane", "Z (axial)"],
    ];
    const modeBtns = modes
      .map(([m, lab]) => segBtn("data-view", m, lab, viewMode === m))
      .join("");
    const active = activeSlice();
    const [nx, ny, nz] = source.dimensionsAt(level);
    let primary = "";
    if (active) {
      const n = active.axis === "x" ? nx : active.axis === "y" ? ny : nz;
      const idx = Math.min(n - 1, Math.floor(active.value * n));
      primary = [
        `<div style="font-size:12px;margin:8px 0 4px;font-weight:600">Slice along ${active.axis.toUpperCase()}</div>`,
        `<div class="whud__hint" data-slice-info>${sliceWorldLabel(active.axis, active.value)} · index ${idx}/${n - 1}</div>`,
        slider("activeSlice", "Position", active.value, 0, 1, 1 / Math.max(n, 2)),
        `<div class="whud__hint">Scroll wheel = scrub slice · Ctrl+wheel = zoom · middle/Alt-drag = pan · F = reframe</div>`,
      ].join("");
    } else {
      primary = `<div class="whud__hint">Pick an axis view, then scrub with the slider or mouse wheel.</div>`;
    }
    const slicesBody = [
      `<div class="whud__seg">${modeBtns}</div>`,
      primary,
      `<details style="margin-top:8px"><summary style="cursor:pointer;color:var(--whud-muted);font-size:11px">Overlays &amp; all axes</summary>`,
      `<label class="whud__check"><input type="checkbox" data-chk="showPlanes" ${showPlanes ? "checked" : ""}/> Show plane overlays in 3D</label>`,
      `<div class="whud__row">`,
      `<label class="whud__check"><input type="checkbox" data-chk="enX" ${enX ? "checked" : ""}/> X</label>`,
      `<label class="whud__check"><input type="checkbox" data-chk="enY" ${enY ? "checked" : ""}/> Y</label>`,
      `<label class="whud__check"><input type="checkbox" data-chk="enZ" ${enZ ? "checked" : ""}/> Z</label>`,
      `</div>`,
      slider("sliceX", "X", sliceX, 0, 1, 0.005),
      slider("sliceY", "Y", sliceY, 0, 1, 0.005),
      slider("sliceZ", "Z", sliceZ, 0, 1, 0.005),
      `<button type="button" data-act="frameSlice" class="whud__seg-btn" style="margin-top:6px">Reframe to slice</button>`,
      `</details>`,
    ].join("");

    // Crop section — one dual-thumb [min, max] slider per axis (ROI in UVW 0–1).
    const cropBody = [
      `<div class="whud__hint">ROI crop (UVW 0–1)</div>`,
      rangeSlider("cropX", "X", cropMin[0], cropMax[0], 0.01),
      rangeSlider("cropY", "Y", cropMin[1], cropMax[1], 0.01),
      rangeSlider("cropZ", "Z", cropMin[2], cropMax[2], 0.01),
      `<button type="button" data-act="resetCrop" class="whud__seg-btn" style="margin-top:6px">Reset crop</button>`,
    ].join("");

    // Measure section
    const u3 = um3();
    const detail = lastPick
      ? [
          `<div style="margin-top:8px;font-size:11px;line-height:1.45">`,
          `<div>Seed voxel <b>${lastPick.seedVoxel.join(", ")}</b> · density ${lastPick.seedDensity.toFixed(2)}</div>`,
          `<div>Threshold ≥ <b>${lastPick.threshold.toFixed(2)}</b> · <b>${lastPick.voxelCount.toLocaleString()}</b> voxels</div>`,
          `<div>Volume <b>${lastPick.volume.to(u3).toExponential(3)}</b> ${u3.symbol}</div>`,
          `<div style="color:var(--whud-muted)">${lastPick.volume.to(units.milliliter).toExponential(3)} mL · mean ${lastPick.meanDensity.toFixed(2)}</div>`,
          `</div>`,
        ].join("")
      : "";
    const measureBody = [
      `<div class="whud__hint">Click a structure to grow a connected component and measure its physical volume (current LOD).</div>`,
      `<label class="whud__check"><input type="checkbox" data-chk="pickMode" ${pickMode ? "checked" : ""}/> Pick mode (or Ctrl+click)</label>`,
      `<div class="whud__row"><button type="button" data-act="clearPick" class="whud__seg-btn">Clear selection</button></div>`,
      pickStatus ? `<div style="margin-top:8px;font-size:11px">${pickStatus}</div>` : "",
      detail,
      `<div class="whud__hint">Uses ray pick through the volume + 6-connected flood fill. Crop snaps to the feature. Prefer L2+ for speed on huge volumes.</div>`,
    ].join("");

    // Post FX section — tonemap (always on) + toggle-gated bloom / FXAA / sharpen / vignette.
    const tmOps: ToneMapOperator[] = ["aces", "reinhard", "reinhard-extended"];
    const tmOptions = tmOps
      .map((o) => `<option value="${o}" ${o === fxOperator ? "selected" : ""}>${o}</option>`)
      .join("");
    const postfxBody = [
      `<label class="whud__row" style="font-size:11px">Tonemap <select id="fxop" class="whud__select">${tmOptions}</select></label>`,
      slider("fxExposure", "Exposure (stops)", fxExposure, -4, 4, 0.05),
      `<label class="whud__check"><input type="checkbox" data-chk="fxBloom" ${fxBloom ? "checked" : ""}/> Bloom</label>`,
      slider("fxBloomThreshold", "Bloom threshold", fxBloomThreshold, 0, 3, 0.05),
      slider("fxBloomIntensity", "Bloom intensity", fxBloomIntensity, 0, 2, 0.05),
      `<label class="whud__check"><input type="checkbox" data-chk="fxFxaa" ${fxFxaa ? "checked" : ""}/> FXAA (anti-alias edges)</label>`,
      `<label class="whud__check"><input type="checkbox" data-chk="fxSharpen" ${fxSharpen ? "checked" : ""}/> Sharpen</label>`,
      slider("fxSharpenAmount", "Sharpen amount", fxSharpenAmount, 0, 2, 0.05),
      `<label class="whud__check"><input type="checkbox" data-chk="fxVignette" ${fxVignette ? "checked" : ""}/> Vignette</label>`,
      slider("fxVignetteAmount", "Vignette amount", fxVignetteAmount, 0, 1, 0.02),
    ].join("");

    // Lighting section — three modes (global / camera flashlight / 4-corner stage) each with color +
    // intensity, shared shading params, volumetric shadows, ambient occlusion, and a half-res lever.
    const lightingBody = [
      `<label class="whud__check"><input type="checkbox" data-chk="lightGlobalOn" ${lightGlobalOn ? "checked" : ""}/> Global directional</label>`,
      colorRow("lightGlobalColor", "Color", lightGlobalColor),
      slider("lightGlobalIntensity", "Intensity", lightGlobalIntensity, 0, 4, 0.05),
      slider("lightAzimuth", "Azimuth°", lightAzimuth, 0, 360, 1),
      slider("lightElevation", "Elevation°", lightElevation, -90, 90, 1),
      `<label class="whud__check" style="margin-top:6px"><input type="checkbox" data-chk="lightFlashOn" ${lightFlashOn ? "checked" : ""}/> Camera flashlight</label>`,
      colorRow("lightFlashColor", "Color", lightFlashColor),
      slider("lightFlashIntensity", "Intensity", lightFlashIntensity, 0, 4, 0.05),
      `<label class="whud__check" style="margin-top:6px"><input type="checkbox" data-chk="lightStageOn" ${lightStageOn ? "checked" : ""}/> Stage lights (4 corners)</label>`,
      colorRow("lightStageColor", "Color", lightStageColor),
      slider("lightStageIntensity", "Intensity", lightStageIntensity, 0, 4, 0.05),
      `<div class="whud__hint" style="margin-top:6px">Shading</div>`,
      slider("lightAmbient", "Ambient", lightAmbient, 0, 1, 0.01),
      slider("lightSpecular", "Specular", lightSpecular, 0, 2, 0.05),
      slider("lightRoughness", "Roughness", lightRoughness, 0, 1, 0.02),
      `<label class="whud__check" style="margin-top:6px"><input type="checkbox" data-chk="shadowOn" ${shadowOn ? "checked" : ""}/> Shadows</label>`,
      slider("shadowQuality", "Shadow steps", shadowQuality, 4, 64, 1),
      slider("shadowStrength", "Shadow strength", shadowStrength, 0, 1, 0.02),
      `<label class="whud__check" style="margin-top:6px"><input type="checkbox" data-chk="aoOn" ${aoOn ? "checked" : ""}/> Ambient occlusion</label>`,
      slider("aoRadius", "AO radius", aoRadius, 0.01, 0.3, 0.01),
      slider("aoIntensity", "AO intensity", aoIntensity, 0, 1, 0.02),
      `<label class="whud__check" style="margin-top:6px"><input type="checkbox" data-chk="halfRes" ${halfRes ? "checked" : ""}/> Half resolution</label>`,
      `<div class="whud__hint">Shadows + AO cast secondary rays per sample. Enable half-res on large volumes to keep it interactive.</div>`,
    ].join("");

    ui.innerHTML = [
      `<div class="whud__header">` +
        `<span class="whud__title">OME-Zarr viewer</span>` +
        `<button type="button" class="whud__collapse-btn" data-act="toggleCollapse" ` +
        `title="${collapsed ? "Expand panel" : "Collapse panel"}" ` +
        `aria-label="${collapsed ? "Expand panel" : "Collapse panel"}">${collapsed ? "\u2039" : "\u203A"}</button>` +
        `</div>`,
      `<div class="whud__status">L${level} · ${dx}×${dy}×${dz}${loading ? " · loading…" : ""}${pickMode ? " · PICK" : ""}</div>`,
      section("data", "Data", dataBody),
      section("tf", "Transfer Function", tfBody),
      section("render", "Render", renderBody),
      section("lighting", "Lighting", lightingBody),
      section("slices", "Slices", slicesBody),
      section("crop", "Crop", cropBody),
      section("measure", "Measure", measureBody),
      section("postfx", "Post FX", postfxBody),
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
        curveEditor = new OpacityCurveEditor(c, opacityPoints, {
          colorMap,
          colorRange: [colorLo, colorHi],
          onChange: (pts) => {
            opacityPoints = pts.map((p) => [p[0], p[1]] as const);
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
      blendMode = btn.dataset.blend as VolumeBlendMode;
      applyRender();
      renderUi();
      emitRendering();
      return;
    }
    if (btn.dataset.view) {
      enterViewMode(btn.dataset.view as VolumeViewMode, true);
      openSections.add("slices");
      renderUi();
      // View mode carries both a render mode and slice enables/overlays.
      emitRendering();
      emitCropping();
      return;
    }
    if (btn.dataset.act === "resetCrop") {
      cropMin = [0, 0, 0];
      cropMax = [1, 1, 1];
      applyRender();
      renderUi();
      emitCropping();
      return;
    }
    if (btn.dataset.act === "frameSlice") {
      frameSliceCamera();
      return;
    }
    if (btn.dataset.act === "clearPick") {
      lastPick = undefined;
      pickStatus = "";
      cropMin = [0, 0, 0];
      cropMax = [1, 1, 1];
      applyRender();
      renderUi();
      emitCropping();
    }
  });

  ui.addEventListener("change", (e) => {
    const t = e.target as HTMLSelectElement;
    if (t.id === "cmap") {
      colorMap = t.value as ColorMapName;
      applyTf();
      curveEditor?.setColorMap(colorMap);
      emitRendering();
    } else if (t.id === "fxop") {
      fxOperator = t.value as ToneMapOperator;
      rebuildFxStack();
      emitRendering();
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
    "aoRadius",
    "aoIntensity",
  ]);

  ui.addEventListener("input", (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset.chk) {
      const on = t.checked;
      if (t.dataset.chk === "showPlanes") showPlanes = on;
      if (t.dataset.chk === "enX") enX = on;
      if (t.dataset.chk === "enY") enY = on;
      if (t.dataset.chk === "enZ") enZ = on;
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
        if (t.dataset.chk === "fxBloom") fxBloom = on;
        else if (t.dataset.chk === "fxFxaa") fxFxaa = on;
        else if (t.dataset.chk === "fxSharpen") fxSharpen = on;
        else if (t.dataset.chk === "fxVignette") fxVignette = on;
        rebuildFxStack();
        emitRendering();
        return;
      }
      if (
        t.dataset.chk === "lightGlobalOn" ||
        t.dataset.chk === "lightFlashOn" ||
        t.dataset.chk === "lightStageOn" ||
        t.dataset.chk === "shadowOn" ||
        t.dataset.chk === "aoOn" ||
        t.dataset.chk === "halfRes"
      ) {
        if (t.dataset.chk === "lightGlobalOn") lightGlobalOn = on;
        else if (t.dataset.chk === "lightFlashOn") lightFlashOn = on;
        else if (t.dataset.chk === "lightStageOn") lightStageOn = on;
        else if (t.dataset.chk === "shadowOn") shadowOn = on;
        else if (t.dataset.chk === "aoOn") aoOn = on;
        else if (t.dataset.chk === "halfRes") halfRes = on;
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
      if (cid === "lightGlobalColor") lightGlobalColor = t.value;
      else if (cid === "lightFlashColor") lightFlashColor = t.value;
      else if (cid === "lightStageColor") lightStageColor = t.value;
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
        colorLo = lo;
        colorHi = hi;
        applyTf();
        curveEditor?.setColorRange([colorLo, colorHi]);
        emitRendering();
      } else if (group === "cropX" || group === "cropY" || group === "cropZ") {
        const axis = group === "cropX" ? 0 : group === "cropY" ? 1 : 2;
        cropMin[axis] = lo;
        cropMax[axis] = hi;
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
        opacityScale = v;
        applyTf();
        break;
      case "sampleDist":
        sampleDist = v;
        applyRender();
        break;
      case "density":
        densityScale = v;
        applyRender();
        break;
      case "exposure":
        exposure = v;
        applyRender();
        break;
      case "gradOp":
        gradOpacity = v;
        applyRender();
        break;
      case "gradScale":
        gradScale = v;
        applyRender();
        break;
      case "lighting":
        lighting = v;
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
        sliceX = v;
        applyRender();
        break;
      case "sliceY":
        sliceY = v;
        applyRender();
        break;
      case "sliceZ":
        sliceZ = v;
        applyRender();
        break;
      case "fxExposure":
        fxExposure = v;
        rebuildFxStack();
        break;
      case "fxBloomThreshold":
        fxBloomThreshold = v;
        rebuildFxStack();
        break;
      case "fxBloomIntensity":
        fxBloomIntensity = v;
        rebuildFxStack();
        break;
      case "fxSharpenAmount":
        fxSharpenAmount = v;
        rebuildFxStack();
        break;
      case "fxVignetteAmount":
        fxVignetteAmount = v;
        rebuildFxStack();
        break;
      case "lightGlobalIntensity":
        lightGlobalIntensity = v;
        break;
      case "lightAzimuth":
        lightAzimuth = v;
        break;
      case "lightElevation":
        lightElevation = v;
        break;
      case "lightFlashIntensity":
        lightFlashIntensity = v;
        break;
      case "lightStageIntensity":
        lightStageIntensity = v;
        break;
      case "lightAmbient":
        lightAmbient = v;
        applyLighting();
        break;
      case "lightSpecular":
        lightSpecular = v;
        applyLighting();
        break;
      case "lightRoughness":
        lightRoughness = v;
        applyLighting();
        break;
      case "shadowQuality":
        shadowQuality = v;
        applyLighting();
        break;
      case "shadowStrength":
        shadowStrength = v;
        applyLighting();
        break;
      case "aoRadius":
        aoRadius = v;
        applyLighting();
        break;
      case "aoIntensity":
        aoIntensity = v;
        applyLighting();
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
    if (viewMode === "volume" || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    const n =
      viewMode === "xPlane"
        ? source.dimensionsAt(level)[0]!
        : viewMode === "yPlane"
          ? source.dimensionsAt(level)[1]!
          : source.dimensionsAt(level)[2]!;
    const step = 1 / Math.max(n, 2);
    const dir = e.deltaY > 0 ? 1 : -1;
    setActiveSlice((activeSlice()?.value ?? 0.5) + dir * step);
    if (openSections.has("slices")) renderUi();
  };
  canvas.addEventListener("wheel", onSliceWheel, { passive: false });
  session.onDispose(() => canvas.removeEventListener("wheel", onSliceWheel));

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
        enterViewMode("xPlane", true);
        openSections.add("slices");
        renderUi();
        emitRendering();
        emitCropping();
      } else if (e.code === "Digit2") {
        enterViewMode("yPlane", true);
        openSections.add("slices");
        renderUi();
        emitRendering();
        emitCropping();
      } else if (e.code === "Digit3") {
        enterViewMode("zPlane", true);
        openSections.add("slices");
        renderUi();
        emitRendering();
        emitCropping();
      } else if (e.code === "Digit4") {
        enterViewMode("volume", true);
        openSections.add("slices");
        renderUi();
        emitRendering();
        emitCropping();
      } else if (e.code === "KeyF") {
        frameSliceCamera();
      } else if (e.code === "KeyP") {
        pickMode = !pickMode;
        canvas.style.cursor = pickMode ? "crosshair" : "";
        openSections.add("measure");
        renderUi();
      } else if (e.code === "KeyS") {
        showPlanes = !showPlanes;
        if (showPlanes) {
          enX = enY = enZ = true;
        }
        applyRender();
        renderUi();
        emitCropping();
      } else if (e.code === "KeyR") {
        enterViewMode("volume", true);
        emitRendering();
        emitCropping();
      } else if (e.code === "KeyO") {
        const next = await pickZarrStore();
        if (!next) return;
        store = next;
        source = await openOmeZarr(store, { skipRangeEstimate: true, valueRange });
        levels = allowedLevels();
        lastPick = undefined;
        pickStatus = "";
        loaderOpened = false; // new dataset → reopen the loader (drops old resident textures)
        if (levels.length) applyLevel(finestTargetLevel(), true);
      } else if (e.code === "KeyE") {
        cropMin = [0, 0, 0];
        cropMax = [1, 1, 1];
        lastPick = undefined;
        pickStatus = "";
        applyRender();
        renderUi();
        emitCropping();
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
    controls.update(dt);
    // Announce orbit/pan/zoom to linked panes. Poll (rather than hook into the controls' input) so
    // we also catch damped motion; guarded by the listener count so it's free when nothing's linked.
    if (viewerListeners.cameraChange.size > 0) {
      const cur = controls.getState();
      if (!camsEqual(cur, lastCam)) {
        lastCam = cur;
        emit("cameraChange");
      }
    }
    const extent = Math.max(sizeSim.x, sizeSim.y, sizeSim.z) || 1;
    // Near/far bracket the volume CENTER's depth ALONG THE VIEW AXIS (the box is centered at the world
    // origin), plus the bounding-sphere radius. We project the center onto the actual view direction
    // rather than use the straight-line eye→origin distance: under zoom-to-cursor the orbit target
    // drifts off the origin, so the camera's forward stops pointing at the box center. Using the
    // straight-line distance then overestimates the center's depth, pushing the near plane in front of
    // the box and clipping its front — which read as the volume "inverting" when zoomed far out.
    // Projecting onto the view axis brackets the box correctly at any zoom/drift and keeps the near/far
    // ratio bounded so the inv(viewProj) DVR ray reconstruction stays float32-stable.
    const boundR = 0.5 * Math.hypot(sizeSim.x, sizeSim.y, sizeSim.z) || extent * 0.5;
    const wm = camera.worldMatrix().elements;
    // Camera looks down its local -Z; world forward = -(worldZ axis) = -(column 2).
    let fx = -wm[8]!;
    let fy = -wm[9]!;
    let fz = -wm[10]!;
    const flen = Math.hypot(fx, fy, fz) || 1;
    fx /= flen;
    fy /= flen;
    fz /= flen;
    const centerDepth = -(camera.position.x * fx + camera.position.y * fy + camera.position.z * fz);
    const margin = boundR * 1.5 + extent * 0.05;
    const far = Math.max(centerDepth + margin, margin * 2);
    // Clamp near above a small fraction of far so the ratio stays float32-friendly even when the eye is
    // inside (or very close to) the volume; never let it collapse to ~0.
    const near = Math.max(centerDepth - margin, far * 0.002);
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
    const rL = Math.hypot(wm[0]!, wm[1]!, wm[2]!) || 1;
    const uL = Math.hypot(wm[4]!, wm[5]!, wm[6]!) || 1;
    volumeRenderer.setLights(
      buildFrameLights(
        camera.position,
        [wm[0]! / rL, wm[1]! / rL, wm[2]! / rL],
        [wm[4]! / uL, wm[5]! / uL, wm[6]! / uL],
        [fx, fy, fz],
        extent,
      ),
    );
    // Volume → linear HDR, then the post stack to the swapchain (one encoder / one submit). The DOM
    // overlay (gizmo + scale bar) draws to a separate canvas and is unaffected.
    fxPipeline.render({ r: 0.015, g: 0.02, b: 0.035, a: 1 }, (pass) => {
      volumeRenderer.recordInto(pass, viewProj, camera.position);
    });

    // Bottom-left overlay: axis gizmo (camera world basis) + physical scale bar. The gizmo uses the
    // world right/up/forward columns of the camera; forward (fx,fy,fz) is already unit-normalized above.
    const rlen = Math.hypot(wm[0]!, wm[1]!, wm[2]!) || 1;
    const ulen = Math.hypot(wm[4]!, wm[5]!, wm[6]!) || 1;
    // Scale bar: world (sim µm) per CSS pixel at the orbit-target depth (perspective → exact at target).
    let scaleBar: { px: number; label: string } | null = null;
    const cssH = canvas.clientHeight;
    if (cssH > 0 && Number.isFinite(controls.distance) && controls.distance > 0) {
      const worldPerPx = (2 * controls.distance * Math.tan(controls.fovY / 2)) / cssH;
      const targetPx = 100;
      const u = lengthUnit();
      const rawVal = units.fromSim(targetPx * worldPerPx, units.LENGTH, sim).to(u);
      if (Number.isFinite(rawVal) && rawVal > 0) {
        const nice = niceFloor125(rawVal);
        scaleBar = { px: (nice / rawVal) * targetPx, label: `${formatNice(nice)} ${u.symbol}` };
      }
    }
    overlay.draw({
      right: [wm[0]! / rlen, wm[1]! / rlen, wm[2]! / rlen],
      up: [wm[4]! / ulen, wm[5]! / ulen, wm[6]! / ulen],
      forward: [fx, fy, fz],
      scaleBar,
    });
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
    setRendering: (state) => {
      colorMap = state.colorMap;
      colorLo = state.colorLo;
      colorHi = state.colorHi;
      opacityScale = state.opacityScale;
      opacityPoints = state.opacityPoints.map((p) => [p[0], p[1]] as const);
      densityScale = state.densityScale;
      exposure = state.exposure;
      sampleDist = state.sampleDist;
      blendMode = state.blendMode;
      gradOpacity = state.gradOpacity;
      gradScale = state.gradScale;
      lighting = state.lighting;
      viewMode = state.viewMode;
      // FX fields are optional on the wire (older peers/links may omit them); fall back to current.
      fxOperator = state.fxOperator ?? fxOperator;
      fxExposure = state.fxExposure ?? fxExposure;
      fxBloom = state.fxBloom ?? fxBloom;
      fxBloomThreshold = state.fxBloomThreshold ?? fxBloomThreshold;
      fxBloomIntensity = state.fxBloomIntensity ?? fxBloomIntensity;
      fxFxaa = state.fxFxaa ?? fxFxaa;
      fxSharpen = state.fxSharpen ?? fxSharpen;
      fxSharpenAmount = state.fxSharpenAmount ?? fxSharpenAmount;
      fxVignette = state.fxVignette ?? fxVignette;
      fxVignetteAmount = state.fxVignetteAmount ?? fxVignetteAmount;
      // Lighting fields are optional on the wire (older peers/links may omit them); fall back.
      lightGlobalOn = state.lightGlobalOn ?? lightGlobalOn;
      lightGlobalColor = state.lightGlobalColor ?? lightGlobalColor;
      lightGlobalIntensity = state.lightGlobalIntensity ?? lightGlobalIntensity;
      lightAzimuth = state.lightAzimuth ?? lightAzimuth;
      lightElevation = state.lightElevation ?? lightElevation;
      lightFlashOn = state.lightFlashOn ?? lightFlashOn;
      lightFlashColor = state.lightFlashColor ?? lightFlashColor;
      lightFlashIntensity = state.lightFlashIntensity ?? lightFlashIntensity;
      lightStageOn = state.lightStageOn ?? lightStageOn;
      lightStageColor = state.lightStageColor ?? lightStageColor;
      lightStageIntensity = state.lightStageIntensity ?? lightStageIntensity;
      lightAmbient = state.lightAmbient ?? lightAmbient;
      lightSpecular = state.lightSpecular ?? lightSpecular;
      lightRoughness = state.lightRoughness ?? lightRoughness;
      shadowOn = state.shadowOn ?? shadowOn;
      shadowQuality = state.shadowQuality ?? shadowQuality;
      shadowStrength = state.shadowStrength ?? shadowStrength;
      aoOn = state.aoOn ?? aoOn;
      aoRadius = state.aoRadius ?? aoRadius;
      aoIntensity = state.aoIntensity ?? aoIntensity;
      halfRes = state.halfRes ?? halfRes;
      applyTf();
      applyRender();
      rebuildFxStack();
      applyLighting();
      renderUi();
    },
    getCropping: readCropping,
    setCropping: (state) => {
      cropMin = [state.cropMin[0], state.cropMin[1], state.cropMin[2]];
      cropMax = [state.cropMax[0], state.cropMax[1], state.cropMax[2]];
      sliceX = state.sliceX;
      sliceY = state.sliceY;
      sliceZ = state.sliceZ;
      enX = state.enX;
      enY = state.enY;
      enZ = state.enZ;
      showPlanes = state.showPlanes;
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
