/**
 * useLinkedWebGpuViewers.ts
 *
 * The WebGPU (OME-Zarr) analogue of useLinkedViewers: keeps two split-pane WebGPU viewers in sync.
 * The same three groups can be linked independently, gated by the same store toggles:
 *   - camera:    orbit target / offset / gaze-up / distance (the full trackball pose)
 *   - rendering: colormap, color range, opacity curve (+scale), density, exposure, sample distance,
 *                blend mode, gradient opacity (+scale), lighting, view mode
 *   - cropping:  the ROI crop box + slice planes (positions, per-axis enables, overlay visibility)
 *
 * Each group is bidirectional (changing either pane drives the other). A single re-entrancy guard
 * shared across the hook prevents an applied change from echoing back and looping: while we push a
 * value into one viewer, the change events it emits back are ignored. It's released synchronously
 * after each apply, so distinct user actions (and the initial A→B alignment) are never dropped.
 *
 * The WebGpuViewerInstance is designed to make this safe: its set* methods never emit change events
 * (only genuine user actions do), and setCamera re-baselines the render-loop poll so an applied pose
 * is never re-announced. When either instance is null (a pane isn't live, or split is closed, or the
 * app is on the ITK renderer) the hook is inert.
 */

import { useEffect } from 'react';
import type {
  WebGpuViewerEvent,
  WebGpuViewerInstance,
} from '../zarr-viewer/src/ome-zarr-viewer';

interface LinkOptions {
  camera: boolean;
  rendering: boolean;
  cropping: boolean;
}

export function useLinkedWebGpuViewers(
  a: WebGpuViewerInstance | null,
  b: WebGpuViewerInstance | null,
  { camera, rendering, cropping }: LinkOptions,
): void {
  useEffect(() => {
    if (!a || !b) return;

    // While we push a value into one viewer, ignore the change events it emits back so the two panes
    // don't ping-pong. Released synchronously after each apply so independent user actions (and the
    // initial A→B alignment below) are never swallowed.
    let syncing = false;
    const withGuard = (fn: () => void): void => {
      if (syncing) return;
      syncing = true;
      try {
        fn();
      } catch (error) {
        console.warn('useLinkedWebGpuViewers: sync failed:', error);
      } finally {
        syncing = false;
      }
    };

    const unsubscribes: Array<() => void> = [];

    // Wire one group bidirectionally: on either pane's change event, copy that group's state to the
    // other. `seed` performs the initial A→B alignment for the group.
    const wireGroup = (
      event: WebGpuViewerEvent,
      copy: (from: WebGpuViewerInstance, to: WebGpuViewerInstance) => void,
    ): void => {
      const handlerAB = (): void => withGuard(() => copy(a, b));
      const handlerBA = (): void => withGuard(() => copy(b, a));
      a.on(event, handlerAB);
      b.on(event, handlerBA);
      unsubscribes.push(() => {
        a.off(event, handlerAB);
        b.off(event, handlerBA);
      });
      // Align the split pane with the active pane's current value for this group.
      handlerAB();
    };

    if (camera) {
      wireGroup('cameraChange', (from, to) => to.setCamera(from.getCamera()));
    }
    if (rendering) {
      wireGroup('renderingChange', (from, to) => to.setRendering(from.getRendering()));
    }
    if (cropping) {
      wireGroup('croppingChange', (from, to) => to.setCropping(from.getCropping()));
    }

    return () => {
      for (const unsubscribe of unsubscribes) {
        try {
          unsubscribe();
        } catch {
          /* ignore */
        }
      }
    };
  }, [a, b, camera, rendering, cropping]);
}
