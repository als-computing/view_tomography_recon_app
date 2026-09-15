/**
 * Pure HTML template-string builders for the viewer's HUD panels. No DOM access, no closure state —
 * every dynamic value (including which panels are open) is passed in explicitly.
 *
 * @packageDocumentation
 */

/** Identifies one collapsible HUD panel. */
export type PanelId =
  | "data"
  | "tf"
  | "render"
  | "slices"
  | "crop"
  | "measure"
  | "postfx"
  | "lighting"
  | "presets"
  | "controls"
  | "annotations";

/** Which top-level HUD tab a panel lives under. */
export type HudTab = "volume" | "render";

/** `PanelId`s shown under the "Volume settings" tab. */
export const VOLUME_TAB_PANELS: readonly PanelId[] = [
  "data",
  "tf",
  "slices",
  "crop",
  "measure",
  "annotations",
  "presets",
];
/** `PanelId`s shown under the "Render settings" tab. */
export const RENDER_TAB_PANELS: readonly PanelId[] = ["render", "lighting", "postfx", "controls"];

/** A collapsible `<details>` panel; open/closed state comes from the caller's `openSections` set. */
export function section(
  openSections: ReadonlySet<PanelId>,
  id: PanelId,
  title: string,
  body: string,
): string {
  return (
    `<details class="whud__section" data-section="${id}" ${openSections.has(id) ? "open" : ""}>` +
    `<summary>${title}</summary>` +
    `<div class="whud__section-body">${body}</div>` +
    `</details>`
  );
}

/** One button in a segmented-control group. */
export function segBtn(
  attr: string,
  val: string,
  label: string,
  active: boolean,
  disabled = false,
): string {
  return `<button type="button" ${attr}="${val}" class="whud__seg-btn${active ? " whud__seg-btn--active" : ""}"${
    disabled ? " disabled" : ""
  }>${label}</button>`;
}

/** A labeled single-thumb range input with a live value readout. */
export function slider(
  id: string,
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
): string {
  return (
    `<label class="whud__slider">` +
    `<span>${label}</span>` +
    `<input data-slider="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${value}"/>` +
    `<span data-val="${id}" class="whud__value">${fmt(value)}</span></label>`
  );
}

/** Format a numeric HUD value: 1 decimal place at magnitude >= 10, else 2. */
export function fmt(v: number): string {
  return Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
}

/** A labeled `<input type="color">` row. */
export function colorRow(id: string, label: string, value: string): string {
  return (
    `<label class="whud__row" style="font-size:11px;align-items:center;gap:8px">${label} ` +
    `<input type="color" data-color="${id}" value="${value}" style="width:32px;height:20px;padding:0;border:none;background:none;cursor:pointer"/></label>`
  );
}

/** Escape a user-supplied string for safe interpolation into HTML attribute + text contexts. */
export function escAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Dual-thumb `[lo, hi]` range slider. `group` scopes the pair (e.g. "color", "cropX") so one delegated
 * input handler drives every range: two overlaid range inputs, a visual track/fill, and a value label.
 */
export function rangeSlider(group: string, label: string, lo: number, hi: number, step = 0.005): string {
  return (
    `<div class="whud__range" data-range-group="${group}">` +
    `<div class="whud__range-track"><div class="whud__range-fill" data-range-fill style="left:${lo * 100}%;width:${(hi - lo) * 100}%"></div></div>` +
    `<input class="whud__range-input" type="range" min="0" max="1" step="${step}" value="${lo}" data-range="${group}:lo" aria-label="${label} low"/>` +
    `<input class="whud__range-input" type="range" min="0" max="1" step="${step}" value="${hi}" data-range="${group}:hi" aria-label="${label} high"/>` +
    `</div>` +
    `<div class="whud__range-labels"><span>${label}</span><span data-range-vals>${fmt(lo)} – ${fmt(hi)}</span></div>`
  );
}
