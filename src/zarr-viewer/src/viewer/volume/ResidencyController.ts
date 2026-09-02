/**
 * High-res ROI brick streaming: stream + composite a fine sub-volume over the coarse base when
 * zoomed in (or a crop ROI is set), and fade it out / discard on zoom-out. Owns the {@link BrickLoader}
 * and all ROI-local state; the viewer calls {@link ResidencyController.update} once per frame and
 * reads `brickLevel`/`progress` for the HUD.
 *
 * @packageDocumentation
 */

import { units } from "@zarr-viewer/core";
import { chooseBrickRegion, rankVisibilityBins, visBinUvwBox, BrickLoader, type BrickResult, type VolumeRenderer } from "@zarr-viewer/render";
import type { VolumeSource } from "@zarr-viewer/io";
import type { Node } from "@zarr-viewer/scene";
import type { OrbitControls } from "@zarr-viewer/controls";
import type { Mat4 } from "@zarr-viewer/math";
import { cropIsSet, focalRoiUvw } from "./roi-geometry.js";
import { camsEqual, type CameraPoseLike } from "../camera/compare.js";
import type { WebGpuCroppingState } from "../RenderingState.js";

/** Seconds of camera stillness before (re)streaming a new ROI region. */
const ROI_SETTLE = 0.2;
/**
 * Milestone 1: only consult the visibility feedback once the camera has been still long enough for
 * the async vis-bin readback to reflect the current view — using it during motion is what made it
 * thrash.
 */
const ROI_HINT_SETTLE = 0.45;
/**
 * Minimum seconds a region is served before a *different* one is allowed to take over. Bin-level
 * hysteresis (see `visHintBin`) alone doesn't stop ping-ponging between two-or-more genuinely
 * important, comparably-visible regions when zoomed out over a wide view: once a brick loads for
 * region A, `residentLevelOf` reports it as covered, so A's own priority correctly drops toward 0 -
 * but that just hands the "most under-served" crown to region B. Once B's brick replaces A's (only one
 * brick is resident at a time), A's bins revert to reporting the coarse level again and A's priority
 * comes back - so without a cooldown the two regions volley forever, never letting either be looked at.
 * This grace period breaks that: once a region starts loading, nothing else can preempt it for a while,
 * even if a different bin would otherwise "win" on priority.
 */
const MIN_REGION_SERVE = 3;

export interface ResidencyDeps {
  device: GPUDevice;
  supportsFloat32Filtering: boolean;
  /** The current dataset; called live each frame (the viewer may reopen a different dataset). */
  getSource(): VolumeSource;
  /** Volume size in sim units. A stable `Vec3`-like reference, mutated in place as data loads. */
  sizeSim: { x: number; y: number; z: number };
  /** Currently displayed (coarse) LOD level; called live (changes on LOD switch). */
  getLevel(): number;
  /** Overall bounding extent in sim units; called live (changes when a new dataset loads). */
  getFrameExtent(): number;
  /** The coarse level's march step (sim units); called live. */
  getBaseStep(): number;
  /** Publish the fine march step derived from the resident brick's voxel size (`undefined` when none). */
  setBrickStep(step: number | undefined): void;
  /** GPU max 3D texture dimension, for `chooseBrickRegion`'s level-fit check. */
  maxTex: number;
  camera: Node;
  controls: OrbitControls;
  cropping: WebGpuCroppingState;
  volumeRenderer: VolumeRenderer;
  /** Scratch matrices reused across the render path (allocation-free, mutated in place). */
  invViewProj: Mat4;
  lastViewProj: Mat4;
  sim: units.UnitSystem;
  applyRender(): void;
  renderUi(): void;
  /** Called whenever the streamed-chunk progress changes (including back to `null` when idle). */
  notifyProgress(progress: { loaded: number; total: number } | null): void;
}

export class ResidencyController {
  private readonly deps: ResidencyDeps;
  private readonly brickLoader: BrickLoader;

