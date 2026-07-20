/**
 * ItkVkt.tsx
 *
 * Inline (non-iframe) variant of the ITK/VTK viewer. It renders a container element directly in
 * the main DOM and loads the itk-vtk-viewer CDN bundle, then renders the volume from its URL.
 *
 * The bundle is loaded exactly once for the whole app. Each time `dataUrl` changes we call the
 * bundle's `createViewerFromUrl(container, { files })` directly rather than relying on its
 * DOM auto-scan: that scan (`initializeEmbeddedViewers`) is guarded by a one-shot global flag and
 * a per-element `dataset.loaded` flag, so it only ever renders a `.itk-vtk-viewer` element the
 * first time the script runs — which meant a second volume could never load. Driving the loader
 * directly (it empties the container first) makes every subsequent load work.
 *
 * Auth: since everything runs in the main window, fetch/XHR are patched in-place (see ./tiledAuth)
 * to attach the Tiled Bearer token — no iframe, no postMessage.
 */

import { useEffect, useRef } from 'react';
import { installTiledFetchInterceptor } from './tiledAuth';

const jsDelivrUrl = 'https://cdn.jsdelivr.net/gh/als-computing/itk-vtk-viewer@publish-dist/dist/itkVtkViewer.js';

// The subset of the itk-vtk-viewer global API we use.
type ItkVtkViewerApi = {
  createViewerFromUrl: (
    el: HTMLElement,
    options: { files: string[]; rotate?: boolean; use2D?: boolean },
  ) => Promise<unknown>;
};

declare global {
  interface Window {
    itkVtkViewer?: ItkVtkViewerApi;
  }
}

// Load the CDN bundle a single time and reuse it across every volume load. The bundle exposes
// itself on `window.itkVtkViewer` when it finishes executing.
let bundlePromise: Promise<ItkVtkViewerApi> | null = null;
const loadItkVtkViewer = (): Promise<ItkVtkViewerApi> => {
  if (window.itkVtkViewer) {
    return Promise.resolve(window.itkVtkViewer);
  }
  if (!bundlePromise) {
    bundlePromise = new Promise<ItkVtkViewerApi>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = jsDelivrUrl;
      script.async = true;
      script.onload = () => {
        if (window.itkVtkViewer) {
          resolve(window.itkVtkViewer);
        } else {
          reject(new Error('itk-vtk-viewer bundle loaded but window.itkVtkViewer is undefined'));
        }
      };
      script.onerror = () => {
        bundlePromise = null; // allow a retry on a later mount
        reject(new Error('Failed to load itk-vtk-viewer bundle'));
      };
      document.body.appendChild(script);
    });
  }
  return bundlePromise;
};

type ItkVktProps = {
  dataUrl?: string;
};

export default function ItkVktNative({ dataUrl }: ItkVktProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!containerRef.current || !dataUrl) return;

    const container = containerRef.current;
    let cancelled = false;

    // Keep the token attached for the whole lifetime of this volume: zarr chunks load lazily as
    // the user pans/zooms, not just during the initial load.
    const removeInterceptor = installTiledFetchInterceptor(dataUrl);

    // Render into a fresh inner element sized to fill the container (mirrors the sizing the
    // bundle's auto-scan applied for data-viewport='100%x100%'). It deliberately has no
    // `.itk-vtk-viewer` class, so the bundle's one-shot auto-scan ignores it and we stay in
    // control of loading. Passing this inner div (rather than the flex container itself) keeps
    // the viewer from taking over the app layout and hiding the header.
    const viewer = document.createElement('div');
    viewer.style.position = 'relative';
    viewer.style.width = '100%';
    viewer.style.height = '100%';
    container.appendChild(viewer);

    loadItkVtkViewer()
      .then((api) => {
        if (cancelled) return;
        // createViewerFromUrl empties `viewer` and renders the new volume into it.
        return api.createViewerFromUrl(viewer, { files: [dataUrl], rotate: false });
      })
      .catch((error) => {
        if (!cancelled) {
          console.error('ItkVktNative: failed to load volume:', error);
        }
      });

    return () => {
      cancelled = true;
      removeInterceptor();
      container.innerHTML = '';
    };
  }, [dataUrl]);

  if (!dataUrl) {
    return <div style={{ textAlign: 'center', marginTop: '3rem' }}>Please select a data set to start the viewer</div>;
  }

  return (
    <div
      ref={containerRef}
      style={{ flex: 1, minHeight: 0, width: '100%', zIndex: 0 }}
    />
  );
}
