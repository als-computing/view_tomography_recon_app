/**
 * Camera controllers: orbit (turntable), fly, and first-person. Frame-rate-independent with damping.
 *
 * @packageDocumentation
 */

import { Mat4, Quat, Vec3 } from "@zarr-viewer/math";
import type { Node } from "@zarr-viewer/scene";
import { InputMap } from "./input-map.js";

/** Shared controller contract. */
export interface Controller {
  /** Advance the controller, applying input to its target. */
  update(dt: number): void;
  /** Release listeners/resources. */
  dispose(): void;
}

/**
 * How {@link OrbitControls} maps vertical drag to rotation.
 *
 * - `"trackball"` (default): free tumble — you can rotate over the poles with no hard stop.
 * - `"turntable"`: classic azimuth/elevation with a Y-up lock and elevation clamps.
 */
export type OrbitMode = "trackball" | "turntable";

/**
 * Full, trackball-accurate snapshot of an {@link OrbitControls} pose. Unlike the derived
 * azimuth/elevation readouts, this captures the raw orbit offset and tumbling gaze-up so a pose can
 * be copied between controllers (e.g. linked split panes) without losing roll. All vectors are plain
 * `[x, y, z]` triples so the state is JSON-safe.
 */
export interface OrbitState {
  target: [number, number, number];
  offset: [number, number, number];
  gazeUp: [number, number, number];
  distance: number;
}

/**
 * Orbit controls: rotate/zoom/pan around a target point. Ideal for inspecting datasets.
 *
 * Default {@link OrbitControls.mode} is `"trackball"` (screen-space tumble of the camera offset),
 * which has no polar gimbal lock. Use `"turntable"` when you want a locked world-up horizon.
 *
 * Pointer drag (left) orbits; right / middle / Shift|Alt|Space+left pans. Wheel zooms (toward the
 * cursor when {@link OrbitControls.zoomToCursor} is on). Trackpad: horizontal swipe or Shift+wheel
 * pans; pinch (Ctrl+wheel) zooms. The camera node's position and rotation are updated each
 * {@link OrbitControls.update} so the renderer can invert the world matrix into a view matrix.
 *
 * @example
 * ```ts
 * const controls = new OrbitControls(cameraNode, canvas);
 * controls.target.set(0, 0, 0);
 * controls.update(dt);
 * ```
 */
export class OrbitControls implements Controller {
  /** Point the camera orbits around. */
  public readonly target = new Vec3(0, 0, 0);
  /** Spherical distance from the target (m). */
  public distance = 5;
  /**
   * Azimuth around Y (radians). Derived each frame from the offset; writable only as a convenience
   * for turntable mode / readouts.
   */
  public azimuth = 0;
  /**
   * Elevation from the XZ plane (radians). Derived each frame from the offset; clamped only in
   * `"turntable"` mode.
   */
  public elevation = 0.4;
  /** Min/max distance (m). */
  public minDistance = 0.05;
  public maxDistance = 1e6;
  /** Elevation clamp for `"turntable"` mode (radians). Ignored in `"trackball"`. */
  public minElevation = -Math.PI / 2 + 0.15;
  public maxElevation = Math.PI / 2 - 0.15;
  /**
   * Rotation model. `"trackball"` (default) has no polar stop; `"turntable"` keeps world-up and
   * clamps elevation.
   */
  public mode: OrbitMode = "trackball";
  /** Orbit sensitivity (radians per CSS pixel). */
  public rotateSpeed = 0.005;
  /** Pan sensitivity scale. */
  public panSpeed = 1;
  /**
   * Zoom sensitivity. Applied as `exp(normalizedWheelDelta * zoomSpeed)` where a typical mouse
   * notch is normalized to ~1. Trackpad pixel deltas scale smoothly with magnitude.
   */
  public zoomSpeed = 0.12;
  /**
   * Vertical field of view (radians) used for {@link zoomToCursor}. Match the projection used to
   * render (default ~42°).
   */
  public fovY = (42 * Math.PI) / 180;
  /**
   * When true (default), wheel zoom keeps the world point under the cursor stable by panning the
   * orbit target toward/away from that point.
   */
  public zoomToCursor = true;
  /**
   * Optional axis-aligned clamp for the orbit {@link target} (world units). When set, the pivot is
   * kept inside this box every {@link update} — before the eye is derived from it. Zoom-to-cursor
   * slides the target toward the cursor point each frame ({@link update}); with the cursor over empty
   * background that point lies far outside the data, so the target (and the eye that trails it at a
   * fixed {@link maxDistance}) can drift arbitrarily far from the volume until it overruns float32 and
   * the volume vanishes. Pinning the pivot to the data bounds caps the eye's absolute distance from
   * the volume. `null` disables the clamp (free pivot).
   */
  public targetBounds: { min: Vec3; max: Vec3 } | null = null;
  /** Exponential damping factor (0 = snap, ~10 = smooth). */
  public damping = 12;
  /** When false, pointer/wheel input is ignored. */
  public enabled = true;
  /** Invert horizontal orbit drag direction. Default off (unchanged existing behavior). */
  public invertX = false;
  /** Invert vertical orbit drag direction. Default off (unchanged existing behavior). */
  public invertY = false;
  /**
   * Optional gate for pointerdown/wheel. Return `false` to ignore the event (e.g. when a UI overlay
   * chrome is under the cursor).
   */
  public filterPointer: ((event: PointerEvent | WheelEvent) => boolean) | undefined;

