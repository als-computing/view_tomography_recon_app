/**
 * useLinkedViewers.ts
 *
 * Keeps two split-pane viewers in sync. Three independent groups can be linked:
 *   - camera:    rotation / pan / zoom (vtk.js view-proxy camera)
 *   - rendering: everything that shapes the volume's appearance — colormap, color range (+bounds),
 *                the opacity transfer function (points + gaussians), gradient opacity (+scale),
 *                volume sample distance, blend mode, shadow, interpolation
 *   - cropping:  the ROI cropping planes (+ enabled state)
 *
 * Each group is bidirectional (changing either pane drives the other). A single re-entrancy guard
 * shared across the whole hook prevents an applied change from echoing back and looping: while we
 * push a value into one viewer, the change events it emits back are ignored. The guard is released
 * synchronously after each apply, so distinct user actions (and the initial A→B alignment of every
 * property) are never dropped.
 *
 * All method/event names mirror itk-vtk-viewer's `publicAPI`; the getters/setters default to
 * component 0 of the selected image, which is correct for our one-volume-per-viewer usage. When
 * either instance is null (a pane isn't live yet, or split is closed) the hook is inert.
 */

import { useEffect } from 'react';
import type { ItkVtkViewerInstance } from '../ItkVtkNative/ItkVtkNative';
import { CROPPING_MIRRORS, RENDERING_MIRRORS, copyCamera, type Mirror } from '../viewerState';

interface LinkOptions {
  camera: boolean;
  rendering: boolean;
  cropping: boolean;
}

interface Subscription {
  unsubscribe: () => void;
}

export function useLinkedViewers(
  a: ItkVtkViewerInstance | null,
  b: ItkVtkViewerInstance | null,
  { camera, rendering, cropping }: LinkOptions,
): void {
  useEffect(() => {
    if (!a || !b) return;

    // While we push a value into one viewer, ignore the change events it emits back so the two
    // panes don't ping-pong. Released synchronously after each apply so independent user actions
    // (and the initial per-property A→B alignment loop below) are never swallowed.
    let syncing = false;
    const withGuard = (fn: () => void) => {
      if (syncing) return;
      syncing = true;
      try {
        fn();
      } catch (error) {
        console.warn('useLinkedViewers: sync failed:', error);
      } finally {
        syncing = false;
      }
    };

    const subs: Subscription[] = [];

    if (camera) {
      const viewA = a.getViewProxy();
      const viewB = b.getViewProxy();
      const syncCamera = (from = viewA, to = viewB) =>
        withGuard(() => {
          copyCamera(from.getCamera(), to.getCamera());
          to.getRenderer().updateLightsGeometryToFollowCamera();
          to.renderLater();
        });

      subs.push(viewA.getCamera().onModified(() => syncCamera(viewA, viewB)));
      subs.push(viewB.getCamera().onModified(() => syncCamera(viewB, viewA)));
      // Align the panes immediately (copy the active/left pane's pose onto the split/right pane).
      syncCamera(viewA, viewB);
    }

    // Wire a group of mirrored properties bidirectionally between a and b.
    const wireMirrors = (mirrors: Mirror[]) => {
      for (const mirror of mirrors) {
        const apply = (from: ItkVtkViewerInstance, to: ItkVtkViewerInstance) => () =>
          withGuard(() => {
            const value = mirror.read(from);
            if (typeof value !== 'undefined') mirror.write(to, value);
          });
        const handlerAB = apply(a, b);
        const handlerBA = apply(b, a);
        for (const event of mirror.events) {
          a.on(event, handlerAB);
          b.on(event, handlerBA);
        }
        subs.push({
          unsubscribe: () => {
            for (const event of mirror.events) {
              a.off(event, handlerAB);
              b.off(event, handlerBA);
            }
          },
        });
        // Seed the split pane with the active pane's current value for this property.
        handlerAB();
      }
    };

    if (rendering) wireMirrors(RENDERING_MIRRORS);
    if (cropping) wireMirrors(CROPPING_MIRRORS);

    return () => {
      for (const sub of subs) {
        try {
          sub.unsubscribe();
        } catch {
          /* ignore */
        }
      }
    };
  }, [a, b, camera, rendering, cropping]);
}
