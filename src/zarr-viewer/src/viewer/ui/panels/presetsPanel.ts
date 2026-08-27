/**
 * HUD "Presets" panel: save/apply/delete named rendering looks. Pure string builder — the caller
 * owns the `selectedPreset` state and should call {@link sanitizeSelectedPreset} before rendering so
 * the dropdown selection stays valid across preset add/remove and HUD rebuilds.
 *
 * @packageDocumentation
 */

import { escAttr } from "../html.js";

/**
 * Correct a `selectedPreset` value against the current preset list: clears it if it no longer
 * exists, then falls back to the first preset if nothing is selected. Call before every render.
 */
export function sanitizeSelectedPreset(selectedPreset: string, presetNames: readonly string[]): string {
  if (selectedPreset && !presetNames.includes(selectedPreset)) selectedPreset = "";
  if (!selectedPreset && presetNames.length) selectedPreset = presetNames[0]!;
  return selectedPreset;
}

export function presetsPanelBody(presetNames: readonly string[], selectedPreset: string): string {
  const presetOptions = presetNames.length
    ? presetNames
        .map((n) => `<option value="${escAttr(n)}" ${n === selectedPreset ? "selected" : ""}>${escAttr(n)}</option>`)
        .join("")
    : `<option value="">(no presets saved)</option>`;
  return [
    `<label class="whud__row" style="font-size:11px">Preset <select id="presetSelect" class="whud__select">${presetOptions}</select></label>`,
    `<div class="whud__row" style="gap:6px;margin-top:6px">` +
      `<button type="button" data-act="applyPreset" class="whud__seg-btn"${presetNames.length ? "" : " disabled"}>Apply</button>` +
      `<button type="button" data-act="savePreset" class="whud__seg-btn">Save as…</button>` +
      `<button type="button" data-act="deletePreset" class="whud__seg-btn"${presetNames.length ? "" : " disabled"}>Delete</button>` +
      `</div>`,
    `<div class="whud__hint">Saves the current look (colormap, opacity, density/exposure, FX, lighting, measure) to this browser — shared across samples and sessions. Camera and cropping are not included. Your latest look is auto-applied to new samples.</div>`,
  ].join("");
}
