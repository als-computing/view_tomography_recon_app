/**
 * Feature picking: ray-cast through the volume at a screen point, grow a connected component, and
 * snap the crop box to it. Owns pick mode, the busy/status text shown in the Measure panel, the last
 * picked feature, and the canvas pointer-down/up listeners that trigger a pick (P-then-click, or
 * Ctrl/Meta+click).
 *
 * @packageDocumentation
 */

import { units } from "@zarr-viewer/core";
import { pickConnectedFeature, type PickedFeature, type VolumeSource } from "@zarr-viewer/io";
import type { Node } from "@zarr-viewer/scene";
import type { Mat4 } from "@zarr-viewer/math";
import { rayDir } from "../volume/roi-geometry.js";
import type { WebGpuCroppingState } from "../RenderingState.js";

export interface PickingDeps {
  canvas: HTMLCanvasElement;
  camera: Node;
  /** Scratch matrices reused across the render path (allocation-free, mutated in place). */
  invViewProj: Mat4;
  lastViewProj: Mat4;
  getSource(): VolumeSource;
  getLevel(): number;
  sizeSim: { x: number; y: number; z: number };
  cropping: WebGpuCroppingState;
  valueRange: readonly [number, number];
  isLoading(): boolean;
  /** Cubic length unit matching the viewer's current length unit (e.g. µm³), for status formatting. */
  getVolumeUnit3(): units.Unit;
  applyRender(): void;
  renderUi(): void;
  /** Called on a successful pick, so the caller can open the Measure panel. */
  onPicked(): void;
}

export class PickingController {
  private readonly deps: PickingDeps;
  private mode = false;
  private busy = false;
  private feature: PickedFeature | undefined;
  private statusText = "";
  private pointerDown: { x: number; y: number } | null = null;

  private readonly handlePointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    if (!(this.mode || e.ctrlKey || e.metaKey)) return;
    this.pointerDown = { x: e.clientX, y: e.clientY };
  };

  private readonly handlePointerUp = (e: PointerEvent): void => {
    if (!this.pointerDown) return;
    const dx = e.clientX - this.pointerDown.x;
    const dy = e.clientY - this.pointerDown.y;
    this.pointerDown = null;
    if (dx * dx + dy * dy > 36) return; // drag → ignore
    void this.runPickAt(e.clientX, e.clientY);
  };

  public constructor(deps: PickingDeps) {
    this.deps = deps;
    deps.canvas.addEventListener("pointerdown", this.handlePointerDown);
    deps.canvas.addEventListener("pointerup", this.handlePointerUp);
  }

  public get pickMode(): boolean {
    return this.mode;
  }

  public get isBusy(): boolean {
    return this.busy;
  }

  public get lastFeature(): PickedFeature | undefined {
    return this.feature;
  }

  public get status(): string {
    return this.statusText;
  }

  public setPickMode(enabled: boolean): void {
    this.mode = enabled;
    this.deps.canvas.style.cursor = enabled ? "crosshair" : "";
  }

  public togglePickMode(): void {
    this.setPickMode(!this.mode);
  }

  /** Clear the last pick result (does not touch pick mode or the crop box). */
  public clear(): void {
    this.feature = undefined;
    this.statusText = "";
  }

  /** Ray-cast at a client (viewport) point, grow a connected component, and snap the crop to it. */
  public async runPickAt(clientX: number, clientY: number): Promise<void> {
    const { deps: d } = this;
    if (this.busy || d.isLoading()) return;
    this.busy = true;
    this.statusText = "Picking…";
    d.renderUi();
    try {
      const rect = d.canvas.getBoundingClientRect();
      const u = ((clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1;
      const v = -(((clientY - rect.top) / Math.max(rect.height, 1)) * 2 - 1);
      d.invViewProj.copy(d.lastViewProj);
      if (!d.invViewProj.invert()) {
        this.statusText = "Pick failed (bad camera matrix).";
        this.feature = undefined;
        return;
      }
      const [dx, dy, dz] = rayDir(d.invViewProj, u, v);
      const eye = d.camera.position;
      const source = d.getSource();
      const feature = await pickConnectedFeature(source, {
        level: d.getLevel(),
        ray: {
          origin: [eye.x, eye.y, eye.z],
          direction: [dx, dy, dz],
        },
        boxHalf: [d.sizeSim.x * 0.5, d.sizeSim.y * 0.5, d.sizeSim.z * 0.5],
        hitDensity: Math.max(d.valueRange[1] * 0.15, 2),
        relativeLow: 0.55,
        maxRegionVoxels: 2_000_000,
      });
      if (!feature) {
        this.feature = undefined;
        this.statusText = "No feature under cursor (try a denser region or lower LOD).";
        return;
      }
      this.feature = feature;
      d.cropping.cropMin = [...feature.cropMin] as [number, number, number];
      d.cropping.cropMax = [...feature.cropMax] as [number, number, number];
      d.applyRender();
      const u3 = d.getVolumeUnit3();
      this.statusText = `Selected ${feature.voxelCount.toLocaleString()} voxels · ${feature.volume.to(u3).toExponential(3)} ${u3.symbol}`;
      d.onPicked();
    } catch (err) {
      this.feature = undefined;
      this.statusText = err instanceof Error ? err.message : String(err);
    } finally {
      this.busy = false;
      d.renderUi();
    }
  }

  public dispose(): void {
    this.deps.canvas.removeEventListener("pointerdown", this.handlePointerDown);
    this.deps.canvas.removeEventListener("pointerup", this.handlePointerUp);
  }
}
