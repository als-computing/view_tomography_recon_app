/**
 * HUD "Lighting" panel: three light modes (global directional / camera flashlight / 4-corner stage)
 * each with color + intensity, shared shading params, volumetric shadows, ambient occlusion, and the
 * half-res / temporal-AA / high-res-ROI levers. Pure string builder.
 *
 * @packageDocumentation
 */

import type { WebGpuRenderingState } from "../../RenderingState.js";
import { slider, colorRow } from "../html.js";

export function lightingPanelBody(params: {
  rendering: WebGpuRenderingState;
  roiEnabled: boolean;
  roiProgress: { loaded: number; total: number } | null;
}): string {
  const { rendering: r, roiEnabled, roiProgress } = params;
  return [
    `<label class="whud__check"><input type="checkbox" data-chk="lightGlobalOn" ${r.lightGlobalOn ? "checked" : ""}/> Global directional</label>`,
    colorRow("lightGlobalColor", "Color", r.lightGlobalColor),
    slider("lightGlobalIntensity", "Intensity", r.lightGlobalIntensity, 0, 4, 0.05),
    slider("lightAzimuth", "Azimuth°", r.lightAzimuth, 0, 360, 1),
    slider("lightElevation", "Elevation°", r.lightElevation, -90, 90, 1),
    `<label class="whud__check" style="margin-top:6px"><input type="checkbox" data-chk="lightFlashOn" ${r.lightFlashOn ? "checked" : ""}/> Camera flashlight</label>`,
    colorRow("lightFlashColor", "Color", r.lightFlashColor),
    slider("lightFlashIntensity", "Intensity", r.lightFlashIntensity, 0, 4, 0.05),
    slider("flashConeDeg", "Cone°", r.flashConeDeg, 10, 89, 1),
    slider("flashRange", "Range ×ext", r.flashRange, 1, 20, 0.5),
    `<label class="whud__check" style="margin-top:6px"><input type="checkbox" data-chk="lightStageOn" ${r.lightStageOn ? "checked" : ""}/> Stage lights (4 corners)</label>`,
    colorRow("lightStageColor", "Color", r.lightStageColor),
    slider("lightStageIntensity", "Intensity", r.lightStageIntensity, 0, 4, 0.05),
    slider("stageConeDeg", "Cone°", r.stageConeDeg, 10, 89, 1),
    slider("stageRange", "Range ×ext", r.stageRange, 1, 20, 0.5),
    `<div class="whud__hint" style="margin-top:6px">Shading</div>`,
    slider("lightAmbient", "Ambient", r.lightAmbient, 0, 1, 0.01),
    slider("lightSpecular", "Specular", r.lightSpecular, 0, 2, 0.05),
    slider("lightRoughness", "Roughness", r.lightRoughness, 0, 1, 0.02),
    `<label class="whud__check" style="margin-top:6px"><input type="checkbox" data-chk="shadowOn" ${r.shadowOn ? "checked" : ""}/> Shadows</label>`,
    slider("shadowQuality", "Shadow steps", r.shadowQuality, 4, 64, 1),
    slider("shadowStrength", "Shadow strength", r.shadowStrength, 0, 1, 0.02),
    slider("shadowSoftness", "Shadow softness", r.shadowSoftness, 0, 1, 0.02),
    `<div class="whud__hint" style="margin-top:4px">Casters (fewer = faster)</div>`,
    `<label class="whud__check"><input type="checkbox" data-chk="shadowCastGlobal" ${r.shadowCastGlobal ? "checked" : ""}/> Global</label>`,
    `<label class="whud__check"><input type="checkbox" data-chk="shadowCastFlash" ${r.shadowCastFlash ? "checked" : ""}/> Flashlight</label>`,
    `<label class="whud__check"><input type="checkbox" data-chk="shadowCastStage" ${r.shadowCastStage ? "checked" : ""}/> Stage</label>`,
    `<label class="whud__check" style="margin-top:6px"><input type="checkbox" data-chk="aoOn" ${r.aoOn ? "checked" : ""}/> Ambient occlusion</label>`,
    slider("aoRadius", "AO radius", r.aoRadius, 0.01, 0.3, 0.01),
    slider("aoIntensity", "AO intensity", r.aoIntensity, 0, 1, 0.02),
    slider("aoSamples", "AO samples", r.aoSamples, 1, 16, 1),
    `<label class="whud__check" style="margin-top:6px"><input type="checkbox" data-chk="halfRes" ${r.halfRes ? "checked" : ""}/> Half resolution</label>`,
    `<label class="whud__check"><input type="checkbox" data-chk="temporalAA" ${r.temporalAA ? "checked" : ""}/> Temporal AA (accumulate when still)</label>`,
    `<label class="whud__check"><input type="checkbox" data-chk="roiEnabled" ${roiEnabled ? "checked" : ""}/> High-res ROI (stream visible detail)</label>`,
    `<div id="roiProgressWrap" style="margin-top:6px;${roiProgress ? "" : "display:none"}">` +
      `<div style="display:flex;justify-content:space-between;font-size:10px;opacity:0.85">` +
      `<span>Streaming ROI…</span>` +
      `<span id="roiProgressLabel">${roiProgress ? `${roiProgress.loaded}/${roiProgress.total} chunks` : ""}</span>` +
      `</div>` +
      `<div style="height:4px;margin-top:2px;background:rgba(255,255,255,0.15);border-radius:2px;overflow:hidden">` +
      `<div id="roiProgressFill" style="height:100%;background:#5b9dd9;transition:width 0.1s linear;width:${
        roiProgress && roiProgress.total ? Math.round((roiProgress.loaded / roiProgress.total) * 100) : 0
      }%"></div>` +
      `</div>` +
      `</div>`,
    `<div class="whud__hint">Shadows + AO cast secondary rays per sample. Enable half-res on large volumes to keep it interactive.</div>`,
  ].join("");
}
