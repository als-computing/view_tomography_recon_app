/**
 * HUD event delegation: the three global `click`/`change`/`input` listeners on the HUD root that
 * route every control (buttons, selects, checkboxes, sliders, dual-thumb ranges) to its effect.
 * These are genuinely global — the HUD has no per-panel event binding, so this isn't split by
 * panel; every function here takes the same {@link HudEventContext}.
 *
 * @packageDocumentation
 */

import type { VolumeSource } from "@zarr-viewer/io";
import {
  stampCanvasPng,
  type ColorMapName,
  type VolumeBlendMode,
  type VolumeViewMode,
  type ShaderConfigName,
  type OpacityCurveEditor,
  type VolumeRenderer,
  type TfBandConfig,
  DEFAULT_OPACITY_POINTS,
  MAX_TF_BANDS,
} from "@zarr-viewer/render";
import type { ToneMapOperator } from "@zarr-viewer/fx";
import type { FxPipeline } from "../../render/post/fx-pipeline.js";
import type { TemporalAccumulator } from "../../render/accel/taau.js";
import { getPreset, savePreset, deletePreset } from "../../rendering-presets.js";
import type { ResidencyController } from "../volume/ResidencyController.js";
import type { PickingController } from "../interaction/PickingController.js";
import type { CropDragController } from "../interaction/CropDragController.js";
import type { WebGpuRenderingState, WebGpuCroppingState } from "../RenderingState.js";
import { autoWindow } from "../histogram.js";
import { fmt, type PanelId, type HudTab } from "./html.js";
import { hexToRgb } from "./panels/annotationsPanel.js";

export interface HudEventContext {
  ui: HTMLElement;
  canvas: HTMLCanvasElement;
  rendering: WebGpuRenderingState;
  cropping: WebGpuCroppingState;
  volumeRenderer: VolumeRenderer;
  fxPipeline: FxPipeline;
  taau: TemporalAccumulator;
  residency: ResidencyController;
  picking: PickingController;
  cropDrag: CropDragController;
  openSections: Set<PanelId>;
  getSource(): VolumeSource;
  getLevel(): number;
  getCurveEditor(): OpacityCurveEditor | undefined;
  getRawHistogram(): Float32Array | undefined;
  getHistogram(): Float32Array | undefined;
  getSelectedPreset(): string;
  setSelectedPreset(v: string): void;
  getActiveBandIndex(): number;
  setActiveBandIndex(v: number): void;
  loadMask(slot: 0 | 1, url: string): void;
  removeMask(slot: 0 | 1): void;
  setMaskClassColor(slot: 0 | 1, id: number, rgb: readonly [number, number, number]): void;
  setMaskClassOpacity(slot: 0 | 1, id: number, opacity: number): void;
  toggleMaskClassVisible(slot: 0 | 1, id: number): void;
  getCollapsed(): boolean;
  setCollapsed(v: boolean): void;
  getActiveTab(): HudTab;
  setActiveTab(v: HudTab): void;
  applyLevel(next: number): void;
  applyRender(): void;
  applyTf(): void;
  applyRenderingState(state: Partial<WebGpuRenderingState>): void;
  renderUi(): void;
  emitRendering(): void;
  emitCropping(): void;
  setViewModeAndEmit(mode: VolumeViewMode, opts?: { openSlices?: boolean; skipRenderUi?: boolean }): void;
  resetCrop(): void;
  frameSliceCamera(): void;
  recomputeEqualize(): void;
  rebuildFxStack(): void;
  applyLighting(): void;
  setActiveSlice(v: number): void;
  activeSlice(): { axis: "x" | "y" | "z"; value: number } | null;
  sliceWorldLabel(axis: "x" | "y" | "z", t: number): string;
  readRendering(): WebGpuRenderingState;
}

/** Single-value sliders that emit a `renderingChange`. */
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
// groups handled separately — they emit their own croppingChange.)
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
// Lighting sliders: set the field, push params (applyLighting), and emit for links / share.
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

/** Reads `data-mask-slot` off an element as `0 | 1`, or `undefined` if absent/invalid. */
function readMaskSlot(el: HTMLElement): 0 | 1 | undefined {
  const raw = el.dataset.maskSlot;
  return raw === "0" ? 0 : raw === "1" ? 1 : undefined;
}