  /** Current / desired camera offset from {@link target} (trackball state). */
  private readonly _offset = new Vec3(0, 0, 5);
  private readonly _desiredOffset = new Vec3(0, 0, 5);
  private _desiredDistance = 5;
  /**
   * Camera "up" that tumbles with trackball rotation. Using world-up to rebuild the pitch axis
   * every frame reintroduces polar lock; this vector is rotated by the same quats as the offset.
   */
  private readonly _gazeUp = new Vec3(0, 1, 0);
  private readonly _desiredGazeUp = new Vec3(0, 1, 0);

  private readonly _eye = new Vec3();
  private readonly _world = new Mat4();
  private readonly _panOffset = new Vec3();
  private readonly _lookOffset = new Vec3();
  private readonly _right = new Vec3();
  private readonly _panUp = new Vec3();
  private readonly _forward = new Vec3();
  private readonly _worldUp = new Vec3(0, 1, 0);
  /** Pivot for damped zoom-to-cursor (`target = pivot + (target - pivot) * (dNew/dOld)` each frame). */
  private readonly _zoomPivot = new Vec3();
  private _hasZoomPivot = false;
  private readonly _q = new Quat();
  private readonly _qPitch = new Quat();
  private readonly _qYaw = new Quat();

  private dragging: "orbit" | "pan" | null = null;
  private lastX = 0;
  private lastY = 0;
  /** True while Space is held — left-drag pans (trackpad-friendly). */
  private spaceDown = false;
  private readonly onPointerDown: (e: PointerEvent) => void;
  private readonly onPointerMove: (e: PointerEvent) => void;
  private readonly onPointerUp: (e: PointerEvent) => void;
  private readonly onWheel: (e: WheelEvent) => void;
  private readonly onContextMenu: (e: Event) => void;
  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private readonly onKeyUp: (e: KeyboardEvent) => void;
  private readonly onWindowBlur: () => void;

  public constructor(
    public readonly node: Node,
    public readonly element: HTMLElement,
  ) {
    this.onPointerDown = (e) => {
      if (!this.enabled) return;
      if (this.filterPointer && !this.filterPointer(e)) return;
      this.element.setPointerCapture(e.pointerId);
      // Pan: right / middle / Shift|Alt|Space+left (DCC / trackpad-friendly).
      const pan =
        e.button === 2 ||
        e.button === 1 ||
        e.shiftKey ||
        e.altKey ||
        (e.button === 0 && this.spaceDown);
      this.dragging = pan ? "pan" : "orbit";
      if (!pan) this._hasZoomPivot = false;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    };
    this.onPointerMove = (e) => {
      if (!this.enabled || !this.dragging) return;
      // Lost button (e.g. gesture cancelled) — stop the drag.
      if (e.buttons === 0) {
        this.dragging = null;
        return;
      }
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      if (this.dragging === "orbit") {
        const idx = this.invertX ? -dx : dx;
        const idy = this.invertY ? -dy : dy;
        if (this.mode === "turntable") this.orbitTurntable(idx, idy);
        else this.orbitTrackball(idx, idy);
      } else {
        this.panBy(dx, dy);
      }
    };
    this.onPointerUp = (e) => {
      this.dragging = null;
      try {
        this.element.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    };
    this.onWheel = (e) => {
      if (!this.enabled) return;
      if (this.filterPointer && !this.filterPointer(e)) return;
      e.preventDefault();
      let dx = e.deltaX;
      let dy = e.deltaY;
      if (e.deltaMode === 1 /* DOM_DELTA_LINE */) {
        dx *= 16;
        dy *= 16;
      } else if (e.deltaMode === 2 /* DOM_DELTA_PAGE */) {
        const h = Math.max(1, this.element.clientHeight);
        dx *= h;
        dy *= h;
      }

      // Shift+wheel or predominantly-horizontal trackpad swipe → pan.
      // Ctrl/Meta+wheel (pinch) and vertical wheel → zoom toward cursor.
      const panGesture =
        e.shiftKey || (!e.ctrlKey && !e.metaKey && Math.abs(dx) > Math.abs(dy) * 1.25);
      if (panGesture) {
        this.panBy(-dx, -dy);
        return;
      }

      const steps = dy / 100;
      const clampedSteps = clamp(steps, -4, 4);
      const factor = Math.exp(clampedSteps * this.zoomSpeed);
      this.dollyBy(factor, e.clientX, e.clientY);
    };
    this.onContextMenu = (e) => e.preventDefault();
    this.onKeyDown = (e) => {
      if (e.code !== "Space" || e.repeat) return;
      const t = e.target as HTMLElement | null;
      const typing =
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable);
      if (typing) return;
      this.spaceDown = true;
      e.preventDefault(); // stop page scroll during Space+drag pan
    };
    this.onKeyUp = (e) => {
      if (e.code === "Space") this.spaceDown = false;
    };
    this.onWindowBlur = () => {
      this.spaceDown = false;
      this.dragging = null;
    };

    this.element.addEventListener("pointerdown", this.onPointerDown);
    this.element.addEventListener("pointermove", this.onPointerMove);
    this.element.addEventListener("pointerup", this.onPointerUp);
    this.element.addEventListener("pointercancel", this.onPointerUp);
    this.element.addEventListener("wheel", this.onWheel, { passive: false });
    this.element.addEventListener("contextmenu", this.onContextMenu);
    // Space+pan needs window key events (canvas usually isn't focused). Skip in non-DOM hosts.
    const win = typeof window !== "undefined" ? window : undefined;
    win?.addEventListener("keydown", this.onKeyDown);
    win?.addEventListener("keyup", this.onKeyUp);
    win?.addEventListener("blur", this.onWindowBlur);

    this.syncFromNode();
  }

