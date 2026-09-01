/**
 * HUD "Annotations" panel (item 7 Phase B): two independent mask/annotation slots, each with its own
 * URL loader and one row per discovered class — a color swatch, an opacity slider, and a visibility
 * (eye) toggle. Slot naming/semantics ("fast" vs "deep", etc.) is entirely the embedding host's
 * business; this panel stays slot-neutral ("Mask 1" / "Mask 2"). Pure string builder — no DOM access.
 *
 * @packageDocumentation
 */

import type { MaskClassState } from "../../state/mask-classes.js";
import { escAttr, fmt } from "../html.js";

function rgbToHex([r, g, b]: readonly [number, number, number]): string {
  const to255 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `#${[to255(r), to255(g), to255(b)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return [1, 1, 1];
  return [parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255];
}

/** One mask slot's display state. */
export interface AnnotationSlotView {
  maskUrl: string;
  maskLoading: boolean;
  maskError: string | undefined;
  maskLoaded: boolean;
  classes: readonly MaskClassState[];
}

function slotSectionBody(slot: 0 | 1, s: AnnotationSlotView): string {
  const rows = s.classes
    .map(
      (cls) =>
        `<div class="whud__row" style="gap:6px;align-items:center">` +
        `<input type="color" data-mask-color="${cls.id}" data-mask-slot="${slot}" value="${rgbToHex(cls.color)}" style="width:22px;height:20px;padding:0;border:none;background:none;cursor:pointer"/>` +
        `<span style="font-size:10px;flex:1">Class ${cls.id} <span style="color:var(--whud-muted)">(${cls.voxelCount.toLocaleString()} vox)</span></span>` +
        `<input type="range" data-mask-opacity="${cls.id}" data-mask-slot="${slot}" min="0" max="1" step="0.01" value="${cls.opacity}" style="width:56px"/>` +
        `<span data-mask-opacity-val="${cls.id}" data-mask-slot="${slot}" class="whud__value" style="width:26px">${fmt(cls.opacity)}</span>` +
        `<button type="button" data-act="toggleMaskClass" data-idx="${cls.id}" data-mask-slot="${slot}" class="whud__seg-btn${cls.visible ? " whud__seg-btn--active" : ""}" style="width:22px;padding:2px" title="${cls.visible ? "Hide" : "Show"} this class">${cls.visible ? "👁" : "◌"}</button>` +
        `</div>`,
    )
    .join("");

  return [
    `<div style="font-size:11px;font-weight:600;margin-top:4px">Mask ${slot + 1}</div>`,
    `<label class="whud__row" style="font-size:11px">URL <input type="text" id="maskUrlInput${slot}" data-mask-slot="${slot}" class="whud__select" style="flex:1;font-size:10px" value="${escAttr(s.maskUrl)}" placeholder="https://.../mask.zarr"/></label>`,
    `<div class="whud__row" style="gap:6px;margin-top:4px">` +
      `<button type="button" data-act="loadMask" data-mask-slot="${slot}" class="whud__seg-btn"${s.maskLoading ? " disabled" : ""}>${s.maskLoading ? "Loading…" : "Load"}</button>` +
      (s.maskLoaded
        ? `<button type="button" data-act="removeMask" data-mask-slot="${slot}" class="whud__seg-btn">Remove</button>`
        : "") +
      `</div>`,
    s.maskError ? `<div class="whud__hint" style="color:#e57373">${escAttr(s.maskError)}</div>` : "",
    s.maskLoaded && s.classes.length === 0
      ? `<div class="whud__hint">Loaded, but every voxel is class 0 (background) — nothing to show.</div>`
      : "",
    rows,
  ].join("");
}

export function annotationsPanelBody(slots: readonly [AnnotationSlotView, AnnotationSlotView]): string {
  return [
    slotSectionBody(0, slots[0]),
    `<hr style="border:none;border-top:1px solid var(--whud-border);margin:10px 0 4px"/>`,
    slotSectionBody(1, slots[1]),
    `<div class="whud__hint">Each mask is assumed to share the primary volume's own voxel grid. Class id 0 is treated as background and never shown.</div>`,
  ].join("");
}

export { rgbToHex, hexToRgb };
