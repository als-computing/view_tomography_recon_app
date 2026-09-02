/**
 * Finch-themed HUD styles for the WebGPU OME-Zarr viewer.
 *
 * Single source of truth for the ".whud" panel look (light surface, sky accents), shared by the
 * React-docked sidebar and the standalone dev harness. {@link ensureHudStyles} injects the stylesheet
 * once per document (guarded by the <style> id), so no bundler CSS-import wiring is needed.
 */

const STYLE_ID = "webgpu-hud-styles";

const HUD_CSS = `
.whud {
  --whud-surface: #ffffff;
  --whud-text: #374151;
  --whud-muted: #6b7280;
  --whud-border: #e5e7eb;
  --whud-active: #0284c7;
  --whud-active-border: #0369a1;
  --whud-hover-bg: #f0f9ff;
  --whud-hover-border: #7dd3fc;
  --radius: .5rem;
  box-sizing: border-box;
  color: var(--whud-text);
  background: var(--whud-surface);
  font: 12px/1.45 ui-sans-serif, system-ui, sans-serif;
  accent-color: var(--whud-active);
}
.whud *, .whud *::before, .whud *::after { box-sizing: border-box; }

.whud--floating {
  position: absolute;
  left: 12px;
  bottom: 12px;
  width: min(360px, 92%);
  max-height: min(78vh, 720px);
  overflow: auto;
  padding: 12px 14px;
  border: 1px solid var(--whud-border);
  border-radius: var(--radius);
  box-shadow: 0 6px 24px rgba(15, 23, 42, 0.18);
  pointer-events: auto;
  z-index: 2;
}

.whud--docked {
  position: static;
  width: 100%;
  height: 100%;
  overflow: auto;
  padding: 12px 14px;
  border-left: 1px solid var(--whud-border);
}

.whud__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-weight: 600;
  font-size: 13px;
  color: var(--whud-text);
}
.whud__title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Whole-panel collapse toggle in the header. */
.whud__collapse-btn {
  flex-shrink: 0;
  cursor: pointer;
  width: 22px;
  height: 22px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font: inherit;
  font-size: 14px;
  line-height: 1;
  color: var(--whud-muted);
  background: var(--whud-surface);
  border: 1px solid var(--whud-border);
  border-radius: var(--radius);
  transition: background .12s ease, border-color .12s ease, color .12s ease;
}
.whud__collapse-btn:hover {
  background: var(--whud-hover-bg);
  border-color: var(--whud-hover-border);
  color: var(--whud-text);
}

/* Volume-settings / Render-settings tab switcher in the header. */
.whud__tab-btn {
  flex-shrink: 0;
  cursor: pointer;
  width: 22px;
  height: 22px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font: inherit;
  font-size: 12px;
  line-height: 1;
  color: var(--whud-muted);
  background: var(--whud-surface);
  border: 1px solid var(--whud-border);
  border-radius: var(--radius);
  transition: background .12s ease, border-color .12s ease, color .12s ease;
}
.whud__tab-btn:hover {
  background: var(--whud-hover-bg);
  border-color: var(--whud-hover-border);
  color: var(--whud-text);
}
.whud__tab-btn--active,
.whud__tab-btn--active:hover {
  background: var(--whud-active);
  border-color: var(--whud-active-border);
  color: #ffffff;
}

/* Collapsed: hide everything but the expand chevron. Docked panels are narrowed to a thin strip by
   the viewer (sidebar width); floating panels shrink to just their header. */
.whud--collapsed { overflow: hidden; }
.whud--docked.whud--collapsed { padding: 8px 3px; }
.whud--floating.whud--collapsed {
  width: auto;
  max-height: none;
  padding: 8px;
}
.whud--collapsed .whud__status,
.whud--collapsed .whud__section,
.whud--collapsed .whud__hint,
.whud--collapsed .whud__title { display: none; }
.whud--collapsed .whud__header { justify-content: center; gap: 0; }

.whud__status {
  color: var(--whud-muted);
  font-size: 11px;
  margin: 3px 0 8px;
}

.whud__section {
  border: 1px solid var(--whud-border);
  border-radius: var(--radius);
  margin: 6px 0;
  background: var(--whud-surface);
  overflow: hidden;
}
.whud__section > summary {
  list-style: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 10px;
  font-weight: 600;
  font-size: 12px;
  color: var(--whud-text);
  user-select: none;
}
.whud__section > summary::-webkit-details-marker { display: none; }
.whud__section > summary:hover { background: var(--whud-hover-bg); }
.whud__section > summary::after {
  content: "";
  width: 8px;
  height: 8px;
  border-right: 2px solid var(--whud-muted);
  border-bottom: 2px solid var(--whud-muted);
  transform: rotate(-45deg);
  transition: transform .15s ease;
  flex-shrink: 0;
}
.whud__section[open] > summary::after { transform: rotate(45deg); }
.whud__section-body { padding: 4px 10px 10px; }

.whud__row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  margin: 4px 0;
}

.whud__slider {
  display: grid;
  grid-template-columns: 92px 1fr 44px;
  gap: 6px;
  align-items: center;
  margin: 5px 0;
  font-size: 11px;
}
.whud__slider > span:first-child { color: var(--whud-muted); }
.whud__slider input[type="range"] {
  width: 100%;
  accent-color: var(--whud-active);
}
.whud__value {
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--whud-text);
}

.whud__seg {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 4px 0 6px;
}
.whud__seg-btn {
  cursor: pointer;
  padding: 4px 9px;
  font: inherit;
  font-size: 11px;
  color: var(--whud-text);
  background: var(--whud-surface);
  border: 1px solid var(--whud-border);
  border-radius: var(--radius);
  transition: background .12s ease, border-color .12s ease, color .12s ease;
}
.whud__seg-btn:hover:not(:disabled) {
  background: var(--whud-hover-bg);
  border-color: var(--whud-hover-border);
}
.whud__seg-btn:disabled { opacity: 0.5; cursor: default; }
.whud__seg-btn--active,
.whud__seg-btn--active:hover {
  background: var(--whud-active);
  border-color: var(--whud-active-border);
  color: #ffffff;
}

.whud__check {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 5px 0;
  font-size: 11px;
  color: var(--whud-text);
  cursor: pointer;
}
.whud__check input[type="checkbox"] { accent-color: var(--whud-active); }

.whud__hint {
  color: var(--whud-muted);
  font-size: 10px;
  margin: 6px 0;
  line-height: 1.4;
}

.whud__select {
  flex: 1;
  font: inherit;
  font-size: 11px;
  color: var(--whud-text);
  background: var(--whud-surface);
  border: 1px solid var(--whud-border);
  border-radius: var(--radius);
  padding: 3px 6px;
}
.whud__select:hover { border-color: var(--whud-hover-border); }

.whud label { color: var(--whud-text); }
.whud b { color: var(--whud-text); }
.whud canvas { border: 1px solid var(--whud-border); border-radius: var(--radius); }

/* Dual-thumb color-range slider (two overlaid range inputs; only the thumbs are grabbable). Sits
   directly under the opacity-curve canvas so its handles line up with the graph's intensity axis. */
.whud__range { position: relative; height: 26px; margin: 8px 0 2px; }
.whud__range-track {
  position: absolute; left: 0; right: 0; top: 50%; transform: translateY(-50%);
  height: 4px; border-radius: 999px; background: var(--whud-border); pointer-events: none;
}
/* pointer-events is inherited from .whud__range-track's "none" unless overridden here - re-enable it
   so the fill band is itself draggable (shifts both thumbs together, preserving the range width). */
.whud__range-fill {
  position: absolute; top: 0; bottom: 0; background: var(--whud-active); border-radius: 999px;
  pointer-events: auto; cursor: grab;
}
.whud__range-fill:active { cursor: grabbing; }
.whud__range-input {
  position: absolute; left: 0; right: 0; top: 0; width: 100%; height: 100%; margin: 0;
  background: transparent; pointer-events: none; -webkit-appearance: none; appearance: none;
}
.whud__range-input::-webkit-slider-runnable-track { background: transparent; height: 100%; }
.whud__range-input::-moz-range-track { background: transparent; height: 100%; }
.whud__range-input::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none; pointer-events: auto;
  width: 14px; height: 14px; border-radius: 50%; background: #fff;
  border: 2px solid var(--whud-active-border); cursor: pointer;
}
.whud__range-input::-moz-range-thumb {
  pointer-events: auto; width: 14px; height: 14px; border-radius: 50%; background: #fff;
  border: 2px solid var(--whud-active-border); cursor: pointer;
}
.whud__range-labels {
  display: flex; justify-content: space-between;
  font-size: 10px; color: var(--whud-muted); font-variant-numeric: tabular-nums;
}
`;

/** Inject the HUD stylesheet once per document (idempotent). */
export function ensureHudStyles(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = HUD_CSS;
  doc.head.appendChild(style);
}
