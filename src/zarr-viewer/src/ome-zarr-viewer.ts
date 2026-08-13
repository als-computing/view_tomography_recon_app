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
  uploadVolume,
  VolumeRenderer,
  composeTransferFunction,
  OpacityCurveEditor,
  DEFAULT_OPACITY_POINTS,
  colorMapNames,
  type ColorMapName,
  type OpacityPoint,
  type VolumeBlendMode,
  type VolumeViewMode,
} from "@zarr-viewer/render";
import { Scene, Node } from "@zarr-viewer/scene";
import { OrbitControls } from "@zarr-viewer/controls";
import { Mat4, Vec3 } from "@zarr-viewer/math";
import {
  createDemoSession,
  createDemoHud,
  type DemoHandle,
  resizeDemoCanvas,
} from "./demo-session.js";

const DEFAULT_ZARR = "/datasets/petiole.zarr";

type PanelId = "data" | "tf" | "render" | "slices" | "crop" | "measure";

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
  options?: { zarrUrl?: string },
): Promise<DemoHandle> {
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
  let sliceX = 0.5;
  let sliceY = 0.5;
  let sliceZ = 0.5;
  let enX = false;
  let enY = false;
  let enZ = false;
  let showPlanes = false;
  let cropMin: [number, number, number] = [0, 0, 0];
  let cropMax: [number, number, number] = [1, 1, 1];
  let panel: PanelId = "tf";
  let loading = false;
  let baseStep = 1 / 220;
  let pickMode = false;
  let measuring = false;
  let lastPick: PickedFeature | undefined;
  let pickStatus = "";
  const invViewProj = new Mat4();
  const lastViewProj = new Mat4();

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
    return session.handle();
  }

  const allowedLevels = (): number[] =>
    listUploadableLevels(source, { maxTextureDimension: maxTex });

  let levels = allowedLevels();
  if (levels.length === 0) {
    const hud = createDemoHud({ position: "bottom-left" });
    session.mountHud(hud);
    hud.textContent = `No uploadable LOD (GPU max 3D texture ${maxTex}).`;
    return session.handle();
  }
  let level = levels[levels.length - 1]!;

  const volumeRenderer = new VolumeRenderer(ctx, {
    stepSize: baseStep,
    densityScale,
    maxSteps: 720,
    exposure,
    ambient: 0.22,
    clearColor: [0.015, 0.02, 0.035, 1],
    blendMode,
    gradientOpacity: gradOpacity,
    gradientOpacityScale: gradScale,
    lightingStrength: lighting,
  });

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

  const sim = units.UNIT_PRESETS.microscopy;
  const sizeSim = new Vec3();
  let volumeTex: Awaited<ReturnType<typeof uploadVolume>> | undefined;
  let curveEditor: OpacityCurveEditor | undefined;

  const ui = createDemoHud({ position: "bottom-left", pointerEvents: true });
  ui.style.maxWidth = "min(420px, 96%)";
  ui.style.maxHeight = "min(78vh, 720px)";
  ui.style.overflow = "auto";
  ui.style.whiteSpace = "normal";
  session.mountHud(ui);
  session.onDispose(() => curveEditor?.dispose());

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

  const applyLevel = async (next: number, reframe = false): Promise<void> => {
    if (!levels.includes(next) || loading) return;
    loading = true;
    lastPick = undefined;
    pickStatus = "";
    renderUi();
    try {
      level = next;
      volumeTex?.dispose();
      volumeTex = await uploadVolume(ctx.device, source, { level });
      volumeRenderer.setVolume(volumeTex);
      physicalSizeSim(sizeSim, source, sim, level);
      volumeRenderer.setBoxHalfSize(sizeSim.x * 0.5, sizeSim.y * 0.5, sizeSim.z * 0.5);
      const extent = Math.max(sizeSim.x, sizeSim.y, sizeSim.z);
      controls.minDistance = Math.max(extent * 0.02, 0.05);
      controls.maxDistance = extent * 80;
      const [sx, sy, sz] = source.spacingAt(level);
      baseStep = Math.max(
        Math.max(
          units.toSim(new units.Quantity(sx, units.LENGTH), sim),
          units.toSim(new units.Quantity(sy, units.LENGTH), sim),
          units.toSim(new units.Quantity(sz, units.LENGTH), sim),
        ) * 0.55,
        extent / 400,
      );
      if (reframe) {
        if (viewMode === "volume") {
          controls.distance = extent * 2.2;
          camera.position.set(extent * 1.2, extent * 0.85, extent * 1.2);
          controls.syncFromNode();
          controls.update(0);
        } else {
          frameSliceCamera();
        }
      }
      applyRender();
    } finally {
      loading = false;
      renderUi();
    }
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
      panel = "measure";
    } catch (err) {
      lastPick = undefined;
      pickStatus = err instanceof Error ? err.message : String(err);
    } finally {
      measuring = false;
      renderUi();
    }
  };

  const tabBtn = (id: PanelId, label: string): string =>
    `<button type="button" data-panel="${id}" style="cursor:pointer;padding:3px 7px;${
      panel === id ? "outline:1px solid #8cf;background:#243048;" : ""
    }">${label}</button>`;

  const slider = (
    id: string,
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
  ): string =>
    `<label style="display:grid;grid-template-columns:92px 1fr 44px;gap:5px;align-items:center;margin:3px 0;font-size:11px">` +
    `<span style="opacity:0.8">${label}</span>` +
    `<input data-slider="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${value}" style="width:100%"/>` +
    `<span data-val="${id}" style="text-align:right;font-variant-numeric:tabular-nums">${fmt(value)}</span></label>`;

  function fmt(v: number): string {
    return Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
  }

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
        return `<button type="button" data-level="${lv}" style="cursor:pointer;${
          lv === level ? "outline:1px solid #8cf;background:#243048;" : ""
        }" ${loading ? "disabled" : ""}>L${lv} ${lx}×${ly}×${lz}</button>`;
      })
      .join("");

    let body = "";
    if (panel === "data") {
      body = [
        `<div style="font-size:11px;opacity:0.7;margin:4px 0">Resolution (GPU max ${maxTex}³)</div>`,
        `<div style="display:flex;flex-wrap:wrap;gap:4px">${lodBtns}</div>`,
        `<div style="opacity:0.75;margin-top:8px;font-size:11px">voxel ${vx.toFixed(3)} ${unit.symbol} · ${qx.to(unit).toFixed(0)}×${qy.to(unit).toFixed(0)}×${qz.to(unit).toFixed(0)} ${unit.symbol}</div>`,
      ].join("");
    } else if (panel === "tf") {
      const maps = colorMapNames()
        .map(
          (m) =>
            `<option value="${m}" ${m === colorMap ? "selected" : ""}>${m}</option>`,
        )
        .join("");
      body = [
        `<label style="font-size:11px;display:flex;gap:8px;align-items:center;margin:4px 0">Colormap <select id="cmap" style="flex:1">${maps}</select></label>`,
        slider("colorLo", "Color low", colorLo, 0, 1, 0.01),
        slider("colorHi", "Color high", colorHi, 0, 1, 0.01),
        slider("opacityScale", "Opacity ×", opacityScale, 0.05, 2, 0.01),
        `<div style="font-size:11px;opacity:0.7;margin:6px 0 2px">Opacity curve (drag · dbl-click add)</div>`,
        `<canvas id="opacity-curve" style="width:100%;height:72px;display:block;border-radius:4px;touch-action:none;cursor:crosshair"></canvas>`,
      ].join("");
    } else if (panel === "render") {
      const blends: VolumeBlendMode[] = ["composite", "mip", "minip", "average"];
      const blendBtns = blends
        .map(
          (b) =>
            `<button type="button" data-blend="${b}" style="cursor:pointer;${
              blendMode === b ? "outline:1px solid #8cf;background:#243048;" : ""
            }">${b}</button>`,
        )
        .join("");
      body = [
        `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px">${blendBtns}</div>`,
        slider("sampleDist", "Sample dist", sampleDist, 0.35, 3, 0.05),
        slider("density", "Density", densityScale, 0.2, 4, 0.05),
        slider("exposure", "Exposure", exposure, 0.2, 4, 0.05),
        slider("gradOp", "Grad opacity", gradOpacity, 0, 1, 0.01),
        slider("gradScale", "Grad scale", gradScale, 0.02, 0.5, 0.01),
        slider("lighting", "Lighting", lighting, 0, 1, 0.01),
      ].join("");
    } else if (panel === "slices") {
      const modes: [VolumeViewMode, string][] = [
        ["volume", "3D"],
        ["xPlane", "X (sagittal)"],
        ["yPlane", "Y (coronal)"],
        ["zPlane", "Z (axial)"],
      ];
      const modeBtns = modes
        .map(
          ([m, lab]) =>
            `<button type="button" data-view="${m}" style="cursor:pointer;padding:4px 8px;${
              viewMode === m ? "outline:1px solid #8cf;background:#243048;" : ""
            }">${lab}</button>`,
        )
        .join("");
      const active = activeSlice();
      const [nx, ny, nz] = source.dimensionsAt(level);
      let primary = "";
      if (active) {
        const n = active.axis === "x" ? nx : active.axis === "y" ? ny : nz;
        const idx = Math.min(n - 1, Math.floor(active.value * n));
        primary = [
          `<div style="font-size:12px;margin:8px 0 4px;font-weight:600">Slice along ${active.axis.toUpperCase()}</div>`,
          `<div style="font-size:11px;opacity:0.75;margin-bottom:4px">${sliceWorldLabel(active.axis, active.value)} · index ${idx}/${n - 1}</div>`,
          slider("activeSlice", "Position", active.value, 0, 1, 1 / Math.max(n, 2)),
          `<div style="font-size:10px;opacity:0.55;margin:6px 0">Scroll wheel = scrub slice · Ctrl+wheel = zoom · middle/Alt-drag = pan · F = reframe</div>`,
        ].join("");
      } else {
        primary = `<div style="font-size:11px;opacity:0.7;margin:8px 0">Pick an axis view, then scrub with the slider or mouse wheel.</div>`;
      }
      body = [
        `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:4px">${modeBtns}</div>`,
        primary,
        `<details style="margin-top:8px;font-size:11px"><summary style="cursor:pointer;opacity:0.8">Overlays &amp; all axes</summary>`,
        `<label style="display:block;margin:6px 0"><input type="checkbox" data-chk="showPlanes" ${showPlanes ? "checked" : ""}/> Show plane overlays in 3D</label>`,
        `<label style="margin-right:8px"><input type="checkbox" data-chk="enX" ${enX ? "checked" : ""}/> X</label>`,
        `<label style="margin-right:8px"><input type="checkbox" data-chk="enY" ${enY ? "checked" : ""}/> Y</label>`,
        `<label><input type="checkbox" data-chk="enZ" ${enZ ? "checked" : ""}/> Z</label>`,
        slider("sliceX", "X", sliceX, 0, 1, 0.005),
        slider("sliceY", "Y", sliceY, 0, 1, 0.005),
        slider("sliceZ", "Z", sliceZ, 0, 1, 0.005),
        `<button type="button" data-act="frameSlice" style="cursor:pointer;margin-top:6px">Reframe to slice</button>`,
        `</details>`,
      ].join("");
    } else if (panel === "crop") {
      body = [
        `<div style="font-size:11px;opacity:0.7;margin:4px 0">ROI crop (UVW 0–1)</div>`,
        slider("cminX", "Min X", cropMin[0], 0, 1, 0.01),
        slider("cminY", "Min Y", cropMin[1], 0, 1, 0.01),
        slider("cminZ", "Min Z", cropMin[2], 0, 1, 0.01),
        slider("cmaxX", "Max X", cropMax[0], 0, 1, 0.01),
        slider("cmaxY", "Max Y", cropMax[1], 0, 1, 0.01),
        slider("cmaxZ", "Max Z", cropMax[2], 0, 1, 0.01),
        `<button type="button" data-act="resetCrop" style="cursor:pointer;margin-top:6px">Reset crop</button>`,
      ].join("");
    } else {
      const u3 = um3();
      const detail = lastPick
        ? [
            `<div style="margin-top:8px;font-size:11px;line-height:1.45">`,
            `<div>Seed voxel <b>${lastPick.seedVoxel.join(", ")}</b> · density ${lastPick.seedDensity.toFixed(2)}</div>`,
            `<div>Threshold ≥ <b>${lastPick.threshold.toFixed(2)}</b> · <b>${lastPick.voxelCount.toLocaleString()}</b> voxels</div>`,
            `<div>Volume <b>${lastPick.volume.to(u3).toExponential(3)}</b> ${u3.symbol}</div>`,
            `<div style="opacity:0.75">${lastPick.volume.to(units.milliliter).toExponential(3)} mL · mean ${lastPick.meanDensity.toFixed(2)}</div>`,
            `</div>`,
          ].join("")
        : "";
      body = [
        `<div style="font-size:11px;opacity:0.8;margin:4px 0 8px">Click a structure to grow a connected component and measure its physical volume (current LOD).</div>`,
        `<label style="font-size:11px;display:flex;gap:8px;align-items:center;margin:6px 0">`,
        `<input type="checkbox" data-chk="pickMode" ${pickMode ? "checked" : ""}/> Pick mode (or Ctrl+click)`,
        `</label>`,
        `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px">`,
        `<button type="button" data-act="clearPick" style="cursor:pointer">Clear selection</button>`,
        `</div>`,
        pickStatus
          ? `<div style="margin-top:8px;font-size:11px;opacity:0.85">${pickStatus}${measuring ? "" : ""}</div>`
          : "",
        detail,
        `<div style="font-size:10px;opacity:0.5;margin-top:8px">Uses ray pick through the volume + 6-connected flood fill. Crop snaps to the feature. Prefer L2+ for speed on huge volumes.</div>`,
      ].join("");
    }

    const blocked = [];
    for (let lv = 0; lv < source.levelCount; lv++) {
      if (levels.includes(lv)) continue;
      const [lx, ly, lz] = source.dimensionsAt(lv);
      if (lx > maxTex || ly > maxTex || lz > maxTex) {
        blocked.push(`L${lv} needs ${Math.max(lx, ly, lz)}³ (GPU max ${maxTex})`);
      }
    }

    ui.innerHTML = [
      `<strong>26 · OME-Zarr viewer</strong>`,
      `<div style="opacity:0.8;margin:3px 0 6px;font-size:11px">L${level} · ${dx}×${dy}×${dz}${loading ? " · loading…" : ""}${pickMode ? " · PICK" : ""}</div>`,
      `<div style="display:flex;flex-wrap:wrap;gap:3px;margin-bottom:8px">${tabBtn("data", "Data")}${tabBtn("tf", "TF")}${tabBtn("render", "Render")}${tabBtn("slices", "Slices")}${tabBtn("crop", "Crop")}${tabBtn("measure", "Measure")}</div>`,
      body,
      blocked.length && panel === "data"
        ? `<div style="font-size:10px;opacity:0.55;margin-top:6px">${blocked.join(" · ")}</div>`
        : "",
      `<div style="opacity:0.55;margin-top:8px;font-size:10px">Pan: Space+drag / Shift / middle / right · wheel zooms to cursor · P / Ctrl+click pick · [ ] LOD · O open</div>`,
    ].join("");

    if (panel === "tf") {
      const c = ui.querySelector<HTMLCanvasElement>("#opacity-curve");
      if (c) {
        curveEditor = new OpacityCurveEditor(c, opacityPoints, {
          colorMap,
          colorRange: [colorLo, colorHi],
          onChange: (pts) => {
            opacityPoints = pts.map((p) => [p[0], p[1]] as const);
            applyTf();
          },
        });
      }
    }
  };

  ui.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button") as HTMLButtonElement | null;
    if (!btn) return;
    if (btn.dataset.panel) {
      panel = btn.dataset.panel as PanelId;
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
      return;
    }
    if (btn.dataset.view) {
      enterViewMode(btn.dataset.view as VolumeViewMode, true);
      panel = "slices";
      renderUi();
      return;
    }
    if (btn.dataset.act === "resetCrop") {
      cropMin = [0, 0, 0];
      cropMax = [1, 1, 1];
      applyRender();
      renderUi();
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
    }
  });

  ui.addEventListener("change", (e) => {
    const t = e.target as HTMLSelectElement;
    if (t.id === "cmap") {
      colorMap = t.value as ColorMapName;
      applyTf();
      curveEditor?.setColorMap(colorMap);
    }
  });

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
      applyRender();
      return;
    }
    if (!t.dataset.slider) return;
    const id = t.dataset.slider;
    const v = Number(t.value);
    const lab = ui.querySelector(`[data-val="${id}"]`);
    if (lab) lab.textContent = fmt(v);
    switch (id) {
      case "colorLo":
        colorLo = v;
        applyTf();
        break;
      case "colorHi":
        colorHi = v;
        applyTf();
        break;
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
        if (panel === "slices") {
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
            const info = ui.querySelector("div[style*='font-weight:600'] + div");
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
      case "cminX":
        cropMin[0] = v;
        applyRender();
        break;
      case "cminY":
        cropMin[1] = v;
        applyRender();
        break;
      case "cminZ":
        cropMin[2] = v;
        applyRender();
        break;
      case "cmaxX":
        cropMax[0] = v;
        applyRender();
        break;
      case "cmaxY":
        cropMax[1] = v;
        applyRender();
        break;
      case "cmaxZ":
        cropMax[2] = v;
        applyRender();
        break;
      default:
        break;
    }
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
    if (panel === "slices") renderUi();
  };
  canvas.addEventListener("wheel", onSliceWheel, { passive: false });
  session.onDispose(() => canvas.removeEventListener("wheel", onSliceWheel));

  await applyLevel(level, true);
  applyTf();
  applyRender();
  renderUi();

  session.onKeyDown((e) => {
    void (async () => {
      const idx = levels.indexOf(level);
      if (e.code === "BracketLeft" && idx < levels.length - 1) await applyLevel(levels[idx + 1]!);
      else if (e.code === "BracketRight" && idx > 0) await applyLevel(levels[idx - 1]!);
      else if (e.code === "Digit1") {
        enterViewMode("xPlane", true);
        panel = "slices";
        renderUi();
      } else if (e.code === "Digit2") {
        enterViewMode("yPlane", true);
        panel = "slices";
        renderUi();
      } else if (e.code === "Digit3") {
        enterViewMode("zPlane", true);
        panel = "slices";
        renderUi();
      } else if (e.code === "Digit4") {
        enterViewMode("volume", true);
        panel = "slices";
        renderUi();
      } else if (e.code === "KeyF") {
        frameSliceCamera();
      } else if (e.code === "KeyP") {
        pickMode = !pickMode;
        canvas.style.cursor = pickMode ? "crosshair" : "";
        panel = "measure";
        renderUi();
      } else if (e.code === "KeyS") {
        showPlanes = !showPlanes;
        if (showPlanes) {
          enX = enY = enZ = true;
        }
        applyRender();
        renderUi();
      } else if (e.code === "KeyR") {
        enterViewMode("volume", true);
      } else if (e.code === "KeyO") {
        const next = await pickZarrStore();
        if (!next) return;
        store = next;
        source = await openOmeZarr(store, { skipRangeEstimate: true, valueRange });
        levels = allowedLevels();
        lastPick = undefined;
        pickStatus = "";
        if (levels.length) await applyLevel(levels[levels.length - 1]!, true);
      } else if (e.code === "KeyE") {
        cropMin = [0, 0, 0];
        cropMax = [1, 1, 1];
        lastPick = undefined;
        pickStatus = "";
        applyRender();
        renderUi();
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

  session.loop((dt) => {
    resizeDemoCanvas(canvas);
    controls.update(dt);
    const extent = Math.max(sizeSim.x, sizeSim.y, sizeSim.z) || 1;
    // Rays are unprojected via inv(viewProj); extreme near/far ratios destroy float32 precision
    // and make DVR look broken. Tie the frustum to camera distance (closer in slice mode without
    // a pathological depth range).
    const dist = Math.max(controls.distance, extent * 0.15);
    const near = Math.max(dist * 0.02, extent * 0.002);
    const far = dist + extent * 5;
    proj.perspective(
      (42 * Math.PI) / 180,
      canvas.width / Math.max(1, canvas.height),
      near,
      far,
    );
    view.copy(camera.worldMatrix()).invert();
    viewProj.multiplyMatrices(proj, view);
    lastViewProj.copy(viewProj);
    volumeRenderer.render(viewProj, camera.position);
  });

  session.onDispose(() => {
    volumeTex?.dispose();
    volumeRenderer.dispose();
  });

  return session.handle();
}
