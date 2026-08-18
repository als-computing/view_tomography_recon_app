/**
 * Lightweight, localStorage-backed persistence for the WebGPU viewer's rendering settings.
 *
 * Two independent things live here:
 *  - The *last-used* snapshot, auto-remembered as the user tweaks controls and auto-applied on boot so
 *    a look carries over without any manual step. It's stored *per sample* (keyed by the sample id,
 *    i.e. the Zarr URL) so switching back to a tab restores that tab's own look — not whatever another
 *    tab touched most recently. A single global snapshot is also kept as the *seed* applied to a
 *    never-before-seen sample, so a brand-new tab still inherits the last look you were working with.
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

/** Per-sample storage key for `sampleKey`, or the shared global key when no sample is given. */
function lastKeyFor(sampleKey?: string): string {
  return sampleKey ? `${LAST_KEY}:${sampleKey}` : LAST_KEY;
}

function readSnapshotAt(key: string): RenderingSnapshot | null {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return isSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The rendering snapshot to restore on boot. With a `sampleKey`, returns that sample's own last-used
 * look, falling back to the shared global snapshot when this sample has never been seen (so a new tab
 * still inherits the last look). Returns `null` if nothing was ever stored.
 */
export function getLastRendering(sampleKey?: string): RenderingSnapshot | null {
  if (sampleKey) {
    const own = readSnapshotAt(lastKeyFor(sampleKey));
    if (own) return own;
  }
  return readSnapshotAt(LAST_KEY);
}

/**
 * Remember `snapshot` as the last-used rendering (called debounced as the user edits controls). Writes
 * the shared global snapshot always, and — when a `sampleKey` is given — that sample's own snapshot too,
 * so each tab keeps an independent memory.
 */
export function setLastRendering(snapshot: RenderingSnapshot, sampleKey?: string): void {
  const s = storage();
  if (!s) return;
  try {
    const json = JSON.stringify(snapshot);
    s.setItem(LAST_KEY, json);
    if (sampleKey) s.setItem(lastKeyFor(sampleKey), json);
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