  /** Seed offset / spherical state from the node's current world position relative to {@link target}. */
  public syncFromNode(): void {
    const p = this.node.position;
    const ox = p.x - this.target.x;
    const oy = p.y - this.target.y;
    const oz = p.z - this.target.z;
    const r = Math.hypot(ox, oy, oz);
    if (r < 1e-6) {
      this._offset.set(0, 0, this.distance);
      this._desiredOffset.copy(this._offset);
      this._desiredDistance = this.distance;
      this._gazeUp.set(0, 1, 0);
      this._desiredGazeUp.set(0, 1, 0);
      this._hasZoomPivot = false;
      return;
    }
    if (r > this.maxDistance) this.maxDistance = r * 4;
    if (r < this.minDistance) this.minDistance = Math.max(1e-4, r * 0.25);
    this.distance = this._desiredDistance = clamp(r, this.minDistance, this.maxDistance);
    this._offset.set(ox, oy, oz).multiplyScalar(this.distance / r);
    this._desiredOffset.copy(this._offset);
    this.syncSphericalFromOffset(this._offset);
    // Seed a camera-up orthogonal to the view (prefer world Y).
    this._forward.set(-ox / r, -oy / r, -oz / r);
    this._right.set(
      this._forward.y * this._worldUp.z - this._forward.z * this._worldUp.y,
      this._forward.z * this._worldUp.x - this._forward.x * this._worldUp.z,
      this._forward.x * this._worldUp.y - this._forward.y * this._worldUp.x,
    );
    if (this._right.lengthSq() < 1e-12) this._right.set(1, 0, 0);
    else this._right.normalize();
    this._gazeUp
      .set(
        this._right.y * this._forward.z - this._right.z * this._forward.y,
        this._right.z * this._forward.x - this._right.x * this._forward.z,
        this._right.x * this._forward.y - this._right.y * this._forward.x,
      )
      .normalize();
    this._desiredGazeUp.copy(this._gazeUp);
    if (this.mode === "turntable") {
      this.elevation = clamp(this.elevation, this.minElevation, this.maxElevation);
      this.writeOffsetFromSpherical(this._desiredOffset);
      this._offset.copy(this._desiredOffset);
      this._gazeUp.set(0, 1, 0);
      this._desiredGazeUp.set(0, 1, 0);
    }
    this._hasZoomPivot = false;
  }

  /**
   * Snapshot the full trackball pose (target + raw offset + tumbling gaze-up + distance). Suitable
   * for copying the exact view between controllers; see {@link setState}.
   */
  public getState(): OrbitState {
    return {
      target: [this.target.x, this.target.y, this.target.z],
      offset: [this._offset.x, this._offset.y, this._offset.z],
      gazeUp: [this._gazeUp.x, this._gazeUp.y, this._gazeUp.z],
      distance: this.distance,
    };
  }

  /**
   * Apply a pose captured by {@link getState}. Snaps both the current and desired pose (no damping
   * catch-up) and writes it straight onto the node, so linked panes stay in lock-step. Clears any
   * pending zoom-to-cursor pivot.
   */
  public setState(state: OrbitState): void {
    this.target.set(state.target[0], state.target[1], state.target[2]);
    this._offset.set(state.offset[0], state.offset[1], state.offset[2]);
    this._desiredOffset.copy(this._offset);
    this._gazeUp.set(state.gazeUp[0], state.gazeUp[1], state.gazeUp[2]);
    this._desiredGazeUp.copy(this._gazeUp);
    this.distance = this._desiredDistance = state.distance;
    this._hasZoomPivot = false;
    this.syncSphericalFromOffset(this._offset);
    this._eye.copy(this.target).add(this._offset);
    this.applyEyeLookAt(this._eye, this.target, this._gazeUp);
  }

  /** True while a pointer drag (orbit/pan) is active. */
  public get isDragging(): boolean {
    return this.dragging !== null;
  }

  /**
   * True while the camera is still catching up to the desired orbit (damping) or zoom.
   * Progressive renderers (e.g. gem path tracer) should not accumulate while this is set.
   */
  public get isAnimating(): boolean {
    if (this.dragging) return true;
    const o = this._offset;
    const d = this._desiredOffset;
    const ol = o.length();
    const dl = d.length();
    if (ol < 1e-12 || dl < 1e-12) {
      return Math.abs(this.distance - this._desiredDistance) > 1e-5;
    }
    const dirDot = (o.x * d.x + o.y * d.y + o.z * d.z) / (ol * dl);
    const distErr =
      Math.abs(this.distance - this._desiredDistance) / Math.max(this.distance, this._desiredDistance, 1e-8);
    const upDot =
      this._gazeUp.x * this._desiredGazeUp.x +
      this._gazeUp.y * this._desiredGazeUp.y +
      this._gazeUp.z * this._desiredGazeUp.z;
    return dirDot < 0.9999995 || distErr > 1e-5 || upDot < 0.999999;
  }

