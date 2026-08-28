/**
 * HUD "Post FX" panel: tonemap operator + exposure (always applied), plus toggle-gated bloom / FXAA
 * / sharpen / vignette. Pure string builder.
 *
 * @packageDocumentation
 */

import type { ToneMapOperator } from "@zarr-viewer/fx";
import type { WebGpuRenderingState } from "../../RenderingState.js";
import { slider } from "../html.js";

export function postfxPanelBody(rendering: WebGpuRenderingState): string {
  const tmOps: ToneMapOperator[] = ["aces", "reinhard", "reinhard-extended"];
  const tmOptions = tmOps
    .map((o) => `<option value="${o}" ${o === rendering.fxOperator ? "selected" : ""}>${o}</option>`)
    .join("");
  return [
    `<label class="whud__row" style="font-size:11px">Tonemap <select id="fxop" class="whud__select">${tmOptions}</select></label>`,
    slider("fxExposure", "Exposure (stops)", rendering.fxExposure, -4, 4, 0.05),
    `<label class="whud__check"><input type="checkbox" data-chk="fxBloom" ${rendering.fxBloom ? "checked" : ""}/> Bloom</label>`,
    slider("fxBloomThreshold", "Bloom threshold", rendering.fxBloomThreshold, 0, 3, 0.05),
    slider("fxBloomIntensity", "Bloom intensity", rendering.fxBloomIntensity, 0, 2, 0.05),
    `<label class="whud__check"><input type="checkbox" data-chk="fxFxaa" ${rendering.fxFxaa ? "checked" : ""}/> FXAA (anti-alias edges)</label>`,
    `<label class="whud__check"><input type="checkbox" data-chk="fxSharpen" ${rendering.fxSharpen ? "checked" : ""}/> Sharpen</label>`,
    slider("fxSharpenAmount", "Sharpen amount", rendering.fxSharpenAmount, 0, 2, 0.05),
    `<label class="whud__check"><input type="checkbox" data-chk="fxVignette" ${rendering.fxVignette ? "checked" : ""}/> Vignette</label>`,
    slider("fxVignetteAmount", "Vignette amount", rendering.fxVignetteAmount, 0, 1, 0.02),
  ].join("");
}
