/**
 * High-res ROI brick streaming: stream + composite up to 4 fine sub-volumes over the coarse base when
 * zoomed in (or a crop ROI is set), and fade each out / evict on zoom-out (item 9 stage 9b — replaces
 * the single-`BrickLoader`/single-dedicated-texture model with a shared `BrickAtlas` + `BrickPageTable`
 * and a `BrickPriorityPolicy` picking which visibility-feedback bins back the non-primary slots). The
 * viewer calls {@link ResidencyController.update} once per frame and reads `brickLevel`/`progress` for
 * the HUD.
 *
 * One key design choice: the *primary* region (today's frustum/crop-box selection, with its heavily
 * anti-thrash-tuned hysteresis/cooldown/covered-check logic) is completely unchanged from stage 9a —
 * only its destination changed (a `BrickAtlas` slot instead of a dedicated texture). Up to 3 *secondary*
 * regions, sourced from `DefaultBrickPriorityPolicy` over the same ranked visibility bins the primary's
 * own hint already computes, are requested with simpler logic (settle-gate + key-level dedup only, no
 * separate cooldown/hysteresis) since they're a bonus enhancement, not the path most users' interaction
 * depends on. Every resident region (primary or secondary) is tracked uniformly in one `resident` map
 * keyed by its own region key, diffed against what's desired each frame — whichever physical atlas slot
 * `BrickPageTable.acquire()` hands back for a key is used directly, with no separate "logical slot"
 * indirection.
 *
 * @packageDocumentation
 */

import { units } from "@zarr-viewer/core";
import {
  rankVisibilityBins,
  visBinUvwBox,
  BrickPageTable,
  BrickAtlas,
  DefaultBrickPriorityPolicy,
  ATLAS_SLOT_SIZE,
  ATLAS_FORMAT,
  chooseAtlasBrickRegion,
  uploadRegionToAtlasSlot,
  type BrickKey,
  type BrickPriorityPolicy,
  type RankedBin,
  type VolumeRenderer,
} from "@zarr-viewer/render";
import type { VolumeSource } from "@zarr-viewer/io";
import type { Node } from "@zarr-viewer/scene";
import type { OrbitControls } from "@zarr-viewer/controls";
import type { Mat4 } from "@zarr-viewer/math";
import { cropIsSet, focalRoiUvw } from "./roi-geometry.js";
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
 * Minimum seconds the *primary* region is served before a *different* one is allowed to take over.
 * Bin-level hysteresis (see `visHintBin`) alone doesn't stop ping-ponging between two-or-more genuinely
 * important, comparably-visible regions when zoomed out over a wide view: once a brick loads for
 * region A, `residentLevelOf` reports it as covered, so A's own priority correctly drops toward 0 -
 * but that just hands the "most under-served" crown to region B. Once B's brick replaces A's, A's bins
 * revert to reporting the coarse level again and A's priority comes back - so without a cooldown the
 * two regions volley forever, never letting either be looked at. This grace period breaks that: once a
 * region starts loading, nothing else can preempt it for a while, even if a different bin would
 * otherwise "win" on priority. Secondary slots don't need this — with 3 of them plus the primary, there
 * isn't the same single-resource contention that caused the ping-pong in the first place.
 */
const MIN_REGION_SERVE = 3;

/** Number of simultaneously-resident brick slots (item 9's explicit N=4 choice). */
const SLOT_COUNT = 4;

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
  /** GPU max 3D texture dimension — kept for interface compatibility with other consumers; no longer
   * read by this controller (atlas slot size is fixed, see `ATLAS_SLOT_SIZE`). */
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
  /**
   * Schedule a plain repaint (no side effects) — unlike `applyRender()`, this does NOT call
   * `markInteracting()` (resets `interactionIdle`, one of the render loop's `settled` gates) or
   * `taau.reset()` (restarts temporal accumulation). Item 9 stage 9b: a secondary brick slot landing
   * doesn't change any render params (only `applyRender()`'s `setBrickStep`-driven primary path does),
   * so it only needs a redraw — calling the heavier `applyRender()` for every one of up to 3
   * independent, undebounced secondary completions kept knocking `settled` back to false (and TAAU back
   * to sample 0) well more often than the primary's own occasional, ROI_SETTLE-debounced brick loads
   * ever did, which is what made half-res lighting (gated on `!settled`) visibly flicker on/off/on/off
   * whenever ROI streaming was active.
   */
  requestRender(): void;
  renderUi(): void;
  /** Called whenever the streamed-chunk progress changes (including back to `null` when idle). */
  notifyProgress(progress: { loaded: number; total: number } | null): void;
}