  /** Current camera eye position (world). */
  public get eye(): Vec3 {
    return this._eye;
  }

  /** Current tumbling gaze-up (trackball) / world-up (turntable). */
  public get gazeUp(): Vec3 {
    return this._gazeUp;
  }

  /** Snap damped state to the desired pose immediately (call on pointer-up for progressive renders). */
  public flush(): void {
    this._offset.copy(this._desiredOffset);
    this._gazeUp.copy(this._desiredGazeUp);
    const d0 = Math.max(1e-8, this.distance);
    const d1 = this._desiredDistance;
    if (this._hasZoomPivot && Math.abs(d1 - d0) > 1e-12) {
      const f = d1 / d0;
      const px = this._zoomPivot.x;
      const py = this._zoomPivot.y;
      const pz = this._zoomPivot.z;
      this.target.set(
        px + (this.target.x - px) * f,
        py + (this.target.y - py) * f,
        pz + (this.target.z - pz) * f,
      );
    }
    this.distance = d1;
    this._hasZoomPivot = false;
    const ol = this._offset.length();
    if (ol > 1e-12) this._offset.multiplyScalar(this.distance / ol);
    this.orthonormalizeGaze(this._offset, this._gazeUp);
    this.syncSphericalFromOffset(this._offset);
    this._eye.copy(this.target).add(this._offset);
    this.applyEyeLookAt(this._eye, this.target, this._gazeUp);
  }

  public update(dt: number): void {
    this._desiredDistance = clamp(this._desiredDistance, this.minDistance, this.maxDistance);

    const a = dt <= 0 || this.damping <= 0 ? 1 : 1 - Math.exp(-this.damping * dt);
    const d0 = Math.max(1e-8, this.distance);

    // Blend offset direction (renormalize) and distance separately.
    if (a >= 1) {
      this._offset.copy(this._desiredOffset);
      this._gazeUp.copy(this._desiredGazeUp);
      this.distance = this._desiredDistance;
    } else {
      this._offset.lerp(this._desiredOffset, a);
      this._gazeUp.lerp(this._desiredGazeUp, a).normalize();
      const d1 = Math.max(1e-8, this._desiredDistance);
      this.distance = Math.exp(Math.log(d0) + (Math.log(d1) - Math.log(d0)) * a);
    }

    // Keep zoom-to-cursor locked while distance damps: slide target with each distance step.
    if (this._hasZoomPivot) {
      const dNew = Math.max(1e-8, this.distance);
      const f = dNew / d0;
      if (Math.abs(f - 1) > 1e-9) {
        const px = this._zoomPivot.x;
        const py = this._zoomPivot.y;
        const pz = this._zoomPivot.z;
        this.target.set(
          px + (this.target.x - px) * f,
          py + (this.target.y - py) * f,
          pz + (this.target.z - pz) * f,
        );
      }
      if (Math.abs(this.distance - this._desiredDistance) < 1e-5) {
        this._hasZoomPivot = false;
      }
    }

    // Pin the pivot to the data bounds *before* deriving the eye, so a zoom-to-cursor slide over empty
    // background can't carry the target (and the trailing eye) off to float32-overrun distances where
    // the volume vanishes. Clamping here (not post-update in the render loop) keeps eye = target+offset
    // consistent within the same frame — no one-frame-late correction, no fight with the slide.
    if (this.targetBounds) {
      const { min, max } = this.targetBounds;
      this.target.x = Math.min(max.x, Math.max(min.x, this.target.x));
      this.target.y = Math.min(max.y, Math.max(min.y, this.target.y));
      this.target.z = Math.min(max.z, Math.max(min.z, this.target.z));
    }

    const ol = this._offset.length();
    if (ol > 1e-12) this._offset.multiplyScalar(this.distance / ol);
    else this._offset.set(0, 0, this.distance);

    // Keep desired length matched after blend (drag may have changed direction only).
    const dl = this._desiredOffset.length();
    if (dl > 1e-12) this._desiredOffset.multiplyScalar(this._desiredDistance / dl);
    this._desiredGazeUp.normalize();
    // Re-orthogonalize gaze-up against the view so numerical drift doesn't accumulate.
    this.orthonormalizeGaze(this._offset, this._gazeUp);
    this.orthonormalizeGaze(this._desiredOffset, this._desiredGazeUp);

    this.syncSphericalFromOffset(this._offset);
    this._eye.copy(this.target).add(this._offset);
    this.applyEyeLookAt(this._eye, this.target, this._gazeUp);
  }

