/**
 * WebGpuLinked2D3DPane.tsx
 *
 * A linked 2D-orthoslice + 3D split of ONE dataset (neuroglancer-style: 2D slice on the left, 3D volume
 * on the right): two `WebGpuNative` mounts sharing `dataUrl`, with rendering (colormap/TF/exposure/…)
 * and cropping (crop box + slice position/enables/overlay) synced bidirectionally via
 * `useLinkedWebGpuViewers` — the hook's own `camera` group is deliberately left off (it copies the whole
 * pose verbatim, including target/zoom), so in axis-aligned mode the 2D pane stays face-on to its slice
 * axis regardless of how the user orbits the 3D pane. The camera-angle-link mode below (`🔗 3D angle`)
 * uses its OWN, separate rotation-only sync instead — see that section for why the two need different
 * camera-linking semantics.
 *
 * The 3D pane is pinned to `viewMode: "volume"`; the 2D pane is pinned to whichever axis is selected
 * (`xPlane`/`yPlane`/`zPlane`) — `useLinkedWebGpuViewers`'s `pinViewMode` option keeps each side's own
 * mode from being overwritten by the other's when the (otherwise fully synced) rendering group copies
 * across. Cropping's `showPlanes`/`sliceX|Y|Z` DO sync normally, so the 3D pane draws the slice-plane
 * overlay at the exact position the 2D pane is showing — the "which thing is being observed in 2D"
 * indicator, for free, no new rendering code.
 *
 * The 2D pane's own HUD sidebar is collapsed by default (its controls are redundant once linked); the
 * 3D pane's stays expanded and includes the built-in "⌖ zoom to slice intersection" button
 * (`WebGpuVolumeViewer.ts`'s `zoomToSliceIntersection`) for re-centering the 3D view on exactly what the
 * 2D pane is showing, from whatever angle the user already has it at.
 *
 * A 4th toolbar option, "🔗 3D angle", turns this into a detail + overview pair: imagine a small CUBE
 * sitting at the intersection of the x/y/z slice planes, which never itself rotates. The 2D (left) pane
 * becomes a zoomed-in view of exactly that cube's contents, rendered from the SAME direction the 3D
 * (right) pane's camera currently faces — copied onto the 2D pane's camera every tick, then re-centered
 * and zoomed onto the cube via `zoomToSliceIntersection` (the same pure framing function built for the
 * "⌖" button, just called continuously here instead of once). The 3D (right) pane stays the ZOOMED-OUT
 * full-volume context, uncropped. The cube's CENTER tracks the 3D pane's own slice position
 * (`sliceX/Y/Z`, moved via its slicing UI) — one-directional, 3D → 2D only, so this can't ping-pong the
 * way an earlier (now-corrected) bidirectional design did. No oblique slicing, no plane math, and no
 * `enOblique` changes are involved at all — the 2D pane is switched to plain `"volume"` on activation
 * (see this mode's own effect below for why) and cropped to a plain axis-aligned box the whole time.
 * The 3D (right) pane also gets a GREEN wireframe-box indicator (`setOverlayBox`) drawn at the exact
 * same extents as the 2D pane's crop box, so it's visually obvious what region is being shown zoomed-in
 * on the left — a dedicated one-directional write, deliberately NOT part of the `cropping` link group
 * (which would otherwise crop the 3D pane itself).
 *
 * @packageDocumentation
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import WebGpuNative from './WebGpuNative';
import type { VolumeViewMode, WebGpuViewerInstance } from '../zarr-viewer/src/ome-zarr-viewer';
import { useLinkedWebGpuViewers } from '../hooks/useLinkedWebGpuViewers';
import type { SliceAxis } from '../stores/useTabsStore';

const AXIS_TO_VIEW_MODE: Record<SliceAxis, VolumeViewMode> = {
  x: 'xPlane',
  y: 'yPlane',
  z: 'zPlane',
};

const AXIS_LABELS: Record<SliceAxis, string> = { x: 'X', y: 'Y', z: 'Z' };

export interface WebGpuLinked2D3DPaneProps {
  dataUrl?: string;
  /** Which axis the 2D pane shows. */
  axis: SliceAxis;
  /** Fired when the user picks a different axis from this pane's own axis picker. */
  onAxisChange: (axis: SliceAxis) => void;
  /** Fired when the user clicks "3D only" to leave the split. */
  onExit: () => void;
  onReady3D?: (instance: WebGpuViewerInstance | null) => void;
  onReady2D?: (instance: WebGpuViewerInstance | null) => void;
}

