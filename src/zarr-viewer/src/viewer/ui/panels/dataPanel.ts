/**
 * HUD "Data" panel: resolution/LOD picker, voxel size, any levels blocked by the GPU's max 3D-texture
 * dimension, and the high-res ROI streaming lever (data-residency, not shading — moved here from
 * Lighting). Pure string builder — no DOM access.
 *
 * @packageDocumentation
 */

import { units } from "@zarr-viewer/core";
import { physicalSizeQuantities, type VolumeSource } from "@zarr-viewer/io";
import { segBtn } from "../html.js";

export function dataPanelBody(params: {
  source: VolumeSource;
  levels: readonly number[];
  level: number;
  loading: boolean;
  maxTex: number;
  unit: units.Unit;
  roiEnabled: boolean;
  roiProgress: { loaded: number; total: number } | null;
}): string {
  const { source, levels, level, loading, maxTex, unit, roiEnabled, roiProgress } = params;
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

  return [
    `<div class="whud__hint">Resolution (GPU max ${maxTex}³)</div>`,
    `<div class="whud__seg">${lodBtns}</div>`,
    `<div class="whud__hint">voxel ${vx.toFixed(3)} ${unit.symbol} · ${qx.to(unit).toFixed(0)}×${qy.to(unit).toFixed(0)}×${qz.to(unit).toFixed(0)} ${unit.symbol}</div>`,
    blocked.length ? `<div class="whud__hint">${blocked.join(" · ")}</div>` : "",
    `<label class="whud__check" style="margin-top:6px"><input type="checkbox" data-chk="roiEnabled" ${roiEnabled ? "checked" : ""}/> High-res ROI (stream visible detail)</label>`,
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
  ].join("");
}
