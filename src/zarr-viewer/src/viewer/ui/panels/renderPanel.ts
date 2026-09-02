/**
 * HUD "Render" panel: blend mode, shader config, PNG export, and the core sampling/shading sliders.
 * Pure string builder.
 *
 * @packageDocumentation
 */

import type { VolumeBlendMode } from "@zarr-viewer/render";
import type { WebGpuRenderingState } from "../../RenderingState.js";
import { segBtn, slider } from "../html.js";

// Phase 2c hardening: "mip"/"average" maximize/average the TF's alpha-weighted color, not the raw
// scalar density (see `marchColor()` in volume-raymarch.ts) — labels say so instead of implying a
// true scalar projection.
const BLEND_LABEL: Record<VolumeBlendMode, string> = {
  composite: "composite",
  mip: "TF-weighted MIP",
  minip: "minip",
  average: "TF-weighted average",
};

export function renderPanelBody(rendering: WebGpuRenderingState): string {
  const blends: VolumeBlendMode[] = ["composite", "mip", "minip", "average"];
  const blendBtns = blends
    .map((b) => segBtn("data-blend", b, BLEND_LABEL[b], rendering.blendMode === b))
    .join("");
  return [
    `<div class="whud__seg">${blendBtns}</div>`,
    `<div class="whud__hint" style="margin-top:6px">Shader config</div>`,
    `<div class="whud__seg">${(["baseline", "fast", "quality"] as const)
      .map((c) => segBtn("data-shader", c, c, rendering.shaderConfig === c))
      .join("")}</div>`,
    `<div class="whud__hint">baseline = plain march. fast/quality = empty-space leap + tiled draw (faster on data with air margins). quality adds cinematic shading (multi-scatter / ambient) — arriving with M7; identical to fast until then.</div>`,
    `<button type="button" data-act="exportPng" class="whud__seg-btn" style="margin-top:6px">Export PNG (stamped)</button>`,
    slider("sampleDist", "Sample dist", rendering.sampleDist, 0.35, 3, 0.05),
    slider("density", "Density", rendering.densityScale, 0.2, 4, 0.05),
    slider("exposure", "Exposure", rendering.exposure, 0.2, 4, 0.05),
    slider("gradOp", "Grad opacity", rendering.gradOpacity, 0, 1, 0.01),
    slider("gradScale", "Grad scale", rendering.gradScale, 0.02, 0.5, 0.01),
    slider("lighting", "Lighting", rendering.lighting, 0, 1, 0.01),
  ].join("");
}