export default function WebGpuLinked2D3DPane({
  dataUrl,
  axis,
  onAxisChange,
  onExit,
  onReady3D,
  onReady2D,
}: WebGpuLinked2D3DPaneProps) {
  const [instance3D, setInstance3D] = useState<WebGpuViewerInstance | null>(null);
  const [instance2D, setInstance2D] = useState<WebGpuViewerInstance | null>(null);
  // Which axis the 2D pane's viewMode was last set to — lets the axis-change effect below tell "the
  // picker changed" apart from "this pane just (re)mounted" (handled directly in handle2DReady).
  const appliedAxisRef = useRef<SliceAxis | null>(null);
  // Always-current mirror of the `axis` prop, read by `handle2DReady` instead of closing over `axis`
  // directly — `handle2DReady` is intentionally memoized with `[onReady2D]` (see its own comment), so a
  // closure over `axis` would freeze whatever value was current the first time that `useCallback` ran
  // and never update again, even as the `axis` prop legitimately changes. Found live: entering split
  // mode with a non-default axis already selected sometimes left the 2D pane rendering as a plain 3D
  // view instead of the expected slice, only fixing itself after toggling the split off and back on
  // (which force-remounts this whole component, incidentally resetting the stale closure too).
  const axisRef = useRef(axis);
  axisRef.current = axis;
  // Continuous "2D slice follows the 3D camera's own angle" mode (true oblique slicing) — local,
  // transient UI state, not persisted to the tab store (unlike `axis`, which is a real preference).
  const [linkToCameraAngle, setLinkToCameraAngle] = useState(false);

  const handle3DReady = useCallback(
    (instance: WebGpuViewerInstance | null) => {
      setInstance3D(instance);
      onReady3D?.(instance);
      instance?.setViewMode('volume');
      // The 3D (context) pane shows the yellow slice-plane overlay by default — it's the only pane that
      // needs it, to indicate where the 2D pane's slice cuts through the full volume. Pinned per-pane
      // via `useLinkedWebGpuViewers`'s `pinShowPlanes` below, so the bidirectional `cropping` sync can't
      // overwrite it with the 2D pane's own (off) value.
      instance?.setCropping({ ...instance.getCropping(), showPlanes: true });
      // The 3D (context) pane defaults to half-res-while-navigating ON (it's showing the whole volume,
      // so full-res isn't as valuable there) — the 2D (detail) pane is the opposite (see handle2DReady),
      // pinned per-pane via `pinHalfRes` below.
      instance?.setRendering({ ...instance.getRendering(), halfRes: true });
    },
    [onReady3D],
  );

  const handle2DReady = useCallback(
    (instance: WebGpuViewerInstance | null) => {
      setInstance2D(instance);
      onReady2D?.(instance);
      if (instance) {
        // Read the ref, not the closed-over `axis` param — see axisRef's own comment for why.
        const currentAxis = axisRef.current;
        instance.setViewMode(AXIS_TO_VIEW_MODE[currentAxis]);
        // The 2D (detail) pane is OFF for the yellow slice-plane overlay by default — it IS the slice
        // already, so highlighting it there is redundant (the 3D/context pane is the one that needs it,
        // see handle3DReady). `setViewMode`'s plane branches turn `showPlanes` on unconditionally
        // (`enterViewMode`'s existing, shared behavior for every pane), so it must be explicitly turned
        // back off here, right after. Pinned per-pane via `pinShowPlanes` below.
        instance.setCropping({ ...instance.getCropping(), showPlanes: false });
        // The 2D (detail) pane defaults to half-res-while-navigating OFF — it's meant to be the
        // "higher-quality zoomed-in view" of the pair (see handle3DReady's own comment for the 3D
        // pane's opposite default), pinned per-pane via `pinHalfRes` below.
        instance.setRendering({ ...instance.getRendering(), halfRes: false });
        // Collapse the 2D (left) pane's own HUD sidebar by default — its controls are redundant with
        // the 3D (right) pane's, since rendering/cropping are linked between them; showing two nearly
        // identical control sidebars wastes horizontal space better spent on the two canvases.
        instance.setCollapsed(true);
        appliedAxisRef.current = currentAxis;
      } else {
        appliedAxisRef.current = null;
      }
    },
    // Deliberately NOT depending on `axis` — this only fires on mount/unmount (WebGpuNative's own
    // effect is keyed on `dataUrl`, not this callback's identity), so re-creating it on every axis
    // change would be a no-op at best and is worth avoiding for clarity. The axis-change effect below
    // handles picking a new axis on an already-mounted pane. (`axis` itself is read via `axisRef.current`
    // inside the callback body specifically so it's never stale regardless of when this fires — see
    // axisRef's own comment.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onReady2D],
  );

  // The axis picker can change while the 2D pane is already mounted (dataUrl is unchanged, so
  // WebGpuNative won't remount on its own) — re-enter view mode on the same instance. Skipped while
  // `linkToCameraAngle` owns the 2D pane's view mode (oblique) — the effect below handles that case.
  useEffect(() => {
    if (instance2D && !linkToCameraAngle && appliedAxisRef.current !== axis) {
      // Explicitly reset the crop box here too, not just in the "🔗 3D angle" effect's own cleanup
      // below — that cleanup and this effect are two SEPARATE `useEffect`s, and relying on React's
      // cleanup-then-setup ordering across hooks to guarantee the crop is already back to full by the
      // time this runs is fragile (confirmed live: switching straight from 3D-angle mode to a plain
      // X/Y/Z axis could leave the pane still cropped to the small camera-angle cube, breaking the
      // plane's render). Doing it here too makes this transition correct regardless of hook-ordering
      // assumptions — an idempotent no-op on every other axis switch, where the crop is already full.
      instance2D.setCropping({ ...instance2D.getCropping(), cropMin: [0, 0, 0], cropMax: [1, 1, 1] });
      instance2D.setViewMode(AXIS_TO_VIEW_MODE[axis]);
      // setViewMode's plane branches turn showPlanes on unconditionally - the 2D pane stays OFF for the
      // yellow overlay by default (see handle2DReady's own comment for why), so turn it back off here
      // too, every time this effect re-applies a plane mode.
      instance2D.setCropping({ ...instance2D.getCropping(), showPlanes: false });
      appliedAxisRef.current = axis;
    }
  }, [instance2D, axis, linkToCameraAngle]);

  // How much of the full [0,1] volume extent, per axis, the 2D (left/detail) pane's crop CUBE spans
  // while the camera-angle link is active — centered on the 3D pane's own slice-intersection point
  // (sliceX/Y/Z). A fixed, tunable constant rather than a UI control (scope call for this pass); 0.25
  // was the user's own "like 25%" ask.
  const CROP_FRACTION = 0.25;

  // Continuous camera-angle link ("🔗 3D angle") — REDESIGNED per live correction, replacing an earlier
  // oblique-plane-slicing build that was "fundamentally wrong": there is no plane, and no oblique
  // slicing at all. The mental model (user's own words): imagine a small CUBE sitting at the
  // intersection of the x/y/z slice planes. The cube itself never rotates. The 2D (left) pane is simply
  // a zoomed-in view of that cube's own contents, rendered from EXACTLY the same viewing direction the
  // 3D (right) pane's camera currently has — so "the front of the cube faces the camera" falls out for
  // free (whichever face happens to be toward the shared viewing direction is what's shown), with no
  // explicit plane-normal math needed. Concretely, each tick: copy the 3D pane's camera ROTATION onto
  // the 2D pane (direction + gazeUp, matching `useLinkedWebGpuViewers`'s `camera` group being off, since
  // a full-pose copy would also copy the 3D pane's far-out zoom level), then call
  // `zoomToSliceIntersection` to re-center+zoom onto the cube — this reuses the exact same pure
  // camera-framing function already built for the "⌖" button, just invoked continuously instead of
  // once. The 2D pane's `viewMode` and `cropping.enOblique` are never touched by this mode at all
  // (unlike the earlier build) — it stays plain `"volume"`, cropped to a plain axis-aligned box, which
  // is also why this can't "clobber" the X/Y/Z view modes the way the old design's stale `enOblique`
  // flag did.
  //
  // The cube's CENTER is driven by the 3D (right) pane's own slice position (`sliceX/Y/Z`, set via its
  // slicing UI) — not the 2D pane's — per the user's explicit spec ("when I adjust where the planes are
  // at in the right view... the view on the left should update where the center box is centered"). The
  // 3D pane itself stays fully uncropped (zoomed-out context); only the 2D pane gets the crop box, so
  // the automatic bidirectional `cropping` link is turned off for the duration of this mode (see the
  // `useLinkedWebGpuViewers` call below) — otherwise either pane's next cropping-group event would
  // stomp this asymmetric crop.
  useEffect(() => {
    if (!linkToCameraAngle || !instance2D || !instance3D) return;
    appliedAxisRef.current = null; // force the axis effect to re-apply once the link is turned off

    // The 2D pane's `viewMode` was whatever axis was last selected (e.g. `"zPlane"`) BEFORE this mode
    // activated, and this effect never otherwise touches it — a real bug, found live: left unfixed, the
    // pane keeps applying that plane's thin slab test on top of the crop-cube, so what's actually shown
    // is the (often near-empty) intersection of the old slab and the new cube, not the cube's own full
    // volumetric content. Switch to plain `"volume"` on activation (no camera reframe — `false` — since
    // `applyRotationAndZoom` right below handles the camera itself); the axis-switch effect above already
    // restores the real X/Y/Z mode on deactivation (it force-reapplies because `appliedAxisRef.current`
    // was just reset to `null` above).
    instance2D.setViewMode('volume', false);

    const updateCropBox = (): void => {
      const c3 = instance3D.getCropping();
      const half = CROP_FRACTION / 2;
      const cropMin: [number, number, number] = [
        Math.max(0, c3.sliceX - half),
        Math.max(0, c3.sliceY - half),
        Math.max(0, c3.sliceZ - half),
      ];
      const cropMax: [number, number, number] = [
        Math.min(1, c3.sliceX + half),
        Math.min(1, c3.sliceY + half),
        Math.min(1, c3.sliceZ + half),
      ];
      // sliceX/Y/Z must come along too, not just cropMin/cropMax — `zoomToSliceIntersection` (called
      // right after this, in `applyRotationAndZoom`) recenters using the 2D pane's OWN sliceX/Y/Z, which
      // the automatic `cropping` link never syncs while this mode is active (see this effect's own doc
      // comment) - without this, the crop box moves but the camera doesn't follow it, so the displayed
      // region can pan off-screen as the user adjusts slicing on the right.
      instance2D.setCropping({
        ...instance2D.getCropping(),
        cropMin,
        cropMax,
        sliceX: c3.sliceX,
        sliceY: c3.sliceY,
        sliceZ: c3.sliceZ,
      });
      // Green wireframe-box indicator on the 3D (context) pane, showing exactly the region the 2D
      // (detail) pane is cropped to — same cropMin/cropMax values, so the extents match exactly by
      // construction. Deliberately `setOverlayBox`, not the standard `cropping` link group: the 3D pane
      // must stay uncropped itself (its own cropMin/cropMax stay [0,1]) while still drawing this
      // indicator, which is exactly what `setOverlayBox` is for (see its own doc comment).
      instance3D.setOverlayBox(true, cropMin, cropMax);
    };

    /** Copy the 3D pane's viewing DIRECTION (offset, normalized) + gazeUp onto the 2D pane, preserving
     * the 2D pane's own distance for now — `zoomToSliceIntersection` (called right after) is what
     * actually sets the real target/distance, this just seeds a same-direction starting point for it to
     * preserve-angle-from. One-directional (3D → 2D only, never the reverse): the 2D pane is purely a
     * zoomed-in follower here, matching the spec ("when I rotate the camera on the right view, on the
     * left, i see..."), and one-directional sync can't ping-pong the way a bidirectional link could. */
    const applyRotationAndZoom = (): void => {
      const cam3D = instance3D.getCamera();
      const dst = instance2D.getCamera();
      const [ox, oy, oz] = cam3D.offset;
      const len = Math.hypot(ox, oy, oz) || 1;
      const dist = dst.distance;
      instance2D.setCamera({
        target: dst.target,
        offset: [(ox / len) * dist, (oy / len) * dist, (oz / len) * dist],
        gazeUp: cam3D.gazeUp,
        distance: dist,
      });
      // Zoom distance scaled to the crop box's own size (not the full volume) so it actually fills the
      // frame - zoomToSliceIntersection's zoomFraction is "camera distance as a fraction of the full
      // volume extent," so a box spanning CROP_FRACTION needs roughly that same fraction (with a little
      // headroom for the box's diagonal) rather than the default 0.15 sized for the whole volume.
      instance2D.zoomToSliceIntersection(CROP_FRACTION * 1.8);
    };

    const handle3DCameraChange = (): void => applyRotationAndZoom();
    const handle3DCroppingChange = (): void => {
      updateCropBox();
      applyRotationAndZoom();
    };

    updateCropBox();
    applyRotationAndZoom();
    instance3D.on('cameraChange', handle3DCameraChange);
    instance3D.on('croppingChange', handle3DCroppingChange);
    return () => {
      instance3D.off('cameraChange', handle3DCameraChange);
      instance3D.off('croppingChange', handle3DCroppingChange);
      // Restore the 2D pane's crop to full [0,1] on deactivation - a documented simplification, not
      // restoring whatever custom crop (if any) was active before this mode was turned on. No
      // `enOblique`/`viewMode` cleanup needed here (unlike the old design) - this mode never touches
      // either.
      instance2D.setCropping({ ...instance2D.getCropping(), cropMin: [0, 0, 0], cropMax: [1, 1, 1] });
      instance3D.setOverlayBox(false, [0, 0, 0], [1, 1, 1]);
    };
  }, [linkToCameraAngle, instance2D, instance3D]);

  // 2D is passed as the link's "a" (seed source), 3D as "b": the hook's initial seed alignment always
  // copies the FIRST argument's current state into the second, once, when both instances become ready.
  // The 2D pane's own setViewMode() call above (which also flips on cropping.enZ/enX/enY + showPlanes
  // for its axis) already ran synchronously by the time this effect's seed fires — seeding FROM 2D
  // means the 3D pane inherits that slice-plane-overlay state (exactly the "what's shown in 2D"
  // indicator this split is for). Seeding the other way around would instead stomp the 2D pane's
  // freshly-set cropping with the 3D pane's still-default (no slice enabled) cropping.
  //
  // Cropping is deliberately UNLINKED while `linkToCameraAngle` is active: that mode intentionally
  // gives the 2D (detail) pane its own small crop box (see the effect above) while leaving the 3D
  // (context) pane uncropped — the automatic bidirectional cropping sync would immediately erase that
  // asymmetry (each pane's next cropping-group event would copy its own crop onto the other).
  useLinkedWebGpuViewers(instance2D, instance3D, {
    camera: false,
    rendering: true,
    cropping: !linkToCameraAngle,
    pinViewMode: true,
    pinShowPlanes: true,
    pinHalfRes: true,
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}>
      <div className="split2d3d__toolbar">
        <span className="split2d3d__label">2D slice:</span>
        {(['x', 'y', 'z'] as const).map((a) => (
          <button
            key={a}
            type="button"
            className={[
              'split2d3d__axis-btn',
              !linkToCameraAngle && a === axis ? 'split2d3d__axis-btn--active' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={() => {
              setLinkToCameraAngle(false);
              onAxisChange(a);
            }}
          >
            {AXIS_LABELS[a]}
          </button>
        ))}
        <button
          type="button"
          className={[
            'split2d3d__axis-btn',
            linkToCameraAngle ? 'split2d3d__axis-btn--active' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          title="Zoomed-in cube view: the 2D pane continuously shows the center cube from the 3D pane's own camera angle"
          onClick={() => setLinkToCameraAngle((v) => !v)}
        >
          🔗 3D angle
        </button>
        <button type="button" className="split2d3d__exit" onClick={onExit}>
          ✕ 3D only
        </button>
      </div>
      <div style={{ display: 'flex', flex: 1, minHeight: 0, minWidth: 0 }}>
        {/* 2D slice on the left, 3D volume on the right — neuroglancer-style layout. The 2D pane's own
            HUD is collapsed by default (handle2DReady), so this side is mostly bare canvas. */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <WebGpuNative dataUrl={dataUrl} onReady={handle2DReady} />
        </div>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            borderLeft: '1px solid rgba(255,255,255,0.12)',
          }}
        >
          <WebGpuNative dataUrl={dataUrl} onReady={handle3DReady} />
        </div>
      </div>
    </div>
  );
}