  public dispose(): void {
    this.element.removeEventListener("pointerdown", this.onPointerDown);
    this.element.removeEventListener("pointermove", this.onPointerMove);
    this.element.removeEventListener("pointerup", this.onPointerUp);
    this.element.removeEventListener("pointercancel", this.onPointerUp);
    this.element.removeEventListener("wheel", this.onWheel);
    this.element.removeEventListener("contextmenu", this.onContextMenu);
    const win = typeof window !== "undefined" ? window : undefined;
    win?.removeEventListener("keydown", this.onKeyDown);
    win?.removeEventListener("keyup", this.onKeyUp);
    win?.removeEventListener("blur", this.onWindowBlur);
  }

  /**
   * Free tumble: rotate offset + gaze-up together in camera screen space.
   * Pitch uses the *current* camera-right (from gaze-up), not `forward × worldUp`, so there is no
   * polar singularity.
   */
  private orbitTrackball(dx: number, dy: number): void {
    this.basisFromGaze(this._desiredOffset, this._desiredGazeUp, this._right, this._panUp, this._forward);
    // Drag right → yaw around camera up; drag down → pitch around camera right.
    this._qYaw.setFromAxisAngle(this._panUp, -dx * this.rotateSpeed);
    this._qPitch.setFromAxisAngle(this._right, -dy * this.rotateSpeed);
    this._q.copy(this._qYaw).multiply(this._qPitch);
    this._desiredOffset.applyQuat(this._q);
    this._desiredGazeUp.applyQuat(this._q);
    const len = this._desiredOffset.length();
    if (len > 1e-12) this._desiredOffset.multiplyScalar(this._desiredDistance / len);
    this.orthonormalizeGaze(this._desiredOffset, this._desiredGazeUp);
  }

  /** Classic turntable: azimuth around world Y + clamped elevation. */
  private orbitTurntable(dx: number, dy: number): void {
    this.syncSphericalFromOffset(this._desiredOffset);
    this.azimuth -= dx * this.rotateSpeed;
    this.elevation += dy * this.rotateSpeed;
    this.elevation = clamp(this.elevation, this.minElevation, this.maxElevation);
    this.writeOffsetFromSpherical(this._desiredOffset);
    this._desiredGazeUp.set(0, 1, 0);
  }

  private syncSphericalFromOffset(offset: Vec3): void {
    const r = offset.length();
    if (r < 1e-12) return;
    this.distance = r;
    this.azimuth = Math.atan2(offset.x, offset.z);
    this.elevation = Math.asin(clamp(offset.y / r, -1, 1));
  }

  private writeOffsetFromSpherical(out: Vec3): void {
    const cosE = Math.cos(this.elevation);
    out.set(
      this._desiredDistance * cosE * Math.sin(this.azimuth),
      this._desiredDistance * Math.sin(this.elevation),
      this._desiredDistance * cosE * Math.cos(this.azimuth),
    );
  }

  /** Make `gazeUp` unit and orthogonal to the view direction implied by `offset`. */
  private orthonormalizeGaze(offset: Vec3, gazeUp: Vec3): void {
    const ol = offset.length() || 1;
    // forward = -offset
    const fx = -offset.x / ol;
    const fy = -offset.y / ol;
    const fz = -offset.z / ol;
    // Remove component along forward.
    const d = gazeUp.x * fx + gazeUp.y * fy + gazeUp.z * fz;
    gazeUp.x -= d * fx;
    gazeUp.y -= d * fy;
    gazeUp.z -= d * fz;
    const gl = gazeUp.length();
    if (gl < 1e-8) {
      // Degenerate: pick any axis orthogonal to forward.
      if (Math.abs(fy) < 0.9) gazeUp.set(0, 1, 0);
      else gazeUp.set(1, 0, 0);
      const d2 = gazeUp.x * fx + gazeUp.y * fy + gazeUp.z * fz;
      gazeUp.x -= d2 * fx;
      gazeUp.y -= d2 * fy;
      gazeUp.z -= d2 * fz;
      gazeUp.normalize();
    } else {
      gazeUp.multiplyScalar(1 / gl);
    }
  }

  /** Camera basis from offset + tumbling gaze-up (trackball). */
  private basisFromGaze(
    offset: Vec3,
    gazeUp: Vec3,
    right: Vec3,
    up: Vec3,
    forward: Vec3,
  ): void {
    const ol = offset.length() || 1;
    forward.set(-offset.x / ol, -offset.y / ol, -offset.z / ol);

    // right = normalize(forward × gazeUp) — gazeUp is the tumbling up, never world-locked.
    right.set(
      forward.y * gazeUp.z - forward.z * gazeUp.y,
      forward.z * gazeUp.x - forward.x * gazeUp.z,
      forward.x * gazeUp.y - forward.y * gazeUp.x,
    );
    let rl = right.length();
    if (rl < 1e-8) {
      // Should be rare after orthonormalize; pick a stable fallback.
      right.set(-forward.z, 0, forward.x);
      rl = right.length();
      if (rl < 1e-8) right.set(1, 0, 0);
      else right.multiplyScalar(1 / rl);
    } else {
      right.multiplyScalar(1 / rl);
    }

    // up = right × forward (re-derived so the basis is orthonormal)
    up.set(
      right.y * forward.z - right.z * forward.y,
      right.z * forward.x - right.x * forward.z,
      right.x * forward.y - right.y * forward.x,
    ).normalize();
  }

