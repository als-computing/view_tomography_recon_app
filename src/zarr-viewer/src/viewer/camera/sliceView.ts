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
 * standard 3/4 framing for the full volume. `obliqueNormal` is required (and only used) for
 * `viewMode === "oblique"` — falls back to the standard volume framing if omitted, since an oblique
 * plane with no known normal has no face-on direction to frame. */
export function frameSliceCamera(
  ctx: CameraContext,
  viewMode: VolumeViewMode,
  slice: { x: number; y: number; z: number },
  obliqueNormal?: readonly [number, number, number],
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
  } else if (viewMode === "oblique" && obliqueNormal) {
    // Face-on along the plane's own normal, centered on the same (sliceX/Y/Z-derived) point the other
    // plane modes use — not necessarily exactly on the plane (that'd need re-deriving from the plane's
    // offset too), but close enough as a camera focus point; visually indistinguishable.
    //
    // Distance is PRESERVED from the camera's current position, NOT the fixed full-volume `dist` the
    // other branches use — this branch is called every frame while continuously re-facing an oblique
    // pane along a live-tracked normal (`refreshObliqueFraming`), including right after the user's own
    // zoom/orbit input on that same pane. Resetting to `dist` every tick silently snapped the camera
    // back out to the full-volume framing distance on every single call, making it impossible to stay
    // zoomed in on anything — confirmed live ("no way to control the zoomed in view").
    const curDist =
      Math.hypot(
        camera.position.x - controls.target.x,
        camera.position.y - controls.target.y,
        camera.position.z - controls.target.z,
      ) || dist;
    const len = Math.hypot(obliqueNormal[0], obliqueNormal[1], obliqueNormal[2]) || 1;
    const nx = obliqueNormal[0] / len;
    const ny = obliqueNormal[1] / len;
    const nz = obliqueNormal[2] / len;
    controls.target.set(px, py, pz);
    camera.position.set(px + nx * curDist, py + ny * curDist, pz + nz * curDist);
  } else {
    controls.target.set(0, 0, 0);
    camera.position.set(extent * 1.2, extent * 0.85, extent * 1.2);
  }
  controls.syncFromNode();
  controls.update(0);
}

/**
 * Re-center and zoom the camera onto the point where all three slice planes (sliceX/Y/Z) intersect,
 * WITHOUT resetting the viewing angle the way {@link frameSliceCamera} does — the current
 * camera-to-target direction is preserved, only the target and distance change. Meant for a "volume"
 * (3D) view alongside one or more linked 2D slice panes: zooming to the intersection is how the 3D
 * pane focuses on exactly the region the 2D pane(s) are currently showing, from whatever angle the
 * user already has it at.
 */
export function frameSliceIntersection(
  ctx: CameraContext,
  slice: { x: number; y: number; z: number },
  zoomFraction = 0.15,
): void {
  const { controls, camera, sizeSim } = ctx;
  const extent = Math.max(sizeSim.x, sizeSim.y, sizeSim.z) || 1;
  const px = (slice.x - 0.5) * sizeSim.x;
  const py = (slice.y - 0.5) * sizeSim.y;
  const pz = (slice.z - 0.5) * sizeSim.z;
  const dx = camera.position.x - controls.target.x;
  const dy = camera.position.y - controls.target.y;
  const dz = camera.position.z - controls.target.z;
  const dirLen = Math.hypot(dx, dy, dz) || 1;
  const dist = extent * zoomFraction;
  controls.target.set(px, py, pz);
  camera.position.set(px + (dx / dirLen) * dist, py + (dy / dirLen) * dist, pz + (dz / dirLen) * dist);
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
  } else if (mode === "oblique") {
    cropping.enOblique = true;
    cropping.showPlanes = true;
  }
  applyRender();
  if (reframe) {
    frameSliceCamera(
      ctx,
      rendering.viewMode,
      { x: cropping.sliceX, y: cropping.sliceY, z: cropping.sliceZ },
      cropping.obliqueNormal,
    );
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
