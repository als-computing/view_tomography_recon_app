/**
 * Interactive crop-box dragging: while crop mode is on, hovering a face of the crop box highlights it
 * and dragging pushes/pulls that face along its own axis. Owns crop mode, the currently-hovered face
 * (for cursor feedback + the overlay's highlight), and the canvas pointer listeners that drive it —
 * mirrors `PickingController`'s shape.
 *
 * @packageDocumentation
 */

import type { Node } from "@zarr-viewer/scene";
import type { Mat4 } from "@zarr-viewer/math";
import {
  cropWorldBox,
  intersectCropFaces,
  axisScreenProjection,
  dragFaceScreenDelta,
  padBox,
  type CropFaceHit,
} from "../volume/crop-drag-geometry.js";
import { rayDir } from "../volume/roi-geometry.js";
import type { WebGpuCroppingState } from "../RenderingState.js";

export interface CropDragDeps {
  canvas: HTMLCanvasElement;
  camera: Node;
  /** Scratch matrices reused across the render path (allocation-free, mutated in place). */
  invViewProj: Mat4;
  lastViewProj: Mat4;
  sizeSim: { x: number; y: number; z: number };
  cropping: WebGpuCroppingState;
  /** Crop-drag only makes sense in the full "volume" view mode - in a slice-plane view (xPlane/yPlane/
   * zPlane) the camera is locked face-on to one plane, so dragging a 3D box face doesn't map onto the
   * 2D interaction the user is actually doing there. */
  isVolumeView(): boolean;
  applyRender(): void;
  /** Called once when a drag finishes, so the caller can refresh the Crop panel's sliders. */
  onDragEnd(): void;
}

const MIN_SPAN = 0.02; // minimum crop span per axis, in UVW - a face can't cross past this into its opposite
// Hover/pointerdown hit-testing uses a box inflated by this fraction of each axis's own span, so the
// cursor doesn't have to land exactly on an infinitely-thin face plane to register - without this the
// box was hard to select. The drawn box and the actual crop values are unaffected; only hit-testing is
// padded (per-axis, not by the largest overall dimension - see padBox's doc comment for why).
const HOVER_PAD_FRACTION = 0.02;

export class CropDragController {
  private readonly deps: CropDragDeps;
  private mode = false;
  private hovered: CropFaceHit | undefined;
  private dragging:
    | {
        axis: 0 | 1 | 2;
        side: "min" | "max";
        anchor: [number, number, number];
        anchorWorldCoord: number;
        startScreen: [number, number];
      }
    | undefined;

  private readonly handlePointerMove = (e: PointerEvent): void => {
    const { deps: d } = this;
    if (this.dragging) {
      this.updateDrag(e);
      return;
    }
    if (!this.mode) return;
    const prev = this.hovered;
    this.hovered = this.hitTestAt(e.clientX, e.clientY) ?? undefined;
    d.canvas.style.cursor = this.hovered ? "grab" : "crosshair";
    // Only the overlay's highlight needs a repaint on a pure hover change (no camera/crop change) -
    // the main render loop otherwise stays idle between camera-driven frames, so without this the
    // wireframe highlight wouldn't update as the user moves between faces without also orbiting.
    if ((prev?.axis !== this.hovered?.axis || prev?.side !== this.hovered?.side)) {
      d.applyRender();
    }
  };

