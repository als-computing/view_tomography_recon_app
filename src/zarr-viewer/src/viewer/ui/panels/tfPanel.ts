/**
 * HUD "Transfer Function" panel: colormap picker, opacity scale, the opacity-curve canvas (mounted
 * separately by the caller), color-range slider, and auto-contrast controls. Pure string builder.
 *
 * @packageDocumentation
 */

import { colorMapNames } from "@zarr-viewer/render";
import type { WebGpuRenderingState } from "../../RenderingState.js";
import { slider, rangeSlider } from "../html.js";

export function tfPanelBody(rendering: WebGpuRenderingState): string {
  const maps = colorMapNames()
    .map((m) => `<option value="${m}" ${m === rendering.colorMap ? "selected" : ""}>${m}</option>`)
    .join("");
  return [
    `<label class="whud__row" style="font-size:11px">Colormap <select id="cmap" class="whud__select">${maps}</select></label>`,
    slider("opacityScale", "Opacity ×", rendering.opacityScale, 0.05, 2, 0.01),
    `<div class="whud__hint">Opacity curve (drag · dbl-click add/remove) · volume histogram behind</div>`,
    `<canvas id="opacity-curve" style="width:100%;height:84px;display:block;touch-action:none;cursor:crosshair"></canvas>`,
    // Dual-thumb color-range slider under the graph — both heads set [colorLo, colorHi] together.
    rangeSlider("color", "Color range", rendering.colorLo, rendering.colorHi, 0.005),
    // Auto contrast: percentile auto-window + global contrast-limited equalization.
    `<div class="whud__row" style="gap:8px;margin-top:4px">` +
      `<button type="button" data-act="autoContrast" class="whud__seg-btn">Auto</button>` +
      `<label class="whud__check" style="margin:0"><input type="checkbox" data-chk="equalizeOn" ${rendering.equalizeOn ? "checked" : ""}/> Equalize</label>` +
      `</div>`,
    slider("equalizeClip", "Clip limit", rendering.equalizeClip, 1, 8, 0.5),
  ].join("");
}