/** One resident (or in-flight) brick region, uniformly tracked regardless of whether it's the primary
 * region or a secondary (visibility-policy-sourced) one. */
interface SlotEntry {
  physicalSlot: number;
  level: number;
  worldMin: [number, number, number];
  worldMax: [number, number, number];
  blendCurrent: number;
  blendTarget: number;
  abort: AbortController | undefined;
  reqSeq: number;
  inFlight: boolean;
  /** True once at least one upload has landed (so `setBrickSlot` has real geometry to show). */
  loaded: boolean;
}

export class ResidencyController {
  private readonly deps: ResidencyDeps;
  private readonly pageTable: BrickPageTable;
  private readonly atlas: BrickAtlas;
  private readonly policy: BrickPriorityPolicy;

  private enabled = false;
  /** Region key of the primary (frustum/crop) region, `""` when none. Distinct from `resident`'s keys
   * in that this drives the primary's own selection/cooldown logic; `resident` tracks GPU state. */
  private lastRoiKey = "";
  private lastRegion:
    | { level: number; voxelMin: [number, number, number]; voxelMax: [number, number, number] }
    | null = null;
  private roiIdle = 0;
  /** Seconds since the primary region (`lastRoiKey`) started being requested/served. See MIN_REGION_SERVE. */
  private regionServedFor = 0;
  private roiRequestInFlight = false; // the primary brick request is streaming (drives the reset guard + progress bar)
  private roiReqSeq = 0; // monotonic id so a superseded primary request's finally() can't clobber a newer one
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

  /**
   * Sticky per-seat secondary bin picks (item 9 stage 9b), one seat per non-primary atlas slot —
   * exactly the same stickiness `visHintBin` above gives the primary, and for the same reason: the
   * vis-bin readback jitters slightly frame to frame even on a still camera, and without stickiness a
   * seat's "top remaining" pick flips between comparably-ranked bins constantly. Each flip means a
   * different region key, which means evicting the old atlas slot and starting a brand-new fetch for
   * the new one — a `DefaultBrickPriorityPolicy.selectSecondary` call alone (no memory of the previous
   * frame's picks) reproduces exactly the single-slot ping-pong `visHintBin`'s own doc comment already
   * describes, just across 3 slots at once, which is what caused real flicker + a flood of `renderUi()`
   * calls (rebuilding the sidebar) when this was first wired up without this stickiness.
   */
  private readonly stickySecondary: (RankedBin | undefined)[] = [undefined, undefined, undefined];

  /** Every currently resident-or-loading brick region (primary and secondary alike), keyed by its own
   * region key (`${level}:${voxelMin}:${voxelMax}`). */
  private readonly resident = new Map<BrickKey, SlotEntry>();
  /** The primary region's latest requested/intended key — set the moment a new primary region is
   * chosen, before its upload has necessarily finished. Distinct from {@link displayedPrimaryKey} (see
   * its own doc comment for why the two must NOT be collapsed into one field). */
  private primaryKey: BrickKey | undefined;
  /**
   * Which `resident` key is actually being shown as the primary brick right now — used by
   * `brickLevel`/HUD and, critically, kept in the diff pass's desired-key set alongside `primaryKey`
   * itself for as long as the two differ. Without this distinction, switching `primaryKey` to a new
   * region (e.g. as the camera pans) would immediately drop the OLD, still-displayed brick out of the
   * desired set — before the new one has actually finished loading — so the diff pass would fade the
   * old one to nothing while the replacement was still in flight, a visible pop back to coarse-only
   * that reappears once the new brick lands. (Pre-9b's single-`BrickLoader` model never had this gap:
   * the old texture stayed bound until `onBrick` fired for the new one, an atomic swap with no visible
   * hole.) `displayedPrimaryKey` only moves to the new key once its upload actually resolves (see
   * `streamIntoResident`'s `.then()`), so the old brick keeps rendering the whole time the new one
   * streams in, and only starts fading once the handoff is complete.
   */
  private displayedPrimaryKey: BrickKey | undefined;

