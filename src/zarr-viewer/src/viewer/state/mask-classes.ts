/**
 * Per-class visualization state for the mask/annotation layer (item 7 Phase B): which class ids are
 * actually present in a loaded mask (from its voxel tally), their default color/opacity, and how they
 * bake into the 256-entry `rgba8unorm` palette the shader looks up by class id.
 *
 * @packageDocumentation
 */

import { MASK_CLASS_COUNT } from "@zarr-viewer/render";

/** Visualization state for one discovered class id. */
export interface MaskClassState {
  readonly id: number;
  color: [number, number, number]; // [0,1]
  opacity: number; // [0,1]
  visible: boolean;
  /** Approximate voxel count from the (possibly subsampled) tally — for display only. */
  readonly voxelCount: number;
}

/**
 * Discover which class ids actually occur in `classCounts` (from {@link "@zarr-viewer/render".uploadMaskVolume}),
 * so the HUD only lists classes present in this specific mask. Class id 0 is excluded by convention —
 * segmentation masks near-universally use 0 for "unlabeled/background," which would otherwise dominate
 * the list (typically the largest count) and default to covering most of the volume if shown.
 */
export function discoverMaskClasses(classCounts: Uint32Array): MaskClassState[] {
  const out: MaskClassState[] = [];
  for (let id = 1; id < MASK_CLASS_COUNT; id++) {
    const voxelCount = classCounts[id] ?? 0;
    if (voxelCount === 0) continue;
    out.push({ id, color: defaultClassColor(id), opacity: 0.6, visible: true, voxelCount });
  }
  return out;
}

/**
 * Deterministic, visually distinct color for a class id via the golden-angle hue sequence (successive
 * ids land far apart in hue with no manual palette assignment needed) — id 0 is never assigned one
 * (see {@link discoverMaskClasses}) but returns black if ever queried directly.
 */
export function defaultClassColor(classId: number): [number, number, number] {
  if (classId <= 0) return [0, 0, 0];
  const hue = (classId * 137.50776405) % 360;
  return hslToRgb(hue, 0.65, 0.55);
}

function hslToRgb(hueDeg: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const h = hueDeg / 60;
  const x = c * (1 - Math.abs((h % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 1) [r, g, b] = [c, x, 0];
  else if (h < 2) [r, g, b] = [x, c, 0];
  else if (h < 3) [r, g, b] = [0, c, x];
  else if (h < 4) [r, g, b] = [0, x, c];
  else if (h < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [r + m, g + m, b + m];
}

/**
 * Bake `classes` into a 256-entry `rgba8unorm` palette (index = class id, byte layout matches
 * {@link "@zarr-viewer/render".uploadMaskPalette}'s expected input) — a class with `visible: false`, or
 * simply absent (including id 0), gets a fully transparent entry, contributing nothing in the shader's
 * `over` compositing regardless of what color bytes happen to sit there.
 */
export function buildMaskPalette(classes: readonly MaskClassState[]): Uint8Array {
  const bytes = new Uint8Array(MASK_CLASS_COUNT * 4);
  for (const cls of classes) {
    if (cls.id < 0 || cls.id >= MASK_CLASS_COUNT) continue;
    const o = cls.id * 4;
    bytes[o + 0] = Math.round(clamp01(cls.color[0]) * 255);
    bytes[o + 1] = Math.round(clamp01(cls.color[1]) * 255);
    bytes[o + 2] = Math.round(clamp01(cls.color[2]) * 255);
    bytes[o + 3] = cls.visible ? Math.round(clamp01(cls.opacity) * 255) : 0;
  }
  return bytes;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