  private applyEyeLookAt(eye: Vec3, target: Vec3, gazeUp: Vec3): void {
    // IMPORTANT: `eye` may be `this._eye` — never overwrite it before reading world position.
    const ex = eye.x;
    const ey = eye.y;
    const ez = eye.z;
    const ox = ex - target.x;
    const oy = ey - target.y;
    const oz = ez - target.z;
    if (ox * ox + oy * oy + oz * oz < 1e-24) {
      this.node.position.set(ex, ey, ez);
      return;
    }
    this._lookOffset.set(ox, oy, oz);
    this.basisFromGaze(this._lookOffset, gazeUp, this._right, this._panUp, this._forward);

    const fx = this._forward.x;
    const fy = this._forward.y;
    const fz = this._forward.z;
    const rx = this._right.x;
    const ry = this._right.y;
    const rz = this._right.z;
    const ux = this._panUp.x;
    const uy = this._panUp.y;
    const uz = this._panUp.z;

    const e = this._world.elements;
    e[0] = rx;
    e[1] = ry;
    e[2] = rz;
    e[3] = 0;
    e[4] = ux;
    e[5] = uy;
    e[6] = uz;
    e[7] = 0;
    e[8] = -fx;
    e[9] = -fy;
    e[10] = -fz;
    e[11] = 0;
    e[12] = ex;
    e[13] = ey;
    e[14] = ez;
    e[15] = 1;

    // Apply the lookAt basis directly — avoid decompose()'s negative-scale flip, which can
    // mirror an axis and leave a second "ghost" orientation after damping settles.
    this.node.position.set(ex, ey, ez);
    this.node.scale.set(1, 1, 1);
    this.node.rotation.setFromRotationMatrix(this._world);
    this.node.markDirty();
  }

  private panBy(dx: number, dy: number): void {
    this._hasZoomPivot = false;
    // Use the on-screen (damped) distance so pan speed matches what you see.
    const scale = (this.distance * this.panSpeed) / Math.max(1, this.element.clientHeight);
    this.basisFromGaze(this._offset, this._gazeUp, this._right, this._panUp, this._forward);
    this._panOffset
      .set(0, 0, 0)
      .addScaledVector(this._right, -dx * scale)
      .addScaledVector(this._panUp, dy * scale);
    this.target.add(this._panOffset);
    // Apply immediately — don't wait for the next update() so pan feels 1:1 with the drag.
    this._eye.copy(this.target).add(this._offset);
    this.applyEyeLookAt(this._eye, this.target, this._gazeUp);
  }

  /**
   * Zoom by `factor` (>1 = out, <1 = in). Updates the damped desired distance so scrolling stays
   * smooth. With {@link zoomToCursor}, records a pivot; {@link update} slides {@link target} in
   * lockstep with each damped distance step so the cursor point stays stable.
   */
  private dollyBy(factor: number, clientX?: number, clientY?: number): void {
    const prevDesired = Math.max(1e-8, this._desiredDistance);
    const newDist = clamp(prevDesired * factor, this.minDistance, this.maxDistance);
    if (Math.abs(newDist / prevDesired - 1) < 1e-9) return;

    this._desiredDistance = newDist;
    const dl = this._desiredOffset.length();
    if (dl > 1e-12) this._desiredOffset.multiplyScalar(newDist / dl);

    if (
      this.zoomToCursor &&
      clientX !== undefined &&
      clientY !== undefined &&
      Number.isFinite(clientX) &&
      Number.isFinite(clientY)
    ) {
      const pivot = this.cursorPointOnTargetPlane(clientX, clientY, this._zoomPivot);
      // Bail out of zoom-to-cursor when the rect was zero-size (hidden/transitioning pane):
      // cursorPointOnTargetPlane() returns null and we leave the pivot disabled for this event.
      this._hasZoomPivot = pivot !== null;
    } else {
      this._hasZoomPivot = false;
    }
  }

  /**
   * World point under the cursor on the plane through {@link target} facing the camera.
   * Returns `null` (and does not write `out`) when the element's live rect is zero-size, so the
   * caller can skip enabling the zoom pivot for that event.
   */
  private cursorPointOnTargetPlane(clientX: number, clientY: number, out: Vec3): Vec3 | null {
    // Measure fresh at event time — never cache, so an offset/resized pane maps correctly.
    const rect =
      typeof this.element.getBoundingClientRect === "function"
        ? this.element.getBoundingClientRect()
        : {
            left: 0,
            top: 0,
            width: this.element.clientWidth || 1,
            height: this.element.clientHeight || 1,
          };
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    const ndcX = ((clientX - rect.left) / w) * 2 - 1;
    // Y is intentionally NOT the standard screen->NDC sign here. The volume ray-march shader
    // reconstructs its rays from a vertically-flipped NDC (`ndc.y = (1.0 - uv.y) * 2 - 1` in
    // volume-raymarch.ts), so on the displayed image camera +up appears at the BOTTOM. This
    // target-plane pivot is built from the camera `up` basis directly, so its Y must match that
    // flipped display convention — otherwise zoom-to-cursor tracks the vertically-mirrored point
    // (X was already correct; only Y was inverted). Keep this sign aligned with the shader.
    const ndcY = ((clientY - rect.top) / h) * 2 - 1;

    // Zero-size / hidden pane: coordinates are meaningless — skip zoom-to-cursor for this event.
    if (rect.width === 0 || rect.height === 0) return null;

    // Use the on-screen pose (damped offset), not the desired pose.
    this.basisFromGaze(this._offset, this._gazeUp, this._right, this._panUp, this._forward);
    const halfH = this.distance * Math.tan(Math.max(1e-4, this.fovY) * 0.5);
    const halfW = halfH * (w / h);
    return out
      .copy(this.target)
      .addScaledVector(this._right, ndcX * halfW)
      .addScaledVector(this._panUp, ndcY * halfH);
  }
}

