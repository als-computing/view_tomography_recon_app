/**
 * Camera framing for the viewer's slice/volume view modes: positioning the orbit camera for the
 * active mode, and reading/writing the active slice's position. No GPU calls — mutates the given
 * `OrbitControls`/`Node` and the shared `rendering`/`cropping` state objects directly, the same way
 * the rest of the viewer does.
 *
 * @packageDocumentation
 */

import type { Node } from "@zarr-viewer/scene";
import type { OrbitControls } from "@zarr-viewer/controls";
import type { VolumeViewMode } from "@zarr-viewer/render";
import type { WebGpuRenderingState, WebGpuCroppingState } from "../RenderingState.js";

/** The camera objects every function here positions. */
export interface CameraContext {
  controls: OrbitControls;
  camera: Node;
  sizeSim: { x: number; y: number; z: number };
}

/** Point the orbit camera at the active view mode: face-on to the active slice plane, or the
 * standard 3/4 framing for the full volume. */
export function frameSliceCamera(
  ctx: CameraContext,
  viewMode: VolumeViewMode,
  slice: { x: number; y: number; z: number },
): void {
  const { controls, camera, sizeSim } = ctx;
  const extent = Math.max(sizeSim.x, sizeSim.y, sizeSim.z) || 1;
  const px = (slice.x - 0.5) * sizeSim.x;
  const py = (slice.y - 0.5) * sizeSim.y;
  const pz = (slice.z - 0.5) * sizeSim.z;
  const dist = extent * 1.65;
  if (viewMode === "xPlane") {
    controls.target.set(px, 0, 0);
    camera.position.set(px + dist, py * 0.05, pz * 0.05);
  } else if (viewMode === "yPlane") {
    controls.target.set(0, py, 0);
    camera.position.set(px * 0.05, py + dist, pz * 0.05);
  } else if (viewMode === "zPlane") {
    controls.target.set(0, 0, pz);
    camera.position.set(px * 0.05, py * 0.05, pz + dist);
  } else {
    controls.target.set(0, 0, 0);
    camera.position.set(extent * 1.2, extent * 0.85, extent * 1.2);
  }
  controls.syncFromNode();
  controls.update(0);
}

/**
 * Switch view mode: for a plane mode, also enables that axis's slice + overlay. Triggers a render
 * and, when `reframe`, repositions the camera via {@link frameSliceCamera}.
 */
export function enterViewMode(
  ctx: CameraContext,
  mode: VolumeViewMode,
  rendering: WebGpuRenderingState,
  cropping: WebGpuCroppingState,
  applyRender: () => void,
  reframe = true,
): void {
  rendering.viewMode = mode;
  if (mode === "xPlane") {
    cropping.enX = true;
    cropping.showPlanes = true;
  } else if (mode === "yPlane") {
    cropping.enY = true;
    cropping.showPlanes = true;
  } else if (mode === "zPlane") {
    cropping.enZ = true;
    cropping.showPlanes = true;
  }
  applyRender();
  if (reframe) {
    frameSliceCamera(ctx, rendering.viewMode, {
      x: cropping.sliceX,
      y: cropping.sliceY,
      z: cropping.sliceZ,
    });
  }
}

/** The axis + position of the currently active slice plane, or `null` in volume view. */
export function activeSlice(
  rendering: WebGpuRenderingState,
  cropping: WebGpuCroppingState,
): { axis: "x" | "y" | "z"; value: number } | null {
  if (rendering.viewMode === "xPlane") return { axis: "x", value: cropping.sliceX };
  if (rendering.viewMode === "yPlane") return { axis: "y", value: cropping.sliceY };
  if (rendering.viewMode === "zPlane") return { axis: "z", value: cropping.sliceZ };
  return null;
}

/** Move the active slice plane to `v` (clamped to `[0,1]`); a no-op in volume view. */
export function setActiveSlice(
  v: number,
  rendering: WebGpuRenderingState,
  cropping: WebGpuCroppingState,
  applyRender: () => void,
): void {
  const clamped = Math.min(1, Math.max(0, v));
  if (rendering.viewMode === "xPlane") cropping.sliceX = clamped;
  else if (rendering.viewMode === "yPlane") cropping.sliceY = clamped;
  else if (rendering.viewMode === "zPlane") cropping.sliceZ = clamped;
  else return;
  applyRender();
}
