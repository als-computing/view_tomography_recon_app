/**
 * Lightweight, localStorage-backed persistence for the WebGPU viewer's rendering settings.
 *
 * Two independent things live here:
 *  - The *last-used* snapshot (one per browser), auto-remembered as the user tweaks controls and
 *    auto-applied to every new sample/session so a look carries over without any manual step.
 *  - *Named presets* (a map of name → snapshot) the user saves/applies/deletes explicitly.
 *
 * A "snapshot" is just the serializable rendering state produced by the viewer's `getRendering()`
 * (colormap, opacity curve, density/exposure, FX, lighting, measure plane — no camera or cropping).
 * We keep the type opaque here so this module stays decoupled from the viewer; callers cast on the
 * way in/out. Every access is wrapped in try/catch so private-mode / disabled-storage never throws.
 */

export type RenderingSnapshot = Record<string, unknown>;

const LAST_KEY = "zarr-viewer:rendering:last";
const PRESETS_KEY = "zarr-viewer:rendering:presets";

function storage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/** The rendering snapshot the user last had active, or `null` if none was ever stored. */
export function getLastRendering(): RenderingSnapshot | null {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(LAST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return isSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Remember `snapshot` as the last-used rendering (called debounced as the user edits controls). */
export function setLastRendering(snapshot: RenderingSnapshot): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(LAST_KEY, JSON.stringify(snapshot));
  } catch (err) {
    console.warn("rendering-presets: failed to persist last rendering:", err);
  }
}

function readPresets(): Record<string, RenderingSnapshot> {
  const s = storage();
  if (!s) return {};
  try {
    const raw = s.getItem(PRESETS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, RenderingSnapshot> = {};
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isSnapshot(value)) out[name] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function writePresets(map: Record<string, RenderingSnapshot>): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(PRESETS_KEY, JSON.stringify(map));
  } catch (err) {
    console.warn("rendering-presets: failed to persist presets:", err);
  }
}

/** Names of all saved presets, sorted case-insensitively for a stable dropdown order. */
export function listPresetNames(): string[] {
  return Object.keys(readPresets()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/** The snapshot stored under `name`, or `null` if there is no such preset. */
export function getPreset(name: string): RenderingSnapshot | null {
  const map = readPresets();
  return Object.prototype.hasOwnProperty.call(map, name) ? map[name]! : null;
}

/** Create or overwrite the preset `name` with `snapshot`. Blank names are ignored. */
export function savePreset(name: string, snapshot: RenderingSnapshot): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  const map = readPresets();
  map[trimmed] = snapshot;
  writePresets(map);
}

/** Remove the preset `name` (no-op if it doesn't exist). */
export function deletePreset(name: string): void {
  const map = readPresets();
  if (Object.prototype.hasOwnProperty.call(map, name)) {
    delete map[name];
    writePresets(map);
  }
}

function isSnapshot(value: unknown): value is RenderingSnapshot {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