  private enabled = false;
  private brickBlendCurrent = 0;
  private brickBlendTarget = 0;
  private brickLevelValue: number | undefined;
  private lastRoiKey = "";
  private lastRegion:
    | { level: number; voxelMin: [number, number, number]; voxelMax: [number, number, number] }
    | null = null;
  private roiIdle = 0;
  /** Seconds since the current region (`lastRoiKey`) started being requested/served. See MIN_REGION_SERVE. */
  private regionServedFor = 0;
  private roiRequestInFlight = false; // a brick request is streaming (drives the reset guard + progress bar)
  private roiReqSeq = 0; // monotonic id so a superseded request's finally() can't clobber a newer one
  private prevRoiCam: CameraPoseLike;
  private progressValue: { loaded: number; total: number } | null = null;
  /**
   * Sticky visibility-hint bin (Milestone 1), + the priority it had when picked. The vis-bin readback
   * is a periodically-cleared rolling window (see `VisibilityFeedback.recordCopy`'s readback cadence),
   * and each window's rays are sub-pixel jittered by TAAU — for a genuinely still camera this still
   * shifts bin weights slightly window to window, which (especially zoomed out, where many bins have
   * similar modest weight) can flip which bin ranks #1. Without stickiness that flip evicts the just-
   * loaded brick and starts fetching the new "top" bin's region instead — repeating forever, never
   * covering the whole zoomed-out view. Only switch when a new bin's priority clearly beats the current
   * one, not merely edges it out.
   */
  private visHintBin: { x: number; y: number; z: number; priority: number } | undefined;

  public constructor(deps: ResidencyDeps) {
    this.deps = deps;
    this.prevRoiCam = deps.controls.getState();
    this.brickLoader = new BrickLoader(deps.device, {
      supportsFloat32Filtering: deps.supportsFloat32Filtering,
    });

    this.brickLoader.onBrick((b: BrickResult) => {
      const { deps: d } = this;
      d.volumeRenderer.setBrick(b.texture, b.worldMin, b.worldMax);
      this.brickLevelValue = b.level;
      // March at the brick's voxel size (floored so the step count stays well under maxSteps and the
      // ray still reaches the far face) instead of the coarse level's — otherwise the fine brick is
      // under-sampled and looks sparse/blank when zoomed in.
      const [bsx, bsy, bsz] = d.getSource().spacingAt(b.level);
      d.setBrickStep(
        Math.max(
          Math.max(
            units.toSim(new units.Quantity(bsx, units.LENGTH), d.sim),
            units.toSim(new units.Quantity(bsy, units.LENGTH), d.sim),
            units.toSim(new units.Quantity(bsz, units.LENGTH), d.sim),
          ) * 0.55,
          d.getFrameExtent() / 2000,
          // Perf cap: never shrink the GLOBAL step more than ~2.9× vs coarse (the fine step is
          // marched across the whole ray, so an unbounded fine step explodes the step count).
          d.getBaseStep() * 0.35,
        ),
      );
      d.applyRender();
      this.brickBlendTarget = 1;
      d.renderUi();
    });
    this.brickLoader.onClear(() => {
      const { deps: d } = this;
      d.volumeRenderer.setBrick(null);
      this.brickLevelValue = undefined;
      d.setBrickStep(undefined);
      d.applyRender();
      this.setProgress(null);
      d.renderUi();
    });
    this.brickLoader.onProgress((loaded, total) => {
      this.setProgress({ loaded, total });
    });
  }

  public get isEnabled(): boolean {
    return this.enabled;
  }

  /** Toggle ROI streaming. Turning off does not clear the resident brick immediately — it fades
   * out on the next few frames' {@link update} calls, same as zooming out. */
  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** The currently resident brick's LOD level, or `undefined` when no brick is resident. */
  public get brickLevel(): number | undefined {
    return this.brickLevelValue;
  }

  public get progress(): { loaded: number; total: number } | null {
    return this.progressValue;
  }

  /** Seconds since the camera last moved (used by the viewer's adaptive-sampling easing too). */
  public get idle(): number {
    return this.roiIdle;
  }

  /** `true` while the resident brick's blend weight is still easing toward its target. */
  public get isFading(): boolean {
    return this.brickBlendCurrent !== this.brickBlendTarget;
  }