  public constructor(deps: ResidencyDeps) {
    this.deps = deps;
    this.pageTable = new BrickPageTable(SLOT_COUNT);
    // 2x2x1 grid of slots — an arbitrary but reasonable factoring of 4 slots into a 3D atlas texture
    // (any factoring works; slot addressing is purely by voxel origin, never assumes a particular grid
    // shape). r16float matches BrickLoader's typical previous per-brick format.
    this.atlas = new BrickAtlas(deps.device, 2, 2, 1, ATLAS_SLOT_SIZE, ATLAS_FORMAT);
    this.policy = new DefaultBrickPriorityPolicy();
    deps.volumeRenderer.setBrickAtlas(this.atlas.texture, ATLAS_SLOT_SIZE);
  }

  public get isEnabled(): boolean {
    return this.enabled;
  }

  /** Toggle ROI streaming. Turning off does not clear resident bricks immediately — they fade
   * out on the next few frames' {@link update} calls, same as zooming out. */
  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** The primary region's LOD level, or `undefined` when no brick is resident there. Reads
   * `displayedPrimaryKey` (what's actually shown), not `primaryKey` (what's been requested but may
   * still be loading) — see `displayedPrimaryKey`'s doc comment. */
  public get brickLevel(): number | undefined {
    if (!this.displayedPrimaryKey) return undefined;
    return this.resident.get(this.displayedPrimaryKey)?.level;
  }

  public get progress(): { loaded: number; total: number } | null {
    return this.progressValue;
  }

  /** Seconds since the camera last moved (used by the viewer's adaptive-sampling easing too). */
  public get idle(): number {
    return this.roiIdle;
  }

  /** `true` while any resident brick's blend weight is still easing toward its target. */
  public get isFading(): boolean {
    for (const e of this.resident.values()) {
      if (e.blendCurrent !== e.blendTarget) return true;
    }
    return false;
  }

  /** Estimated GPU bytes held by the shared brick atlas. Phase 4c hardening: feeds `getMemoryStats()`'s
   * `gpuBrickBytes`. Stage 9b note: unlike the old per-brick dedicated texture (0 bytes when none
   * resident), the atlas is one fixed allocation for this controller's whole lifetime — this now
   * reports that fixed total rather than a residency-dependent figure, which is the more accurate
   * "GPU bytes actually held" answer now that the allocation itself doesn't come and go. */
  public get brickBytes(): number {
    return this.atlas.texture.sizeBytes;
  }

  private setProgress(p: { loaded: number; total: number } | null): void {
    this.progressValue = p;
    this.deps.notifyProgress(p);
  }

  /** Forget the resident request key — call when the dataset changes (a new streaming session). */
  public resetRequestTracking(): void {
    this.lastRoiKey = "";
    this.lastRegion = null;
    this.visHintBin = undefined;
    this.stickySecondary.fill(undefined);
    this.regionServedFor = 0;
  }

  /**
   * Immediately drop every resident brick (no fade) and forget the request key — call when switching
   * to a different dataset, since the old bricks' content belongs to the old volume.
   */
  public clearForNewDataset(): void {
    for (const [key, e] of this.resident) {
      e.abort?.abort();
      this.pageTable.release(key);
      this.deps.volumeRenderer.setBrickSlot(e.physicalSlot as 0 | 1 | 2 | 3, null);
    }
    this.resident.clear();
    this.primaryKey = undefined;
    this.displayedPrimaryKey = undefined;
    this.deps.setBrickStep(undefined);
    this.setProgress(null);
    this.resetRequestTracking();
  }