export function bindHudClick(ctx: HudEventContext): void {
  ctx.ui.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button") as HTMLButtonElement | null;
    if (!btn) return;
    if (btn.dataset.act === "toggleCollapse") {
      ctx.setCollapsed(!ctx.getCollapsed());
      ctx.renderUi();
      return;
    }
    if (btn.dataset.act === "setTab" && btn.dataset.tab) {
      ctx.setActiveTab(btn.dataset.tab as HudTab);
      ctx.renderUi();
      return;
    }
    if (btn.dataset.level != null) {
      ctx.applyLevel(Number(btn.dataset.level));
      return;
    }
    if (btn.dataset.blend) {
      ctx.rendering.blendMode = btn.dataset.blend as VolumeBlendMode;
      ctx.applyRender();
      ctx.renderUi();
      ctx.emitRendering();
      return;
    }
    if (btn.dataset.shader) {
      ctx.rendering.shaderConfig = btn.dataset.shader as ShaderConfigName;
      ctx.applyRender();
      ctx.renderUi();
      ctx.emitRendering();
      return;
    }
    if (btn.dataset.tfmode) {
      // "bands": seed one band from the current single-TF look (preserves what's on screen) if none
      // exist yet. "single": bands are discarded (the flat single-TF fields take back over) — cheap
      // to redefine, so this is an acceptable v1 trade rather than keeping a separate saved copy.
      if (btn.dataset.tfmode === "bands") {
        if (!ctx.rendering.tfBands || ctx.rendering.tfBands.length === 0) {
          const seed: TfBandConfig = {
            loT: 0,
            hiT: 1,
            colorMap: ctx.rendering.colorMap,
            opacityPoints: ctx.rendering.opacityPoints.map((p) => [p[0], p[1]] as const),
            opacityScale: ctx.rendering.opacityScale,
          };
          ctx.rendering.tfBands = [seed];
        }
        ctx.setActiveBandIndex(0);
      } else {
        ctx.rendering.tfBands = undefined;
      }
      ctx.applyTf();
      ctx.renderUi();
      ctx.emitRendering();
      return;
    }
    if (btn.dataset.act === "addTfBand") {
      const bands = ctx.rendering.tfBands ?? [];
      if (bands.length >= MAX_TF_BANDS) return;
      const makeBand = (loT: number, hiT: number): TfBandConfig => ({
        loT,
        hiT,
        colorMap: "viridis",
        opacityPoints: DEFAULT_OPACITY_POINTS.map((p) => [p[0], p[1]] as const),
        opacityScale: 1,
      });
      let next: TfBandConfig[];
      if (bands.length === 0) {
        next = [makeBand(0, 1)];
      } else {
        // The domain is fully tiled by the existing bands (each Add so far has always covered up to
        // 1), so there's no "unclaimed" span to give a new band by default - split the LAST band's
        // range in half instead and give the new band the top half, keeping full coverage instead of
        // producing a near-zero-width sliver band at the very end of the domain (the bug this fixes:
        // a naive "start where the last one ended" default degenerates to [0.99, 1] once the last
        // band already reaches hiT=1, which barely renders and reads as "doesn't work").
        const last = bands[bands.length - 1]!;
        const mid = (last.loT + last.hiT) / 2;
        next = [...bands.slice(0, -1), { ...last, hiT: mid }, makeBand(mid, last.hiT)];
      }
      ctx.rendering.tfBands = next;
      ctx.setActiveBandIndex(next.length - 1);
      ctx.applyTf();
      ctx.renderUi();
      ctx.emitRendering();
      return;
    }
    if (btn.dataset.act === "removeTfBand" && btn.dataset.idx != null) {
      const bands = ctx.rendering.tfBands ?? [];
      const i = Number(btn.dataset.idx);
      const next = bands.filter((_, bi) => bi !== i);
      ctx.rendering.tfBands = next;
      ctx.setActiveBandIndex(Math.max(0, Math.min(ctx.getActiveBandIndex(), next.length - 1)));
      ctx.applyTf();
      ctx.renderUi();
      ctx.emitRendering();
      return;
    }
    if (btn.dataset.act === "selectTfBand" && btn.dataset.idx != null) {
      ctx.setActiveBandIndex(Number(btn.dataset.idx));
      ctx.renderUi();
      return;
    }
    if (btn.dataset.act === "toggleTfBand" && btn.dataset.idx != null) {
      const band = ctx.rendering.tfBands?.[Number(btn.dataset.idx)];
      if (band) {
        band.enabled = band.enabled === false ? true : false;
        ctx.applyTf();
        ctx.renderUi();
        ctx.emitRendering();
      }
      return;
    }
    if (btn.dataset.act === "exportPng") {
      void (async () => {
        const blob = await stampCanvasPng(
          ctx.canvas,
          ctx.volumeRenderer.provenance(ctx.fxPipeline.renderScale, ctx.taau.sampleCount),
        );
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `tomo-${ctx.rendering.shaderConfig}.png`;
        a.click();
        URL.revokeObjectURL(url);
      })();
      return;
    }
    if (btn.dataset.view) {
      ctx.setViewModeAndEmit(btn.dataset.view as VolumeViewMode, { openSlices: true });
      return;
    }
    if (btn.dataset.act === "resetCrop") {
      ctx.resetCrop();
      return;
    }
    if (btn.dataset.act === "frameSlice") {
      ctx.frameSliceCamera();
      return;
    }
    if (btn.dataset.act === "autoContrast") {
      // Percentile auto-window from the true distribution → color levels; refresh UI + slider thumbs.
      const rawHistogram = ctx.getRawHistogram();
      if (rawHistogram) {
        [ctx.rendering.colorLo, ctx.rendering.colorHi] = autoWindow(rawHistogram, [
          ctx.rendering.colorLo,
          ctx.rendering.colorHi,
        ]);
        ctx.applyTf();
        ctx.renderUi();
        ctx.emitRendering();
      }
      return;
    }
    if (btn.dataset.act === "applyPreset") {
      const name = ctx.ui.querySelector<HTMLSelectElement>("#presetSelect")?.value || ctx.getSelectedPreset();
      if (name) {
        const preset = getPreset(name);
        if (preset) {
          ctx.setSelectedPreset(name);
          ctx.applyRenderingState(preset as Partial<WebGpuRenderingState>);
          ctx.renderUi();
          ctx.emitRendering(); // propagate to a linked peer + refresh the auto-remembered "last used"
        }
      }
      return;
    }
    if (btn.dataset.act === "savePreset") {
      const suggested = ctx.getSelectedPreset() || "My preset";
      const name = window.prompt("Save current rendering as preset:", suggested)?.trim();
      if (name) {
        savePreset(name, ctx.readRendering() as unknown as Record<string, unknown>);
        ctx.setSelectedPreset(name);
        ctx.renderUi();
      }
      return;
    }
    if (btn.dataset.act === "deletePreset") {
      const name = ctx.ui.querySelector<HTMLSelectElement>("#presetSelect")?.value || ctx.getSelectedPreset();
      if (name && window.confirm(`Delete preset "${name}"?`)) {
        deletePreset(name);
        if (ctx.getSelectedPreset() === name) ctx.setSelectedPreset("");
        ctx.renderUi();
      }
      return;
    }
    if (btn.dataset.act === "clearPick") {
      ctx.picking.clear();
      ctx.resetCrop();
    }
    if (btn.dataset.act === "loadMask") {
      const slot = readMaskSlot(btn);
      if (slot == null) return;
      const url = ctx.ui.querySelector<HTMLInputElement>(`#maskUrlInput${slot}`)?.value.trim();
      if (url) ctx.loadMask(slot, url);
      return;
    }
    if (btn.dataset.act === "removeMask") {
      const slot = readMaskSlot(btn);
      if (slot != null) ctx.removeMask(slot);
      return;
    }
    if (btn.dataset.act === "toggleMaskClass" && btn.dataset.idx != null) {
      const slot = readMaskSlot(btn);
      if (slot != null) {
        ctx.toggleMaskClassVisible(slot, Number(btn.dataset.idx));
        ctx.renderUi(); // discrete click, not a drag - a full rebuild here is cheap and simplest
      }
      return;
    }
  });
}

