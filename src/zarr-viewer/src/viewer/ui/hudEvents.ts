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
} from "@zarr-viewer/render";
import type { ToneMapOperator } from "@prism/fx";
import type { FxPipeline } from "../../render/post/fx-pipeline.js";
import type { TemporalAccumulator } from "../../render/accel/taau.js";
import { getPreset, savePreset, deletePreset } from "../../rendering-presets.js";
import type { ResidencyController } from "../volume/ResidencyController.js";
import type { PickingController } from "../interaction/PickingController.js";
import type { WebGpuRenderingState, WebGpuCroppingState } from "../RenderingState.js";
import { autoWindow } from "../histogram.js";
import { fmt, type PanelId } from "./html.js";

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
  openSections: Set<PanelId>;
  getSource(): VolumeSource;
  getLevel(): number;
  getCurveEditor(): OpacityCurveEditor | undefined;
  getRawHistogram(): Float32Array | undefined;
  getHistogram(): Float32Array | undefined;
  getSelectedPreset(): string;
  setSelectedPreset(v: string): void;
  getCollapsed(): boolean;
  setCollapsed(v: boolean): void;
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

export function bindHudClick(ctx: HudEventContext): void {
  ctx.ui.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button") as HTMLButtonElement | null;
    if (!btn) return;
    if (btn.dataset.act === "toggleCollapse") {
      ctx.setCollapsed(!ctx.getCollapsed());
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
    if (btn.dataset.act === "exportPng") {
      void (async () => {
        const blob = await stampCanvasPng(
          ctx.canvas,
          ctx.volumeRenderer.provenance(ctx.fxPipeline.renderScale),
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
