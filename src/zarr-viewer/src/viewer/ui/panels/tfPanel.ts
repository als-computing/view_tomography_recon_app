/**
 * HUD "Transfer Function" panel. Two modes:
 * - **Single** (default): colormap picker, opacity scale, the opacity-curve canvas, color-range
 *   slider, auto-contrast controls — unchanged from before item 7 Phase A.
 * - **Bands**: up to `MAX_TF_BANDS` independent intensity sub-ranges of the same volume, each with
 *   its own colormap + opacity curve (see `render/volume/tf-bands.ts`). A compact row per band (an
 *   eye toggle, colormap, range readout, remove); the shared opacity-curve canvas (mounted separately
 *   by the caller, same as single mode) edits whichever band is selected. Bands can overlap - see
 *   `composeMultiBandTransferFunction`'s doc for how an overlap is resolved (later band paints over).
 *
 * Pure string builder.
 *
 * @packageDocumentation
 */

import { colorMapNames, MAX_TF_BANDS } from "@zarr-viewer/render";
import type { WebGpuRenderingState } from "../../RenderingState.js";
import { slider, rangeSlider, segBtn, fmt } from "../html.js";

function colorMapOptions(selected: string): string {
  return colorMapNames()
    .map((m) => `<option value="${m}" ${m === selected ? "selected" : ""}>${m}</option>`)
    .join("");
}

export function tfPanelBody(rendering: WebGpuRenderingState, activeBandIndex = 0): string {
  const bands = rendering.tfBands ?? [];
  const bandsOn = bands.length > 0;
  const modeToggle =
    `<div class="whud__seg">` +
    segBtn("data-tfmode", "single", "Single", !bandsOn) +
    segBtn("data-tfmode", "bands", "Bands", bandsOn) +
    `</div>`;

  if (!bandsOn) {
    return [
      modeToggle,
      `<label class="whud__row" style="font-size:11px">Colormap <select id="cmap" class="whud__select">${colorMapOptions(rendering.colorMap)}</select></label>`,
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

  const idx = Math.min(Math.max(activeBandIndex, 0), bands.length - 1);
  const rows = bands
    .map((band, i) => {
      const active = i === idx;
      return (
        `<div class="whud__row" style="gap:4px;align-items:center;padding:3px 4px;border-radius:4px;${
          active ? "background:var(--whud-hover-bg)" : ""
        }">` +
        `<button type="button" data-act="selectTfBand" data-idx="${i}" class="whud__seg-btn${active ? " whud__seg-btn--active" : ""}" style="width:20px;padding:2px">${i + 1}</button>` +
        `<button type="button" data-act="toggleTfBand" data-idx="${i}" class="whud__seg-btn${band.enabled === false ? "" : " whud__seg-btn--active"}" style="width:22px;padding:2px" title="${band.enabled === false ? "Show" : "Hide"} this band">${band.enabled === false ? "◌" : "👁"}</button>` +
        `<select data-band-cmap="${i}" class="whud__select" style="flex:1;font-size:10px${band.enabled === false ? ";opacity:0.5" : ""}">${colorMapOptions(band.colorMap)}</select>` +
        `<span data-band-range-label="${i}" style="font-size:10px;color:var(--whud-muted);min-width:66px;text-align:right;font-variant-numeric:tabular-nums">${fmt(band.loT)} – ${fmt(band.hiT)}</span>` +
        `<button type="button" data-act="removeTfBand" data-idx="${i}" class="whud__seg-btn" style="padding:2px 6px">×</button>` +
        `</div>`
      );
    })
    .join("");
  const addBtn =
    bands.length < MAX_TF_BANDS
      ? `<button type="button" data-act="addTfBand" class="whud__seg-btn" style="width:100%;margin-top:4px">+ Add band</button>`
      : `<div class="whud__hint">Max ${MAX_TF_BANDS} bands</div>`;
  const activeBand = bands[idx];
  return [
    modeToggle,
    `<div class="whud__hint">Each band recolors its own intensity range independently. Click a row to select it, then edit its range/curve below. Switching back to Single discards these bands.</div>`,
    rows,
    addBtn,
    // Dual-thumb range slider for whichever band is selected - dragging is much easier to get exactly
    // right than typing numbers, same reasoning as the single-TF "Color range" slider it mirrors.
    activeBand ? rangeSlider("tfBandRange", `Band ${idx + 1} range`, activeBand.loT, activeBand.hiT, 0.005) : "",
    slider(`tfBandScale${idx}`, "Opacity ×", activeBand?.opacityScale ?? 1, 0.05, 2, 0.01),
    `<canvas id="opacity-curve" style="width:100%;height:84px;display:block;touch-action:none;cursor:crosshair"></canvas>`,
  ].join("");
}