  /** Estimated GPU bytes held by the currently resident ROI brick texture, or 0 when none is
   * resident. Phase 4c hardening: feeds `getMemoryStats()`'s `gpuBrickBytes`. */
  public get brickBytes(): number {
    return this.brickLoader.currentBrick?.texture.sizeBytes ?? 0;
  }

  private setProgress(p: { loaded: number; total: number } | null): void {
    this.progressValue = p;
    this.deps.notifyProgress(p);
  }

  /** Forget the resident request key — call when the dataset changes (a new brick loader session). */
  public resetRequestTracking(): void {
    this.lastRoiKey = "";
    this.lastRegion = null;
    this.visHintBin = undefined;
    this.regionServedFor = 0;
  }

  /**
   * Immediately drop the resident brick (no fade) and forget the request key — call when switching
   * to a different dataset, since the old brick's content belongs to the old volume.
   */
  public clearForNewDataset(): void {
    this.brickLoader.clear();
    this.resetRequestTracking();
  }

  /**
   * Per-frame ROI update: derive the region (crop override, else frustum when zoomed in), pick the
   * finest fitting level, and (debounced) request the brick; hysteresis + fade drive smooth zoom-out.
   */
  public update(dt: number): void {
    const { deps: d } = this;
    const cs = d.controls.getState();
    if (!camsEqual(cs, this.prevRoiCam)) {
      this.roiIdle = 0;
      this.prevRoiCam = cs;
    } else {
      this.roiIdle += dt;
    }
    this.regionServedFor += dt;

    let want = 0; // brick blend target this frame (a loaded brick is on screen)
    let desired = false; // we intend to keep a high-res brick this frame (a finer region applies)
    if (this.enabled) {
      const source = d.getSource();
      const level = d.getLevel();
      const sizeSim = d.sizeSim;
      const cropping = d.cropping;
      const cropSet = cropIsSet(cropping.cropMin, cropping.cropMax);
      // Crop box overrides the focal box; otherwise use the depth-bounded frustum slab.
      const roi: { min: [number, number, number]; max: [number, number, number] } | null = cropSet
        ? {
            min: [cropping.cropMin[0], cropping.cropMin[1], cropping.cropMin[2]],
            max: [cropping.cropMax[0], cropping.cropMax[1], cropping.cropMax[2]],
          }
        : focalRoiUvw(d.invViewProj, d.lastViewProj, sizeSim, d.camera.position);
      if (roi) {
        const vis = d.volumeRenderer.visibility;
        let visHint: { min: [number, number, number]; max: [number, number, number] } | undefined;
        if (vis.enabled && this.roiIdle >= ROI_HINT_SETTLE) {
          const ranked = rankVisibilityBins(vis.lastQuantized, vis.grid, {
            levelCount: source.levelCount,
            boxExtent: Math.max(sizeSim.x, sizeSim.y, sizeSim.z),
            eye: [d.camera.position.x, d.camera.position.y, d.camera.position.z],
            boxHalf: [sizeSim.x * 0.5, sizeSim.y * 0.5, sizeSim.z * 0.5],
            residentLevelOf: (x, y, z) => {
              const box = visBinUvwBox(x, y, z, vis.grid);
              const cx = (box.min[0] + box.max[0]) * 0.5;
              const cy = (box.min[1] + box.max[1]) * 0.5;
              const cz = (box.min[2] + box.max[2]) * 0.5;
              const brick = this.brickLoader.currentBrick;
              if (brick) {
                const wx = cx * sizeSim.x - sizeSim.x * 0.5;
                const wy = cy * sizeSim.y - sizeSim.y * 0.5;
                const wz = cz * sizeSim.z - sizeSim.z * 0.5;
                if (
                  wx >= brick.worldMin[0] && wx <= brick.worldMax[0] &&
                  wy >= brick.worldMin[1] && wy <= brick.worldMax[1] &&
                  wz >= brick.worldMin[2] && wz <= brick.worldMax[2]
                ) {
                  return brick.level;
                }
              }
              return level;
            },
          });
          // Sticky pick: keep the currently-hinted bin unless a new one clearly beats it (>1.5x its
          // priority) or it's no longer a real candidate at all (fell out of the ranked list / priority
          // dropped to 0, e.g. the resident brick now actually covers it). See visHintBin's doc comment.
          const sticky = this.visHintBin
            ? ranked.find((b) => b.x === this.visHintBin!.x && b.y === this.visHintBin!.y && b.z === this.visHintBin!.z)
            : undefined;
          const challenger = ranked[0];
          const top =
            sticky && (!challenger || challenger.priority <= sticky.priority * 1.5) ? sticky : challenger;
          this.visHintBin = top ? { x: top.x, y: top.y, z: top.z, priority: top.priority } : undefined;
          if (top && top.priority > 0) {
            const box = visBinUvwBox(top.x, top.y, top.z, vis.grid);
            const pad = 0.05;
            visHint = {
              min: [
                Math.max(0, box.min[0] - pad),
                Math.max(0, box.min[1] - pad),
                Math.max(0, box.min[2] - pad),
              ],
              max: [
                Math.min(1, box.max[0] + pad),
                Math.min(1, box.max[1] + pad),
                Math.min(1, box.max[2] + pad),
              ],
            };
          }
        }
        // Region to stream = the stable frustum/crop box (uniform coverage over the whole visible
        // slab). Milestone 1's visibility feedback does NOT replace it (a single resident brick
        // can't chase a per-bin hint without thrash/eviction); instead `visHint` steers the shrink
        // below toward the most-looked-at sub-region when the box is too big to admit a finer level.
        const regionBox = roi;
        const regionOpts = { maxTextureDimension: d.maxTex };
        let region = chooseBrickRegion(source, regionBox.min, regionBox.max, regionOpts);
        // If the generous box is too big for a finer-than-displayed level (typical when the far
        // frustum inflates from one viewing side), shrink toward the box center until one fits.
        if (!(region && region.level < level)) {
          // Shrink toward the most-looked-at sub-region (visibility hint) when we have one, else the
          // box centre. Clamp into the box so the shrink stays valid. This is the ray-guided part of
          // M1: when the visible slab is too big for a finer level, prioritise the detail the user
          // is fixated on.
          const clampToBox = (v: number, a: number): number =>
            Math.min(regionBox.max[a]!, Math.max(regionBox.min[a]!, v));
          const cu: [number, number, number] = visHint
            ? [
                clampToBox((visHint.min[0] + visHint.max[0]) * 0.5, 0),
                clampToBox((visHint.min[1] + visHint.max[1]) * 0.5, 1),
                clampToBox((visHint.min[2] + visHint.max[2]) * 0.5, 2),
              ]
            : [
                (regionBox.min[0] + regionBox.max[0]) * 0.5,
                (regionBox.min[1] + regionBox.max[1]) * 0.5,
                (regionBox.min[2] + regionBox.max[2]) * 0.5,
              ];
          let mn: [number, number, number] = [regionBox.min[0], regionBox.min[1], regionBox.min[2]];
          let mx: [number, number, number] = [regionBox.max[0], regionBox.max[1], regionBox.max[2]];
          for (let k = 0; k < 8 && !(region && region.level < level); k++) {
            for (let a = 0; a < 3; a++) {
              mn[a] = cu[a]! + (mn[a]! - cu[a]!) * 0.7;
              mx[a] = cu[a]! + (mx[a]! - cu[a]!) * 0.7;
            }
            region = chooseBrickRegion(source, mn, mx, regionOpts);
          }
        }
        // Engage whenever a finer-than-displayed level fits the focal box (no zoom threshold — the
        // depth-bounded box only admits a finer level once you're zoomed in enough for it to fit).
        if (region && region.level < level) {
          desired = true; // a finer region applies → hold onto its request key across the load
          const dims = source.dimensionsAt(region.level);
          // Snap the voxel box to a grid so sub-voxel camera drift doesn't re-request (and abort)
          // the brick every frame; the ROI only changes when it moves by ≥ Q voxels.
          const Q = 32;
          const voxelMin: [number, number, number] = [0, 0, 0];
          const voxelMax: [number, number, number] = [0, 0, 0];
          for (let a = 0; a < 3; a++) {
            const dim = dims[a]!;
            voxelMin[a] = Math.max(0, Math.floor(region.voxelMin[a]! / Q) * Q);
            voxelMax[a] = Math.min(dim, Math.max(voxelMin[a] + Q, Math.ceil(region.voxelMax[a]! / Q) * Q));
          }
          // Skip if the resident brick (same level) already covers this box — small moves reuse it.
          const covered =
            this.lastRegion !== null &&
            this.lastRegion.level === region.level &&
            voxelMin[0] >= this.lastRegion.voxelMin[0] && voxelMin[1] >= this.lastRegion.voxelMin[1] &&
            voxelMin[2] >= this.lastRegion.voxelMin[2] && voxelMax[0] <= this.lastRegion.voxelMax[0] &&
            voxelMax[1] <= this.lastRegion.voxelMax[1] && voxelMax[2] <= this.lastRegion.voxelMax[2];
          const key = `${region.level}:${voxelMin.join(",")}:${voxelMax.join(",")}`;
          // (Re)stream a genuinely new, settled region. A newer region SUPERSEDES an in-flight one
          // (request() aborts the stale fetch), so the brick for where the user actually is loads
          // promptly instead of waiting out the old load. Finishing the stale brick first is what
          // made the high-res ROI briefly drop to coarse / go blank when moving mid-load. Same-key
          // requests are still blocked (key === lastRoiKey) and ROI_SETTLE debounces motion, so this
          // can't flood.
          // MIN_REGION_SERVE only gates a SWITCH away from an already-resident region (lastRoiKey !==
          // "") - the very first region for a fresh zoom-in must not wait out the cooldown.
          const cooledDown = this.lastRoiKey === "" || this.regionServedFor >= MIN_REGION_SERVE;
          if (!covered && key !== this.lastRoiKey && this.roiIdle >= ROI_SETTLE && cooledDown) {
            this.lastRoiKey = key;
            this.regionServedFor = 0;
            this.lastRegion = { level: region.level, voxelMin, voxelMax };
            const half = [sizeSim.x * 0.5, sizeSim.y * 0.5, sizeSim.z * 0.5];
            const full = [sizeSim.x, sizeSim.y, sizeSim.z];
            const wmin: [number, number, number] = [0, 0, 0];
            const wmax: [number, number, number] = [0, 0, 0];
            for (let a = 0; a < 3; a++) {
              wmin[a] = -half[a]! + (voxelMin[a] / dims[a]!) * full[a]!;
              wmax[a] = -half[a]! + (voxelMax[a] / dims[a]!) * full[a]!;
            }
            const reqId = ++this.roiReqSeq;
            this.roiRequestInFlight = true;
            void this.brickLoader
              .request({ source, level: region.level, voxelMin, voxelMax, worldMin: wmin, worldMax: wmax })
              .finally(() => {
                if (reqId !== this.roiReqSeq) return; // superseded — the newer request owns the flag + bar
                this.roiRequestInFlight = false;
                this.setProgress(null); // hide the bar once the latest stream settles (loaded / failed)
              });
          }
          if (this.brickLoader.currentBrick) want = 1;
        }
      }
    }
    // Forget the resident request key only when no brick is desired (ROI off / zoomed out) and
    // nothing is mid-flight — NOT merely because the brick isn't visible yet. Resetting while a
    // request was in flight made the loader re-request the same box on the frame it finished (and
    // endlessly retry a failed/aborted fetch), flooding the network and never settling on
    // higher-res detail.
    if (!desired && !this.roiRequestInFlight) {
      this.lastRoiKey = "";
      this.lastRegion = null;
      this.visHintBin = undefined; // don't let a stale hint bias where the next zoom-in starts
    }
    this.brickBlendTarget = want;

    // Fade the brick weight toward the target (~150 ms); clear once fully faded out.
    const diff = this.brickBlendTarget - this.brickBlendCurrent;
    this.brickBlendCurrent += Math.sign(diff) * Math.min(Math.abs(diff), 6 * dt);
    d.volumeRenderer.setBrickBlend(this.brickBlendCurrent);
    if (this.brickBlendCurrent <= 0.001 && this.brickBlendTarget === 0 && this.brickLoader.currentBrick) {
      this.brickLoader.clear();
    }
  }

  public dispose(): void {
    this.brickLoader.dispose();
  }
}