  /** Start (or restart, superseding any in-flight fetch for the same key) streaming `key`'s region
   * into whichever atlas slot the page table assigns. */
  private streamIntoResident(
    key: BrickKey,
    source: VolumeSource,
    level: number,
    voxelMin: [number, number, number],
    voxelMax: [number, number, number],
    worldMin: [number, number, number],
    worldMax: [number, number, number],
  ): void {
    const { deps: d } = this;
    const { slot: physicalSlot, evicted } = this.pageTable.acquire(key);
    if (evicted && evicted !== key) {
      const evictedEntry = this.resident.get(evicted);
      evictedEntry?.abort?.abort();
      this.resident.delete(evicted);
      if (this.primaryKey === evicted) this.primaryKey = undefined;
      if (this.displayedPrimaryKey === evicted) this.displayedPrimaryKey = undefined;
    }
    let entry = this.resident.get(key);
    if (!entry) {
      entry = {
        physicalSlot,
        level,
        worldMin,
        worldMax,
        blendCurrent: 0,
        blendTarget: 1,
        abort: undefined,
        reqSeq: 0,
        inFlight: false,
        loaded: false,
      };
      this.resident.set(key, entry);
    }
    entry.physicalSlot = physicalSlot;
    entry.abort?.abort();
    const ac = new AbortController();
    entry.abort = ac;
    const reqId = ++entry.reqSeq;
    entry.inFlight = true;
    const isPrimary = key === this.primaryKey;
    void uploadRegionToAtlasSlot(d.device, this.atlas, physicalSlot, source, level, voxelMin, voxelMax, {
      signal: ac.signal,
      onProgress: (loaded, total) => {
        if (isPrimary && reqId === entry!.reqSeq) this.setProgress({ loaded, total });
      },
    })
      .then(() => {
        if (reqId !== entry!.reqSeq || !this.resident.has(key)) return; // superseded or evicted mid-flight
        entry!.inFlight = false;
        entry!.loaded = true;
        entry!.level = level;
        entry!.worldMin = worldMin;
        entry!.worldMax = worldMax;
        entry!.blendTarget = 1;
        const atlasOrigin = this.atlas.slotVoxelOrigin(physicalSlot);
        d.volumeRenderer.setBrickSlot(physicalSlot as 0 | 1 | 2 | 3, { worldMin, worldMax, atlasOrigin });
        if (key === this.primaryKey) {
          // Only now — once the new primary's data has actually landed — does the display hand off
          // from whatever was previously shown. See `displayedPrimaryKey`'s doc comment: keeping the
          // old brick as "desired" (via the diff pass below) until this exact moment is what prevents
          // a visible gap back to coarse-only while a new primary region streams in.
          this.displayedPrimaryKey = key;
          // March at the brick's voxel size (floored so the step count stays well under maxSteps and
          // the ray still reaches the far face) instead of the coarse level's - otherwise the fine
          // brick is under-sampled and looks sparse/blank when zoomed in.
          const [bsx, bsy, bsz] = d.getSource().spacingAt(level);
          d.setBrickStep(
            Math.max(
              Math.max(
                units.toSim(new units.Quantity(bsx, units.LENGTH), d.sim),
                units.toSim(new units.Quantity(bsy, units.LENGTH), d.sim),
                units.toSim(new units.Quantity(bsz, units.LENGTH), d.sim),
              ) * 0.55,
              d.getFrameExtent() / 2000,
              // Perf cap: never shrink the GLOBAL step more than ~2.9x vs coarse (the fine step is
              // marched across the whole ray, so an unbounded fine step explodes the step count).
              d.getBaseStep() * 0.35,
            ),
          );
          this.setProgress(null);
          // renderUi() rebuilds the WHOLE sidebar (it's how the "ROI L{level}" status line and the
          // progress bar refresh) - fine for the primary's own, relatively rare load-completion event,
          // but calling it per-secondary-slot too would rebuild the sidebar up to 3x as often (once per
          // independent secondary stream), fighting any in-progress user interaction with the panel
          // (focus, scroll, an open <details>) purely because a slot the HUD doesn't even display
          // anything about just finished loading. Secondaries only need the canvas to repaint.
          d.renderUi();
          // applyRender() re-pushes stepSize (which just changed, above) into the renderer and restarts
          // TAAU accumulation to match - legitimate here since the sampling grid actually changed.
          d.applyRender();
        } else {
          // A secondary slot changed no render params - just repaint, without applyRender()'s side
          // effects (see `ResidencyDeps.requestRender`'s doc comment for why those matter here).
          d.requestRender();
        }
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted || (err as { name?: string })?.name === "AbortError") return; // superseded
        console.warn(`ResidencyController: brick region ${key} failed to upload:`, err);
        if (reqId === entry!.reqSeq) {
          entry!.inFlight = false;
          if (key === this.primaryKey) this.setProgress(null);
        }
      });
  }

  /**
   * Pick this frame's secondary bins, one per `stickySecondary` seat, applying the same "only switch
   * when a challenger clearly beats the sticky pick" hysteresis `visHintBin` uses for the primary (see
   * `stickySecondary`'s own doc comment for why this is necessary, not optional polish). Each seat is
   * resolved independently, greedily consuming `DefaultBrickPriorityPolicy`'s ranked candidate pool
   * (excluding the primary's own bin) so no two seats ever pick the same bin.
   */
  private pickStickySecondaryBins(ranked: readonly RankedBin[]): RankedBin[] {
    // Full candidate pool (already rank-ordered, primary excluded), not capped to SLOT_COUNT - 1 -
    // each seat below picks from whatever's left after earlier seats claimed theirs.
    const candidates = this.policy.selectSecondary(ranked, {
      maxCount: ranked.length,
      primary: this.visHintBin,
    });
    const used = new Set<string>();
    const binKey = (b: { x: number; y: number; z: number }): string => `${b.x},${b.y},${b.z}`;
    const result: RankedBin[] = [];
    for (let seat = 0; seat < this.stickySecondary.length; seat++) {
      const sticky = this.stickySecondary[seat];
      const stillValid = sticky
        ? candidates.find((c) => c.x === sticky.x && c.y === sticky.y && c.z === sticky.z && !used.has(binKey(c)))
        : undefined;
      const challenger = candidates.find((c) => !used.has(binKey(c)));
      const pick =
        stillValid && (!challenger || challenger.priority <= stillValid.priority * 1.5)
          ? stillValid
          : challenger;
      this.stickySecondary[seat] = pick;
      if (pick) {
        used.add(binKey(pick));
        result.push(pick);
      }
    }
    return result;
  }

  /**
   * Per-frame ROI update: derive the primary region (crop override, else frustum when zoomed in), pick
   * the finest fitting level, and (debounced) request the brick; hysteresis + fade drive smooth
   * zoom-out. Also derives up to `SLOT_COUNT - 1` secondary regions from the visibility-feedback policy.
   */
  public update(dt: number): void {
    const { deps: d } = this;
    // controls.isAnimating (normalized directions + relative distance error) is the scale-independent
    // "is the camera still" signal — see the class-level history in this file's git blame for why a raw
    // camera-pose comparison was replaced with this.
    if (d.controls.isAnimating) {
      this.roiIdle = 0;
    } else {
      this.roiIdle += dt;
    }
    this.regionServedFor += dt;

    // Whether a finer-than-displayed primary region applies at all this frame (ROI on, zoomed in
    // enough) — distinct from *which* key is desired, since `primaryKey`/`displayedPrimaryKey` can
    // differ mid-transition (see `displayedPrimaryKey`'s doc comment).
    let primaryDesired = false;
    let ranked: RankedBin[] = [];
    let sizeSim = d.sizeSim;
    let source: VolumeSource | undefined;
    let level = 0;
    if (this.enabled) {
      source = d.getSource();
      level = d.getLevel();
      sizeSim = d.sizeSim;
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
          ranked = rankVisibilityBins(vis.lastQuantized, vis.grid, {
            levelCount: source.levelCount,
            boxExtent: Math.max(sizeSim.x, sizeSim.y, sizeSim.z),
            eye: [d.camera.position.x, d.camera.position.y, d.camera.position.z],
            boxHalf: [sizeSim.x * 0.5, sizeSim.y * 0.5, sizeSim.z * 0.5],
            residentLevelOf: (x, y, z) => {
              const box = visBinUvwBox(x, y, z, vis.grid);
              const cx = (box.min[0] + box.max[0]) * 0.5;
              const cy = (box.min[1] + box.max[1]) * 0.5;
              const cz = (box.min[2] + box.max[2]) * 0.5;
              const wx = cx * sizeSim.x - sizeSim.x * 0.5;
              const wy = cy * sizeSim.y - sizeSim.y * 0.5;
              const wz = cz * sizeSim.z - sizeSim.z * 0.5;
              for (const e of this.resident.values()) {
                if (!e.loaded) continue;
                if (
                  wx >= e.worldMin[0] && wx <= e.worldMax[0] &&
                  wy >= e.worldMin[1] && wy <= e.worldMax[1] &&
                  wz >= e.worldMin[2] && wz <= e.worldMax[2]
                ) {
                  return e.level;
                }
              }
              return level;
            },
          });
          // Sticky pick: keep the currently-hinted bin unless a new one clearly beats it (>1.5x its
          // priority) or it's no longer a real candidate at all (fell out of the ranked list / priority
          // dropped to 0, e.g. a resident brick now actually covers it). See visHintBin's doc comment.
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
        // slab). Milestone 1's visibility feedback does NOT replace it (the primary slot can't chase a
        // per-bin hint without thrash/eviction); instead `visHint` steers the shrink below toward the
        // most-looked-at sub-region when the box is too big to admit a finer level.
        const regionBox = roi;
        let region = chooseAtlasBrickRegion(source, regionBox.min, regionBox.max, ATLAS_SLOT_SIZE);
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
            region = chooseAtlasBrickRegion(source, mn, mx, ATLAS_SLOT_SIZE);
          }
        }
        // Engage whenever a finer-than-displayed level fits the focal box (no zoom threshold — the
        // depth-bounded box only admits a finer level once you're zoomed in enough for it to fit).
        if (region && region.level < level) {
          const { level: rLevel, voxelMin, voxelMax } = region;
          const dims = source.dimensionsAt(rLevel);
          // Skip if the resident primary region (same level) already covers this box — small moves
          // reuse it.
          const covered =
            this.lastRegion !== null &&
            this.lastRegion.level === rLevel &&
            voxelMin[0] >= this.lastRegion.voxelMin[0] && voxelMin[1] >= this.lastRegion.voxelMin[1] &&
            voxelMin[2] >= this.lastRegion.voxelMin[2] && voxelMax[0] <= this.lastRegion.voxelMax[0] &&
            voxelMax[1] <= this.lastRegion.voxelMax[1] && voxelMax[2] <= this.lastRegion.voxelMax[2];
          const key = `${rLevel}:${voxelMin.join(",")}:${voxelMax.join(",")}`;
          // (Re)stream a genuinely new, settled region. A newer region SUPERSEDES an in-flight one
          // (aborts the stale fetch), so the brick for where the user actually is loads promptly
          // instead of waiting out the old load. Same-key requests are still blocked and ROI_SETTLE
          // debounces motion, so this can't flood.
          // MIN_REGION_SERVE only gates a SWITCH away from an already-resident region (lastRoiKey !==
          // "") - the very first region for a fresh zoom-in must not wait out the cooldown.
          const cooledDown = this.lastRoiKey === "" || this.regionServedFor >= MIN_REGION_SERVE;
          if (!covered && key !== this.lastRoiKey && this.roiIdle >= ROI_SETTLE && cooledDown) {
            this.lastRoiKey = key;
            this.regionServedFor = 0;
            this.lastRegion = { level: rLevel, voxelMin, voxelMax };
            const half = [sizeSim.x * 0.5, sizeSim.y * 0.5, sizeSim.z * 0.5];
            const full = [sizeSim.x, sizeSim.y, sizeSim.z];
            const wmin: [number, number, number] = [0, 0, 0];
            const wmax: [number, number, number] = [0, 0, 0];
            for (let a = 0; a < 3; a++) {
              wmin[a] = -half[a]! + (voxelMin[a] / dims[a]!) * full[a]!;
              wmax[a] = -half[a]! + (voxelMax[a] / dims[a]!) * full[a]!;
            }
            this.primaryKey = key;
            this.roiRequestInFlight = true;
            const reqId = ++this.roiReqSeq;
            // `primaryKey` has moved on, but `displayedPrimaryKey` (whatever was shown before) is left
            // untouched here - the diff pass below keeps BOTH keys desired until this new one's upload
            // actually resolves and claims `displayedPrimaryKey` for itself (see streamIntoResident's
            // `.then()`), so the old brick keeps rendering the whole time this one streams in.
            this.streamIntoResident(key, source, rLevel, voxelMin, voxelMax, wmin, wmax);
            // Clear the in-flight flag once superseded-safe (mirrors the pre-9b request().finally()).
            Promise.resolve().then(() => {
              if (reqId === this.roiReqSeq) this.roiRequestInFlight = false;
            });
          } else {
            this.primaryKey = this.lastRoiKey || undefined;
          }
          primaryDesired = true;
        }
      }
    }
    if (!primaryDesired && !this.roiRequestInFlight) {
      this.lastRoiKey = "";
      this.lastRegion = null;
      this.visHintBin = undefined; // don't let a stale hint bias where the next zoom-in starts
      this.primaryKey = undefined;
    }

    // Secondary regions: next-highest-priority visibility bins beyond the primary, per the policy.
    // Only considered once settled (matches the primary's own ROI_SETTLE gate) and only when there's
    // room to spare beyond the primary slot.
    const desiredSecondaryKeys = new Set<BrickKey>();
    if (this.enabled && source && ranked.length > 0 && this.roiIdle >= ROI_SETTLE) {
      const secondaryBins = this.pickStickySecondaryBins(ranked);
      for (const bin of secondaryBins) {
        const box = visBinUvwBox(bin.x, bin.y, bin.z, d.volumeRenderer.visibility.grid);
        const region = chooseAtlasBrickRegion(source, box.min, box.max, ATLAS_SLOT_SIZE);
        if (!region || region.level >= level) continue; // no finer-than-displayed level fits this bin
        const dims = source.dimensionsAt(region.level);
        const key = `${region.level}:${region.voxelMin.join(",")}:${region.voxelMax.join(",")}`;
        if (key === this.primaryKey || key === this.displayedPrimaryKey) continue; // already served by the primary slot
        desiredSecondaryKeys.add(key);
        if (!this.resident.has(key)) {
          const half = [sizeSim.x * 0.5, sizeSim.y * 0.5, sizeSim.z * 0.5];
          const full = [sizeSim.x, sizeSim.y, sizeSim.z];
          const wmin: [number, number, number] = [0, 0, 0];
          const wmax: [number, number, number] = [0, 0, 0];
          for (let a = 0; a < 3; a++) {
            wmin[a] = -half[a]! + (region.voxelMin[a] / dims[a]!) * full[a]!;
            wmax[a] = -half[a]! + (region.voxelMax[a] / dims[a]!) * full[a]!;
          }
          this.streamIntoResident(key, source, region.level, region.voxelMin, region.voxelMax, wmin, wmax);
        }
      }
    } else if (!this.enabled || ranked.length === 0) {
      // No visibility feedback to steer secondaries this frame (ROI off, or the feedback pass itself is
      // off/not yet settled) — forget the sticky picks so a later zoom-in doesn't reuse bins from a
      // stale, unrelated view.
      this.stickySecondary.fill(undefined);
    }

    // Diff pass: fade out and (once fully faded) evict any resident region no longer desired this
    // frame (neither the primary keys nor a currently-selected secondary key).
    //
    // Primary note: BOTH `primaryKey` (the latest requested/intended region) and `displayedPrimaryKey`
    // (whatever's actually shown right now) stay desired here whenever `primaryDesired` is true, even
    // though they're often the same key. While they differ - a new primary region has been requested
    // but hasn't finished loading yet - this keeps the OLD brick fully visible (not fading) for the
    // whole transition, and only starts fading it once `displayedPrimaryKey` itself moves on to the new
    // key (see `streamIntoResident`'s `.then()`). Without this, the old brick would drop out of the
    // desired set - and start fading to nothing - the instant a new region was merely requested, well
    // before its replacement had any data to show, producing a visible flicker back to coarse-only on
    // every primary region change (reported after stage 9b shipped without this).
    const desiredKeys = new Set<BrickKey>(desiredSecondaryKeys);
    if (primaryDesired) {
      if (this.primaryKey) desiredKeys.add(this.primaryKey);
      if (this.displayedPrimaryKey) desiredKeys.add(this.displayedPrimaryKey);
    }
    for (const [key, entry] of this.resident) {
      entry.blendTarget = desiredKeys.has(key) ? 1 : 0;
      const diff = entry.blendTarget - entry.blendCurrent;
      entry.blendCurrent += Math.sign(diff) * Math.min(Math.abs(diff), 6 * dt);
      d.volumeRenderer.setBrickSlotBlend(entry.physicalSlot as 0 | 1 | 2 | 3, entry.blendCurrent);
      if (!desiredKeys.has(key) && entry.blendCurrent <= 0.001 && !entry.inFlight) {
        entry.abort?.abort();
        this.pageTable.release(key);
        d.volumeRenderer.setBrickSlot(entry.physicalSlot as 0 | 1 | 2 | 3, null);
        this.resident.delete(key);
        // brickStep tracks the DISPLAYED brick's fine march step, so it's cleared off
        // `displayedPrimaryKey`'s eviction, not `primaryKey`'s - the two can differ (e.g. the primary
        // was disabled/zoomed-out while a request was still in flight, so `primaryKey` was already
        // cleared by the earlier reset branch, but the old displayed brick is only evicted here, once
        // it finishes fading).
        if (key === this.displayedPrimaryKey) {
          this.displayedPrimaryKey = undefined;
          d.setBrickStep(undefined);
        }
        if (key === this.primaryKey) this.primaryKey = undefined;
      }
    }
  }

  public dispose(): void {
    for (const e of this.resident.values()) e.abort?.abort();
    this.resident.clear();
    this.atlas.dispose();
  }
}