export function bindHudChange(ctx: HudEventContext): void {
  ctx.ui.addEventListener("change", (e) => {
    const t = e.target as HTMLSelectElement;
    if (t.id === "cmap") {
      ctx.rendering.colorMap = t.value as ColorMapName;
      ctx.applyTf();
      ctx.getCurveEditor()?.setColorMap(ctx.rendering.colorMap);
      ctx.emitRendering();
    } else if (t.id === "fxop") {
      ctx.rendering.fxOperator = t.value as ToneMapOperator;
      ctx.rebuildFxStack();
      ctx.emitRendering();
    } else if (t.id === "presetSelect") {
      ctx.setSelectedPreset(t.value);
    } else if (t.dataset.bandCmap != null) {
      const i = Number(t.dataset.bandCmap);
      const band = ctx.rendering.tfBands?.[i];
      if (band) {
        band.colorMap = t.value as ColorMapName;
        ctx.applyTf();
        if (i === ctx.getActiveBandIndex()) ctx.getCurveEditor()?.setColorMap(band.colorMap);
        ctx.emitRendering();
      }
    }
  });
}

export function bindHudInput(ctx: HudEventContext): void {
  ctx.ui.addEventListener("input", (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset.chk) {
      const on = t.checked;
      if (t.dataset.chk === "showPlanes") ctx.cropping.showPlanes = on;
      if (t.dataset.chk === "enX") ctx.cropping.enX = on;
      if (t.dataset.chk === "enY") ctx.cropping.enY = on;
      if (t.dataset.chk === "enZ") ctx.cropping.enZ = on;
      if (t.dataset.chk === "pickMode") {
        ctx.picking.setPickMode(on);
        ctx.renderUi();
        return;
      }
      if (t.dataset.chk === "cropDragMode") {
        ctx.cropDrag.setCropMode(on);
        ctx.renderUi();
        return;
      }
      if (
        t.dataset.chk === "fxBloom" ||
        t.dataset.chk === "fxFxaa" ||
        t.dataset.chk === "fxSharpen" ||
        t.dataset.chk === "fxVignette"
      ) {
        if (t.dataset.chk === "fxBloom") ctx.rendering.fxBloom = on;
        else if (t.dataset.chk === "fxFxaa") ctx.rendering.fxFxaa = on;
        else if (t.dataset.chk === "fxSharpen") ctx.rendering.fxSharpen = on;
        else if (t.dataset.chk === "fxVignette") ctx.rendering.fxVignette = on;
        ctx.rebuildFxStack();
        ctx.emitRendering();
        return;
      }
      if (t.dataset.chk === "equalizeOn") {
        ctx.rendering.equalizeOn = on;
        ctx.recomputeEqualize();
        ctx.applyTf();
        ctx.renderUi(); // refresh the histogram (equalized vs raw) + curve editor
        ctx.emitRendering();
        return;
      }
      if (t.dataset.chk === "measurePlaneOn") {
        ctx.rendering.measurePlaneOn = on; // the render loop reads this live; just emit for links/share
        ctx.emitRendering();
        return;
      }
      if (t.dataset.chk === "invertOrbitX" || t.dataset.chk === "invertOrbitY") {
        if (t.dataset.chk === "invertOrbitX") ctx.rendering.invertOrbitX = on;
        else ctx.rendering.invertOrbitY = on; // the render loop reads these live, no other side effect
        ctx.emitRendering();
        return;
      }
      if (t.dataset.chk === "roiEnabled") {
        ctx.residency.setEnabled(on); // toggling off fades + discards the resident brick over the next frames
        ctx.volumeRenderer.setVisibilityFeedback(on); // Milestone 1: ray-guided streaming signal
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
        t.dataset.chk === "gbufferLighting" ||
        t.dataset.chk === "shadowCastGlobal" ||
        t.dataset.chk === "shadowCastFlash" ||
        t.dataset.chk === "shadowCastStage"
      ) {
        if (t.dataset.chk === "lightGlobalOn") ctx.rendering.lightGlobalOn = on;
        else if (t.dataset.chk === "lightFlashOn") ctx.rendering.lightFlashOn = on;
        else if (t.dataset.chk === "lightStageOn") ctx.rendering.lightStageOn = on;
        else if (t.dataset.chk === "shadowOn") ctx.rendering.shadowOn = on;
        else if (t.dataset.chk === "aoOn") ctx.rendering.aoOn = on;
        else if (t.dataset.chk === "halfRes") ctx.rendering.halfRes = on;
        else if (t.dataset.chk === "temporalAA") { ctx.rendering.temporalAA = on; ctx.taau.setEnabled(on); }
        else if (t.dataset.chk === "gbufferLighting") ctx.rendering.gbufferLighting = on;
        else if (t.dataset.chk === "shadowCastGlobal") ctx.rendering.shadowCastGlobal = on;
        else if (t.dataset.chk === "shadowCastFlash") ctx.rendering.shadowCastFlash = on;
        else if (t.dataset.chk === "shadowCastStage") ctx.rendering.shadowCastStage = on;
        ctx.applyLighting();
        ctx.emitRendering();
        return;
      }
      ctx.applyRender();
      ctx.emitCropping();
      return;
    }
    if (t.dataset.color) {
      const cid = t.dataset.color;
      if (cid === "lightGlobalColor") ctx.rendering.lightGlobalColor = t.value;
      else if (cid === "lightFlashColor") ctx.rendering.lightFlashColor = t.value;
      else if (cid === "lightStageColor") ctx.rendering.lightStageColor = t.value;
      ctx.emitRendering();
      return;
    }
    if (t.dataset.maskColor != null) {
      const slot = readMaskSlot(t);
      if (slot != null) ctx.setMaskClassColor(slot, Number(t.dataset.maskColor), hexToRgb(t.value));
      return;
    }
    if (t.dataset.maskOpacity != null) {
      const slot = readMaskSlot(t);
      if (slot == null) return;
      const id = Number(t.dataset.maskOpacity);
      const v = Number(t.value);
      ctx.setMaskClassOpacity(slot, id, v);
      // Patch the label directly (no renderUi()) - same reasoning as the tfBandRange slider: a full
      // rebuild on every drag tick would be needlessly slow and isn't needed just to show a number.
      // Scoped by slot too - both slots have their own independent class-id space, so id alone could
      // match two labels (one per slot) if both happen to have discovered the same class id.
      const label = ctx.ui.querySelector(`[data-mask-opacity-val="${id}"][data-mask-slot="${slot}"]`);
      if (label) label.textContent = fmt(v);
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
        ctx.rendering.colorLo = lo;
        ctx.rendering.colorHi = hi;
        ctx.applyTf();
        ctx.getCurveEditor()?.setColorRange([ctx.rendering.colorLo, ctx.rendering.colorHi]);
        ctx.emitRendering();
      } else if (group === "tfBandRange") {
        const i = ctx.getActiveBandIndex();
        const band = ctx.rendering.tfBands?.[i];
        if (band) {
          band.loT = lo;
          band.hiT = hi;
          ctx.applyTf();
          // Patch the row's "lo – hi" readout directly (no full renderUi()) - a full rebuild would tear
          // down and recreate the OpacityCurveEditor on every drag tick, causing exactly the jank/flicker
          // the interaction-perf fix above was just added to avoid.
          const label = ctx.ui.querySelector(`[data-band-range-label="${i}"]`);
          if (label) label.textContent = `${fmt(lo)} – ${fmt(hi)}`;
          ctx.emitRendering();
        }
      } else if (group === "cropX" || group === "cropY" || group === "cropZ") {
        const axis = group === "cropX" ? 0 : group === "cropY" ? 1 : 2;
        ctx.cropping.cropMin[axis] = lo;
        ctx.cropping.cropMax[axis] = hi;
        ctx.applyRender();
        ctx.emitCropping();
      }
      return;
    }
    if (!t.dataset.slider) return;
    const id = t.dataset.slider;
    const v = Number(t.value);
    const lab = ctx.ui.querySelector(`[data-val="${id}"]`);
    if (lab) lab.textContent = fmt(v);
    if (id.startsWith("tfBandScale")) {
      const band = ctx.rendering.tfBands?.[Number(id.slice("tfBandScale".length))];
      if (band) {
        band.opacityScale = v;
        ctx.applyTf();
        ctx.emitRendering(); // outside RENDERING_SLIDERS (a static id set - this id is per-band/dynamic)
      }
      return;
    }
    switch (id) {
      case "opacityScale":
        ctx.rendering.opacityScale = v;
        ctx.applyTf();
        break;
      case "measureDepth":
        ctx.rendering.measureDepth = v; // the render loop reads these live (ruler + plane depth/appearance)
        break;
      case "measureGray":
        ctx.rendering.measurePlaneGray = v;
        break;
      case "measureAlpha":
        ctx.rendering.measurePlaneAlpha = v;
        break;
      case "equalizeClip":
        ctx.rendering.equalizeClip = v;
        if (ctx.rendering.equalizeOn) {
          ctx.recomputeEqualize();
          ctx.applyTf();
          const histogram = ctx.getHistogram();
          if (histogram) ctx.getCurveEditor()?.setHistogram(histogram);
        }
        break;
      case "sampleDist":
        ctx.rendering.sampleDist = v;
        ctx.applyRender();
        break;
      case "density":
        ctx.rendering.densityScale = v;
        ctx.applyRender();
        break;
      case "exposure":
        ctx.rendering.exposure = v;
        ctx.applyRender();
        break;
      case "gradOp":
        ctx.rendering.gradOpacity = v;
        ctx.applyRender();
        break;
      case "gradScale":
        ctx.rendering.gradScale = v;
        ctx.applyRender();
        break;
      case "lighting":
        ctx.rendering.lighting = v;
        ctx.applyRender();
        break;
      case "activeSlice":
        ctx.setActiveSlice(v);
        if (ctx.openSections.has("slices")) {
          // Refresh µm / index labels without rebuilding the whole panel (keeps focus).
          const active = ctx.activeSlice();
          if (active) {
            const source = ctx.getSource();
            const level = ctx.getLevel();
            const n =
              active.axis === "x"
                ? source.dimensionsAt(level)[0]!
                : active.axis === "y"
                  ? source.dimensionsAt(level)[1]!
                  : source.dimensionsAt(level)[2]!;
            const idx = Math.min(n - 1, Math.floor(active.value * n));
            const info = ctx.ui.querySelector("[data-slice-info]");
            if (info) {
              info.textContent = `${ctx.sliceWorldLabel(active.axis, active.value)} · index ${idx}/${n - 1}`;
            }
          }
        }
        break;
      case "sliceX":
        ctx.cropping.sliceX = v;
        ctx.applyRender();
        break;
      case "sliceY":
        ctx.cropping.sliceY = v;
        ctx.applyRender();
        break;
      case "sliceZ":
        ctx.cropping.sliceZ = v;
        ctx.applyRender();
        break;
      case "fxExposure":
        ctx.rendering.fxExposure = v;
        ctx.rebuildFxStack();
        break;
      case "fxBloomThreshold":
        ctx.rendering.fxBloomThreshold = v;
        ctx.rebuildFxStack();
        break;
      case "fxBloomIntensity":
        ctx.rendering.fxBloomIntensity = v;
        ctx.rebuildFxStack();
        break;
      case "fxSharpenAmount":
        ctx.rendering.fxSharpenAmount = v;
        ctx.rebuildFxStack();
        break;
      case "fxVignetteAmount":
        ctx.rendering.fxVignetteAmount = v;
        ctx.rebuildFxStack();
        break;
      case "lightGlobalIntensity":
        ctx.rendering.lightGlobalIntensity = v;
        break;
      case "lightAzimuth":
        ctx.rendering.lightAzimuth = v;
        break;
      case "lightElevation":
        ctx.rendering.lightElevation = v;
        break;
      case "lightFlashIntensity":
        ctx.rendering.lightFlashIntensity = v;
        break;
      case "lightStageIntensity":
        ctx.rendering.lightStageIntensity = v;
        break;
      case "lightAmbient":
        ctx.rendering.lightAmbient = v;
        ctx.applyLighting();
        break;
      case "lightSpecular":
        ctx.rendering.lightSpecular = v;
        ctx.applyLighting();
        break;
      case "lightRoughness":
        ctx.rendering.lightRoughness = v;
        ctx.applyLighting();
        break;
      case "shadowQuality":
        ctx.rendering.shadowQuality = v;
        ctx.applyLighting();
        break;
      case "shadowStrength":
        ctx.rendering.shadowStrength = v;
        ctx.applyLighting();
        break;
      case "aoRadius":
        ctx.rendering.aoRadius = v;
        ctx.applyLighting();
        break;
      case "aoIntensity":
        ctx.rendering.aoIntensity = v;
        ctx.applyLighting();
        break;
      case "shadowSoftness":
        ctx.rendering.shadowSoftness = v;
        ctx.applyLighting();
        break;
      case "aoSamples":
        ctx.rendering.aoSamples = v;
        ctx.applyLighting();
        break;
      // Cone/range feed buildFrameLights (rebuilt per frame) — just store the value.
      case "flashConeDeg":
        ctx.rendering.flashConeDeg = v;
        break;
      case "flashRange":
        ctx.rendering.flashRange = v;
        break;
      case "stageConeDeg":
        ctx.rendering.stageConeDeg = v;
        break;
      case "stageRange":
        ctx.rendering.stageRange = v;
        break;
      default:
        break;
    }
    if (RENDERING_SLIDERS.has(id)) ctx.emitRendering();
    else if (CROPPING_SLIDERS.has(id)) ctx.emitCropping();
    else if (FX_SLIDERS.has(id)) ctx.emitRendering();
    else if (LIGHTING_SLIDERS.has(id)) ctx.emitRendering();
  });
}

/** Wire all three HUD event listeners at once. */
export function bindHudEvents(ctx: HudEventContext): void {
  bindHudClick(ctx);
  bindHudChange(ctx);
  bindHudInput(ctx);
}