/**
 * Fly controls: free 6-DoF movement (WASD + Q/E vertical + mouse look). Click the element to capture
 * the pointer; Escape releases it. Uses an internal {@link InputMap} for keyboard axes.
 *
 * @example
 * ```ts
 * const fly = new FlyControls(cameraNode, canvas);
 * fly.speed = 8;
 * fly.update(dt);
 * ```
 */
export class FlyControls implements Controller {
  /** Move speed in metres per second. */
  public speed = 5;
  /** Look sensitivity (radians per CSS pixel). */
  public lookSpeed = 0.002;
  /** Pitch clamp from the XZ plane (radians). */
  public minPitch = -Math.PI / 2 + 0.05;
  public maxPitch = Math.PI / 2 - 0.05;

  /** Yaw around world +Y (radians). */
  public yaw = 0;
  /** Pitch around local +X (radians). */
  public pitch = 0;

  public readonly input: InputMap;

  private readonly _forward = new Vec3();
  private readonly _right = new Vec3();
  private readonly _up = new Vec3(0, 1, 0);
  private readonly _move = new Vec3();
  private readonly _lookTarget = new Vec3();
  private readonly _view = new Mat4();
  private readonly _world = new Mat4();
  private readonly _scale = new Vec3(1, 1, 1);

  private pointerLocked = false;
  private readonly onPointerDown: (e: PointerEvent) => void;
  private readonly onPointerMove: (e: PointerEvent) => void;
  private readonly onPointerLockChange: () => void;

  public constructor(
    public readonly node: Node,
    public readonly element: HTMLElement,
  ) {
    this.input = new InputMap(element);
    this.input
      .bindAxis("moveX", { positive: ["KeyD"], negative: ["KeyA"] })
      .bindAxis("moveZ", { positive: ["KeyW"], negative: ["KeyS"] })
      .bindAxis("moveY", { positive: ["KeyE", "Space"], negative: ["KeyQ", "ControlLeft"] });

    this.onPointerDown = () => {
      if (!this.pointerLocked) void this.element.requestPointerLock?.();
    };
    this.onPointerMove = (e) => {
      if (!this.pointerLocked) return;
      this.yaw -= e.movementX * this.lookSpeed;
      this.pitch -= e.movementY * this.lookSpeed;
      this.pitch = clamp(this.pitch, this.minPitch, this.maxPitch);
    };
    this.onPointerLockChange = () => {
      const doc = this.element.ownerDocument;
      this.pointerLocked = !!doc && doc.pointerLockElement === this.element;
    };

    this.element.addEventListener("pointerdown", this.onPointerDown);
    const doc = this.element.ownerDocument;
    doc?.addEventListener("pointermove", this.onPointerMove);
    doc?.addEventListener("pointerlockchange", this.onPointerLockChange);

    this.syncFromNode();
  }

  /** Seed yaw/pitch from the node's current forward direction. */
  public syncFromNode(): void {
    const e = this.node.worldMatrix().elements;
    // Local -Z is the camera forward in view space; world forward ≈ -column 2.
    const fx = -e[8]!;
    const fy = -e[9]!;
    const fz = -e[10]!;
    const len = Math.hypot(fx, fy, fz);
    if (len < 1e-6) return;
    this.yaw = Math.atan2(fx / len, fz / len);
    this.pitch = Math.asin(clamp(fy / len, -1, 1));
  }

  public update(dt: number): void {
    const cosP = Math.cos(this.pitch);
    this._forward.set(Math.sin(this.yaw) * cosP, Math.sin(this.pitch), Math.cos(this.yaw) * cosP);
    this._right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    const mx = this.input.axis("moveX");
    const mz = this.input.axis("moveZ");
    const my = this.input.axis("moveY");
    this._move
      .set(0, 0, 0)
      .addScaledVector(this._right, mx)
      .addScaledVector(this._forward, mz)
      .addScaledVector(this._up, my);
    if (this._move.lengthSq() > 0) {
      this._move.normalize().multiplyScalar(this.speed * dt);
      this.node.position.add(this._move);
    }

    this.applyLookRotation();
  }

  public dispose(): void {
    this.element.removeEventListener("pointerdown", this.onPointerDown);
    const doc = this.element.ownerDocument;
    doc?.removeEventListener("pointermove", this.onPointerMove);
    doc?.removeEventListener("pointerlockchange", this.onPointerLockChange);
    if (doc?.pointerLockElement === this.element) doc.exitPointerLock?.();
    this.input.dispose();
  }

