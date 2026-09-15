/**
 * Camera pose comparison, used to detect "did the camera actually move" for render-on-demand
 * gating and ROI idle tracking. Pure — no closure state.
 *
 * @packageDocumentation
 */

/**
 * The subset of `WebGpuCameraState`'s shape this comparison needs. A structural type (rather than
 * importing `WebGpuCameraState` from `WebGpuVolumeViewer.ts`) so this module has no dependency on
 * the file that imports it.
 */
export interface CameraPoseLike {
  readonly target: readonly [number, number, number];
  readonly offset: readonly [number, number, number];
  readonly gazeUp: readonly [number, number, number];
  readonly distance: number;
}

/**
 * `true` when `a` and `b` are the same pose within a relative tolerance (`1e-4 * (1 + |x| + |y|)`
 * per component) — the tolerance grows with coordinate magnitude so it stays meaningful whether the
 * camera is close to the origin or zoomed far out.
 */
export function camsEqual(a: CameraPoseLike | null, b: CameraPoseLike | null): boolean {
  if (!a || !b) return false;
  const close = (x: number, y: number): boolean =>
    Math.abs(x - y) <= 1e-4 * (1 + Math.abs(x) + Math.abs(y));
  return (
    close(a.distance, b.distance) &&
    a.target.every((v, i) => close(v, b.target[i]!)) &&
    a.offset.every((v, i) => close(v, b.offset[i]!)) &&
    a.gazeUp.every((v, i) => close(v, b.gazeUp[i]!))
  );
}
