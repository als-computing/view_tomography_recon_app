/**
 * WebGpuNative.tsx
 *
 * React wrapper around the standalone WebGPU OME-Zarr renderer under src/zarr-viewer/. That renderer
 * isn't a component — it's an imperative `run(canvas, { zarrUrl })` that boots a WebGPU volume view
 * (with its own built-in HUD) into a canvas and returns a disposable handle. We mirror the shape and
 * lifecycle of ItkVtkNative so this drops into the same viewer-pane slot: create a canvas, boot the
 * renderer for `dataUrl`, and dispose it on unmount / dataUrl change.
 *
 * Auth: the renderer fetches zarr chunks with a plain `fetch()`. Those requests hit the Tiled origin
 * and so are transparently given the Bearer token by the app-level fetch/XHR interceptor installed in
 * App.jsx (see ItkVtkNative/tiledAuth) — no auth code is needed here.
 *
 * Data format: the renderer expects an OME-NGFF (multiscales) Zarr v2 store root; if the Tiled item
 * isn't that (or uses an unsupported codec) `run()` shows its own error HUD.
 */

import { useEffect, useRef } from 'react';
import { run, type WebGpuViewerInstance } from '../zarr-viewer/src/ome-zarr-viewer';

export type { WebGpuViewerInstance } from '../zarr-viewer/src/ome-zarr-viewer';

/**
 * Whether the WebGPU renderer can run, with a human-readable reason when it can't. WebGPU is gated
 * on a *secure context* (https / localhost) — served over plain http, `navigator.gpu` is undefined —
 * so we distinguish "insecure context" from "browser has no WebGPU" for a clearer message.
 */
export function webGpuAvailability(): { ok: boolean; reason: string } {
  if (typeof navigator !== 'undefined' && (navigator as Navigator & { gpu?: unknown }).gpu) {
    return { ok: true, reason: '' };
  }
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return {
      ok: false,
      reason: 'WebGPU needs a secure context (https, or localhost) — this app is served over http.',
    };
  }
  return { ok: false, reason: 'WebGPU is not available in this browser (needs Chrome/Edge 113+).' };
}

type WebGpuNativeProps = {
  dataUrl?: string;
  /**
   * Fires with the viewer instance once `run()` returns its handle, and with `null` when it is
   * disposed (unmount / dataUrl change). Used by the split view to link camera + rendering + cropping
   * across two WebGPU panes (mirrors ItkVtkNative's onReady).
   */
  onReady?: (instance: WebGpuViewerInstance | null) => void;
};

export default function WebGpuNative({ dataUrl, onReady }: WebGpuNativeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Hold the latest onReady in a ref so changing the callback identity doesn't re-run the renderer.
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    if (!containerRef.current || !dataUrl || !webGpuAvailability().ok) return;

    const container = containerRef.current;
    let cancelled = false;
    let handle: WebGpuViewerInstance | null = null;

    // Docked layout: canvas fills a flex:1 host on the left, the Finch HUD lives in a fixed-width
    // sidebar on the right. Because the renderer's stage is `canvas.parentElement` (canvasHost) and
    // its per-frame loop re-fits the canvas backing store to its CSS box, shrinking the canvas beside
    // the sidebar "just works" — hidden→visible panes self-correct on the next frame.
    const canvasHost = document.createElement('div');
    canvasHost.style.flex = '1';
    canvasHost.style.minWidth = '0';
    canvasHost.style.position = 'relative';

    const canvas = document.createElement('canvas');
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvasHost.appendChild(canvas);

    const sidebarHost = document.createElement('div');
    sidebarHost.style.width = '320px';
    sidebarHost.style.flexShrink = '0';
    sidebarHost.style.overflow = 'auto';

    container.appendChild(canvasHost);
    container.appendChild(sidebarHost);

    run(canvas, { zarrUrl: dataUrl, hudMount: sidebarHost })
      .then((created) => {
        if (cancelled) {
          created.dispose();
          return;
        }
        handle = created;
        onReadyRef.current?.(created);
      })
      .catch((error) => {
        if (!cancelled) console.error('WebGpuNative: failed to start renderer:', error);
      });

    return () => {
      cancelled = true;
      try {
        handle?.dispose();
      } catch (error) {
        console.warn('WebGpuNative: dispose failed:', error);
      }
      if (handle) onReadyRef.current?.(null);
      container.innerHTML = '';
    };
  }, [dataUrl]);

  if (!dataUrl) {
    return <div style={{ textAlign: 'center', marginTop: '3rem' }}>Please select a data set to start the viewer</div>;
  }
  const availability = webGpuAvailability();
  if (!availability.ok) {
    return (
      <div style={{ textAlign: 'center', marginTop: '3rem' }}>
        {availability.reason} Switch back to the ITK renderer.
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{ flex: 1, minHeight: 0, width: '100%', position: 'relative', display: 'flex', flexDirection: 'row' }}
    />
  );
}