  private applyLookRotation(): void {
    this._lookTarget
      .copy(this.node.position)
      .addScaledVector(this._forward.set(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch)), 1);
    this._view.lookAt(this.node.position, this._lookTarget, this._up);
    this._world.copy(this._view);
    if (!this._world.invert()) return;
    this._world.decompose(this.node.position, this.node.rotation, this._scale);
    this.node.scale.set(1, 1, 1);
  }
}

/**
 * First-person controls: walk on the XZ plane (WASD) with mouse look and optional jump/crouch
 * vertical offset. Unlike {@link FlyControls}, forward motion ignores pitch so you don't fly into
 * the sky when looking up.
 *
 * @example
 * ```ts
 * const fps = new FirstPersonControls(cameraNode, canvas);
 * fps.eyeHeight = 1.7;
 * fps.update(dt);
 * ```
 */
export class FirstPersonControls implements Controller {
  /** Walk speed in metres per second. */
  public speed = 4;
  /** Look sensitivity (radians per CSS pixel). */
  public lookSpeed = 0.002;
  /** Eye height above the walk plane (m). */
  public eyeHeight = 1.7;
  /** Pitch clamp (radians). */
  public minPitch = -Math.PI / 2 + 0.05;
  public maxPitch = Math.PI / 2 - 0.05;

  public yaw = 0;
  public pitch = 0;

  public readonly input: InputMap;

  private readonly _forward = new Vec3();
  private readonly _right = new Vec3();
  private readonly _up = new Vec3(0, 1, 0);
  private readonly _move = new Vec3();
  private readonly _lookTarget = new Vec3();
  private readonly _view = new Mat4();
  private readonly _world = new Mat4();
  private readonly _scale = new Vec3(1, 1, 1);

  private pointerLocked = false;
  private readonly onPointerDown: (e: PointerEvent) => void;
  private readonly onPointerMove: (e: PointerEvent) => void;
  private readonly onPointerLockChange: () => void;

  public constructor(
    public readonly node: Node,
    public readonly element: HTMLElement,
  ) {
    this.input = new InputMap(element);
    this.input.bindAxis("moveX", { positive: ["KeyD"], negative: ["KeyA"] }).bindAxis("moveZ", {
      positive: ["KeyW"],
      negative: ["KeyS"],
    });

    this.onPointerDown = () => {
      if (!this.pointerLocked) void this.element.requestPointerLock?.();
    };
    this.onPointerMove = (e) => {
      if (!this.pointerLocked) return;
      this.yaw -= e.movementX * this.lookSpeed;
      this.pitch -= e.movementY * this.lookSpeed;
      this.pitch = clamp(this.pitch, this.minPitch, this.maxPitch);
    };
    this.onPointerLockChange = () => {
      const doc = this.element.ownerDocument;
      this.pointerLocked = !!doc && doc.pointerLockElement === this.element;
    };

    this.element.addEventListener("pointerdown", this.onPointerDown);
    const doc = this.element.ownerDocument;
    doc?.addEventListener("pointermove", this.onPointerMove);
    doc?.addEventListener("pointerlockchange", this.onPointerLockChange);

    this.syncFromNode();
  }

  /** Seed yaw/pitch and snap Y to {@link eyeHeight}. */
  public syncFromNode(): void {
    this.node.position.y = this.eyeHeight;
    const e = this.node.worldMatrix().elements;
    const fx = -e[8]!;
    const fy = -e[9]!;
    const fz = -e[10]!;
    const len = Math.hypot(fx, fy, fz);
    if (len < 1e-6) return;
    this.yaw = Math.atan2(fx / len, fz / len);
    this.pitch = Math.asin(clamp(fy / len, -1, 1));
  }

  public update(dt: number): void {
    // Horizontal forward (ignore pitch).
    this._forward.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this._right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    const mx = this.input.axis("moveX");
    const mz = this.input.axis("moveZ");
    this._move.set(0, 0, 0).addScaledVector(this._right, mx).addScaledVector(this._forward, mz);
    if (this._move.lengthSq() > 0) {
      this._move.normalize().multiplyScalar(this.speed * dt);
      this.node.position.x += this._move.x;
      this.node.position.z += this._move.z;
    }
    this.node.position.y = this.eyeHeight;

    const cosP = Math.cos(this.pitch);
    this._lookTarget.set(
      this.node.position.x + Math.sin(this.yaw) * cosP,
      this.node.position.y + Math.sin(this.pitch),
      this.node.position.z + Math.cos(this.yaw) * cosP,
    );
    this._view.lookAt(this.node.position, this._lookTarget, this._up);
    this._world.copy(this._view);
    if (!this._world.invert()) return;
    this._world.decompose(this.node.position, this.node.rotation, this._scale);
    this.node.scale.set(1, 1, 1);
    this.node.position.y = this.eyeHeight;
  }

  public dispose(): void {
    this.element.removeEventListener("pointerdown", this.onPointerDown);
    const doc = this.element.ownerDocument;
    doc?.removeEventListener("pointermove", this.onPointerMove);
    doc?.removeEventListener("pointerlockchange", this.onPointerLockChange);
    if (doc?.pointerLockElement === this.element) doc.exitPointerLock?.();
    this.input.dispose();
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
