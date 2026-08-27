/**
 * HUD "Crop" panel: one dual-thumb `[min, max]` range slider per axis (ROI in UVW `[0,1]`), plus a
 * reset button. Pure string builder.
 *
 * @packageDocumentation
 */

import type { WebGpuCroppingState } from "../../RenderingState.js";
import { rangeSlider } from "../html.js";

export function cropPanelBody(cropping: WebGpuCroppingState): string {
  return [
    `<div class="whud__hint">ROI crop (UVW 0–1)</div>`,
    rangeSlider("cropX", "X", cropping.cropMin[0], cropping.cropMax[0], 0.01),
    rangeSlider("cropY", "Y", cropping.cropMin[1], cropping.cropMax[1], 0.01),
    rangeSlider("cropZ", "Z", cropping.cropMin[2], cropping.cropMax[2], 0.01),
    `<button type="button" data-act="resetCrop" class="whud__seg-btn" style="margin-top:6px">Reset crop</button>`,
  ].join("");
}
