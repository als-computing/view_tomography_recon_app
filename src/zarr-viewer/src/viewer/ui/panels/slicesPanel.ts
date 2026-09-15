/**
 * HUD "Slices" panel: volume/slice-plane view-mode selector, the active slice's position slider,
 * and per-axis slice overlays. Pure string builder — `active`/`sliceLabel` are computed by the
 * caller (they depend on the viewer's unit system and the current `activeSlice()` read).
 *
 * @packageDocumentation
 */

import type { VolumeViewMode } from "@zarr-viewer/render";
import type { WebGpuRenderingState, WebGpuCroppingState } from "../../RenderingState.js";
import { segBtn, slider } from "../html.js";

export function slicesPanelBody(params: {
  rendering: WebGpuRenderingState;
  cropping: WebGpuCroppingState;
  active: { axis: "x" | "y" | "z"; value: number } | null;
  /** Physical-unit label for the active slice (e.g. "12.3 µm"), or "" when `active` is null. */
  sliceWorldLabel: string;
  /** Voxel count along the active slice's axis, or 0 when `active` is null. */
  axisVoxelCount: number;
}): string {
  const { rendering, cropping, active, sliceWorldLabel, axisVoxelCount } = params;
  const modes: [VolumeViewMode, string][] = [
    ["volume", "3D"],
    ["xPlane", "X (sagittal)"],
    ["yPlane", "Y (coronal)"],
    ["zPlane", "Z (axial)"],
  ];
  const modeBtns = modes.map(([m, lab]) => segBtn("data-view", m, lab, rendering.viewMode === m)).join("");

  let primary: string;
  if (active) {
    const n = axisVoxelCount;
    const idx = Math.min(n - 1, Math.floor(active.value * n));
    primary = [
      `<div style="font-size:12px;margin:8px 0 4px;font-weight:600">Slice along ${active.axis.toUpperCase()}</div>`,
      `<div class="whud__hint" data-slice-info>${sliceWorldLabel} · index ${idx}/${n - 1}</div>`,
      slider("activeSlice", "Position", active.value, 0, 1, 1 / Math.max(n, 2)),
      `<div class="whud__hint">Scroll wheel = scrub slice · Ctrl+wheel = zoom · middle/Alt-drag = pan · F = reframe</div>`,
    ].join("");
  } else {
    primary = `<div class="whud__hint">Pick an axis view, then scrub with the slider or mouse wheel.</div>`;
  }

  return [
    `<div class="whud__seg">${modeBtns}</div>`,
    primary,
    `<details style="margin-top:8px"><summary style="cursor:pointer;color:var(--whud-muted);font-size:11px">Overlays &amp; all axes</summary>`,
    `<label class="whud__check"><input type="checkbox" data-chk="showPlanes" ${cropping.showPlanes ? "checked" : ""}/> Show plane overlays in 3D</label>`,
    `<div class="whud__row">`,
    `<label class="whud__check"><input type="checkbox" data-chk="enX" ${cropping.enX ? "checked" : ""}/> X</label>`,
    `<label class="whud__check"><input type="checkbox" data-chk="enY" ${cropping.enY ? "checked" : ""}/> Y</label>`,
    `<label class="whud__check"><input type="checkbox" data-chk="enZ" ${cropping.enZ ? "checked" : ""}/> Z</label>`,
    `</div>`,
    slider("sliceX", "X", cropping.sliceX, 0, 1, 0.005),
    slider("sliceY", "Y", cropping.sliceY, 0, 1, 0.005),
    slider("sliceZ", "Z", cropping.sliceZ, 0, 1, 0.005),
    `<button type="button" data-act="frameSlice" class="whud__seg-btn" style="margin-top:6px">Reframe to slice</button>`,
    `</details>`,
  ].join("");
}
