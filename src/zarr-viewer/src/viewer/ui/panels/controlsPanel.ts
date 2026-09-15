/**
 * HUD "Controls" panel (under the Render settings tab): input/interaction preferences, currently just
 * the orbit-drag axis inverters. Pure string builder — no DOM access.
 *
 * @packageDocumentation
 */

import type { WebGpuRenderingState } from "../../RenderingState.js";

export function controlsPanelBody(rendering: WebGpuRenderingState): string {
  return [
    `<div class="whud__hint">Orbit drag</div>`,
    `<label class="whud__check"><input type="checkbox" data-chk="invertOrbitX" ${rendering.invertOrbitX ? "checked" : ""}/> Invert X axis</label>`,
    `<label class="whud__check"><input type="checkbox" data-chk="invertOrbitY" ${rendering.invertOrbitY ? "checked" : ""}/> Invert Y axis</label>`,
  ].join("");
}
