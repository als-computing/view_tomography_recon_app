/**
 * Small, closure-free helpers used by the viewer: matrix/scale-bar math and the two ways a Zarr
 * source can be picked (the `?zarr=` query param, or a local directory via the File System Access API).
 *
 * @packageDocumentation
 */

import { fileSystemStore, type Store } from "@zarr-viewer/io";
import type { Mat4 } from "@zarr-viewer/math";

const DEFAULT_ZARR = "/datasets/petiole.zarr";

/** `m * [x, y, z, w]` — expanded rather than routed through {@link Mat4}'s Vec4 API for call-site brevity. */
export function mulMat4Vec4(
  m: Mat4,
  x: number,
  y: number,
  z: number,
  w: number,
): [number, number, number, number] {
  const e = m.elements;
  return [
    e[0]! * x + e[4]! * y + e[8]! * z + e[12]! * w,
    e[1]! * x + e[5]! * y + e[9]! * z + e[13]! * w,
    e[2]! * x + e[6]! * y + e[10]! * z + e[14]! * w,
    e[3]! * x + e[7]! * y + e[11]! * z + e[15]! * w,
  ];
}

/** Largest "nice" 1/2/5·10ⁿ value ≤ x — for a scale bar whose length never exceeds its pixel budget. */
export function niceFloor125(x: number): number {
  const exp = Math.floor(Math.log10(x));
  const base = Math.pow(10, exp);
  const f = x / base; // in [1, 10)
  const m = f >= 5 ? 5 : f >= 2 ? 2 : 1;
  return m * base;
}

/** The `?zarr=` query param, or the built-in demo dataset if absent/empty. */
export function zarrUrlFromQuery(): string {
  const q = new URLSearchParams(window.location.search).get("zarr");
  return q && q.length > 0 ? q : DEFAULT_ZARR;
}

/** Prompt for a local directory via the File System Access API, or `undefined` if unsupported/cancelled. */
export async function pickZarrStore(): Promise<Store | undefined> {
  const w = window as Window & {
    showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
  };
  if (typeof w.showDirectoryPicker !== "function") return undefined;
  return fileSystemStore(await w.showDirectoryPicker());
}
