/**
 * HUD "Measure" panel: the measure-plane controls, pick mode, and the connected-component pick
 * result (voxel count, physical volume). Pure string builder.
 *
 * @packageDocumentation
 */

import { units } from "@zarr-viewer/core";
import type { PickedFeature } from "@zarr-viewer/io";
import type { WebGpuRenderingState } from "../../RenderingState.js";
import { slider } from "../html.js";

export function measurePanelBody(params: {
  rendering: WebGpuRenderingState;
  pickMode: boolean;
  pickStatus: string;
  lastPick: PickedFeature | undefined;
  /** Cubic length unit matching the viewer's length unit (e.g. µm³), for formatting `lastPick.volume`. */
  u3: units.Unit;
}): string {
  const { rendering, pickMode, pickStatus, lastPick, u3 } = params;
  const detail = lastPick
    ? [
        `<div style="margin-top:8px;font-size:11px;line-height:1.45">`,
        `<div>Seed voxel <b>${lastPick.seedVoxel.join(", ")}</b> · density ${lastPick.seedDensity.toFixed(2)}</div>`,
        `<div>Threshold ≥ <b>${lastPick.threshold.toFixed(2)}</b> · <b>${lastPick.voxelCount.toLocaleString()}</b> voxels</div>`,
        `<div>Volume <b>${lastPick.volume.to(u3).toExponential(3)}</b> ${u3.symbol}</div>`,
        `<div style="color:var(--whud-muted)">${lastPick.volume.to(units.milliliter).toExponential(3)} mL · mean ${lastPick.meanDensity.toFixed(2)}</div>`,
        `</div>`,
      ].join("")
    : "";
  return [
    `<label class="whud__check"><input type="checkbox" data-chk="measurePlaneOn" ${rendering.measurePlaneOn ? "checked" : ""}/> Measure plane (camera-linked ruler)</label>`,
    slider("measureDepth", "Plane depth (front→back)", rendering.measureDepth, 0, 1, 0.01),
    slider("measureGray", "Plane gray", rendering.measurePlaneGray, 0, 1, 0.02),
    slider("measureAlpha", "Plane opacity", rendering.measurePlaneAlpha, 0, 1, 0.02),
    `<div class="whud__hint">A grey sheet that sweeps from the volume's front face (0) to its back face (1) along the view axis, tracking zoom; the volume in front of it occludes it and it dims volume behind, so you can read depth. Rulers calibrate to this plane; off = exact at the volume center.</div>`,
    `<div class="whud__hint" style="margin-top:8px">Click a structure to grow a connected component and measure its physical volume (current LOD).</div>`,
    `<label class="whud__check"><input type="checkbox" data-chk="pickMode" ${pickMode ? "checked" : ""}/> Pick mode (or Ctrl+click)</label>`,
    `<div class="whud__row"><button type="button" data-act="clearPick" class="whud__seg-btn">Clear selection</button></div>`,
    pickStatus ? `<div style="margin-top:8px;font-size:11px">${pickStatus}</div>` : "",
    detail,
    `<div class="whud__hint">Uses ray pick through the volume + 6-connected flood fill. Crop snaps to the feature. Prefer L2+ for speed on huge volumes.</div>`,
  ].join("");
}
