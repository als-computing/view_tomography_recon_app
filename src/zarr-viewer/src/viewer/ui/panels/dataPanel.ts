/**
 * HUD "Data" panel: resolution/LOD picker, voxel size, and any levels blocked by the GPU's max
 * 3D-texture dimension. Pure string builder — no DOM access.
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
}): string {
  const { source, levels, level, loading, maxTex, unit } = params;
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
  ].join("");
}