  private readonly handlePointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || !this.mode) return;
    const hit = this.hitTestAt(e.clientX, e.clientY);
    if (!hit) return;
    // Canvas-relative (not raw client) coordinates - must match updateDrag's currentScreen, and both
    // must match the coordinate space worldToScreen/axisScreenProjection operate in.
    const rect = this.deps.canvas.getBoundingClientRect();
    this.dragging = {
      axis: hit.axis,
      side: hit.side,
      anchor: hit.point,
      anchorWorldCoord: hit.point[hit.axis],
      startScreen: [e.clientX - rect.left, e.clientY - rect.top],
    };
    this.deps.canvas.style.cursor = "grabbing";
    this.deps.canvas.setPointerCapture(e.pointerId);
    e.stopPropagation();
  };

  private readonly handlePointerUp = (e: PointerEvent): void => {
    if (!this.dragging) return;
    this.dragging = undefined;
    this.deps.canvas.style.cursor = this.mode ? "crosshair" : "";
    if (this.deps.canvas.hasPointerCapture(e.pointerId)) {
      this.deps.canvas.releasePointerCapture(e.pointerId);
    }
    this.deps.onDragEnd();
  };

  public constructor(deps: CropDragDeps) {
    this.deps = deps;
    deps.canvas.addEventListener("pointermove", this.handlePointerMove);
    deps.canvas.addEventListener("pointerdown", this.handlePointerDown);
    deps.canvas.addEventListener("pointerup", this.handlePointerUp);
  }

  public get cropMode(): boolean {
    return this.mode;
  }

  public get hoveredFace(): CropFaceHit | undefined {
    return this.hovered;
  }

  public get isDragging(): boolean {
    return this.dragging !== undefined;
  }

  /** The face to highlight in the overlay: the one being dragged, else the one currently hovered. */
  public get activeFace(): { axis: 0 | 1 | 2; side: "min" | "max" } | undefined {
    if (this.dragging) return { axis: this.dragging.axis, side: this.dragging.side };
    return this.hovered ? { axis: this.hovered.axis, side: this.hovered.side } : undefined;
  }

  public setCropMode(enabled: boolean): void {
    this.mode = enabled;
    if (!enabled) {
      this.hovered = undefined;
      this.deps.canvas.style.cursor = "";
    } else {
      this.deps.canvas.style.cursor = "crosshair";
    }
  }

  public toggleCropMode(): void {
    this.setCropMode(!this.mode);
  }

  /** Whether a pointerdown at this event would start a face drag - used to veto orbit-drag start. */
  public wouldHit(e: PointerEvent): boolean {
    return this.mode && this.hitTestAt(e.clientX, e.clientY) !== null;
  }

  private hitTestAt(clientX: number, clientY: number): CropFaceHit | null {
    const { deps: d } = this;
    if (!d.isVolumeView()) return null;
    const rect = d.canvas.getBoundingClientRect();
    const u = ((clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1;
    const v = -(((clientY - rect.top) / Math.max(rect.height, 1)) * 2 - 1);
    d.invViewProj.copy(d.lastViewProj);
    if (!d.invViewProj.invert()) return null;
    const [dx, dy, dz] = rayDir(d.invViewProj, u, v);
    const eye = d.camera.position;
    const box = cropWorldBox(d.cropping.cropMin, d.cropping.cropMax, d.sizeSim);
    const padded = padBox(box.min, box.max, HOVER_PAD_FRACTION);
    return intersectCropFaces(eye.x, eye.y, eye.z, dx, dy, dz, padded.min, padded.max);
  }

  private updateDrag(e: PointerEvent): void {
    const { deps: d } = this;
    if (!this.dragging) return;
    const rect = d.canvas.getBoundingClientRect();
    const cw = rect.width || 1;
    const ch = rect.height || 1;
    // Recomputed fresh from the live camera every move tick, so the mapping stays correct even if the
    // user orbits mid-drag - see axisScreenProjection's doc comment for why this screen-space approach
    // (not a 3D ray-plane intersection) is what actually guarantees the drag matches what's drawn.
    const projection = axisScreenProjection(d.lastViewProj, this.dragging.anchor, this.dragging.axis, cw, ch);
    if (!projection) return; // axis is edge-on to the screen this tick - hold the last valid position

    const worldCoord = dragFaceScreenDelta(
      projection,
      this.dragging.anchorWorldCoord,
      this.dragging.startScreen,
      [e.clientX - rect.left, e.clientY - rect.top],
    );

    const { axis, side } = this.dragging;
    const size = [d.sizeSim.x, d.sizeSim.y, d.sizeSim.z][axis]!;
    const u01 = Math.min(1, Math.max(0, (worldCoord + size * 0.5) / size));
    const cropMin = d.cropping.cropMin;
    const cropMax = d.cropping.cropMax;
    if (side === "min") {
      cropMin[axis] = Math.min(u01, cropMax[axis] - MIN_SPAN);
    } else {
      cropMax[axis] = Math.max(u01, cropMin[axis] + MIN_SPAN);
    }
    d.applyRender();
  }

  public dispose(): void {
    this.deps.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.deps.canvas.removeEventListener("pointerdown", this.handlePointerDown);
    this.deps.canvas.removeEventListener("pointerup", this.handlePointerUp);
  }
}
