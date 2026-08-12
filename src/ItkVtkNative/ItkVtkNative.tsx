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
 * Auth: the Tiled Bearer token is attached by a single app-level fetch/XHR interceptor installed
 * in App.jsx (see ./tiledAuth) — one interceptor covers every viewer, so it survives the brief
 * overlap of two live viewers during a tab switch.
 *
 * Resource management: this component captures the viewer instance and, on unmount, calls
 * `getViewProxy().delete()` to free its WebGL context (interactor + renderer + openGLRenderWindow +
 * renderWindow). The itk-vtk-viewer library never does this itself — its own container-empty only
 * removes DOM nodes — so without this each mount would leak a GPU context.
 */

import { useEffect, useRef } from 'react';

const jsDelivrUrl = 'https://cdn.jsdelivr.net/gh/als-computing/itk-vtk-viewer@publish-dist/dist/itkVtkViewer.js';

/** vtk.js camera on the view proxy — enough of its surface to copy pose between linked views. */
export interface ItkVtkCamera {
  getPosition: () => number[];
  getFocalPoint: () => number[];
  getViewUp: () => number[];
  getParallelScale: () => number;
  getViewAngle?: () => number;
  set: (state: Record<string, unknown>) => void;
  onModified: (cb: () => void) => { unsubscribe: () => void };
}

/** The vtk.js ViewProxy handle. `delete()` frees the WebGL context. */
export interface ItkVtkViewProxy {
  delete: () => void;
  resize?: () => void;
  getCamera: () => ItkVtkCamera;
  getRenderer: () => { updateLightsGeometryToFollowCamera: () => void };
  renderLater: () => void;
}

/**
 * The viewer instance returned by createViewerFromUrl (a facade over the vtk view/store/machine).
 *
 * Getters/setters for the volume mirror itk-vtk-viewer's `publicAPI`: each accepts an optional
 * `component` / `name` that default to component 0 of the currently-selected image, so calling them
 * with no args is correct for our one-volume-per-viewer usage. Changes are announced through the
 * event emitter (`on`/`off`); we mirror them across split panes in useLinkedViewers.
 */
export interface ItkVtkViewerInstance {
  getViewProxy: () => ItkVtkViewProxy;
  on: (eventName: string, cb: (...args: unknown[]) => void) => void;
  off: (eventName: string, cb: (...args: unknown[]) => void) => void;

  // Color mapping.
  getImageColorMap: () => unknown;
  setImageColorMap: (colorMap: unknown) => void;
  getImageColorRange: () => number[];
  setImageColorRange: (range: number[]) => void;
  getImageColorRangeBounds: () => number[];
  setImageColorRangeBounds: (range: number[]) => void;

  // Transfer function (opacity) — the reference UI edits either "points" or "gaussians".
  getImagePiecewiseFunctionPoints: () => unknown;
  setImagePiecewiseFunctionPoints: (points: unknown) => void;
  getImagePiecewiseFunctionGaussians: () => unknown;
  setImagePiecewiseFunctionGaussians: (gaussians: unknown) => void;

  // Volume density / rendering controls.
  getImageGradientOpacity: () => unknown;
  setImageGradientOpacity: (opacity: unknown) => void;
  getImageGradientOpacityScale: () => unknown;
  setImageGradientOpacityScale: (scale: unknown) => void;
  getImageVolumeSampleDistance: () => unknown;
  setImageVolumeSampleDistance: (distance: unknown) => void;
  getImageBlendMode: () => unknown;
  setImageBlendMode: (mode: unknown) => void;
  getImageShadowEnabled: () => boolean;
  setImageShadowEnabled: (enabled: boolean) => void;
  getImageInterpolationEnabled: () => boolean;
  setImageInterpolationEnabled: (enabled: boolean) => void;

  // Cropping (ROI) planes.
  getCroppingPlanes: () => unknown;
  setCroppingPlanes: (planes: unknown) => void;
  getCroppingPlanesEnabled: () => boolean;
  setCroppingPlanesEnabled: (enabled: boolean) => void;
}

// The subset of the itk-vtk-viewer global API we use.
type ItkVtkViewerApi = {
  createViewerFromUrl: (
    el: HTMLElement,
    options: { files: string[]; rotate?: boolean; use2D?: boolean },
  ) => Promise<ItkVtkViewerInstance>;
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
  /**
   * Fires with the viewer instance once it has loaded, and with `null` when it is disposed
   * (grace-window expiry / unmount). Used by the split view to wire up linked camera + colormap.
   */
  onReady?: (instance: ItkVtkViewerInstance | null) => void;
};

export default function ItkVktNative({ dataUrl, onReady }: ItkVktProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Hold the latest onReady in a ref so changing the callback identity doesn't re-run the loader.
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    if (!containerRef.current || !dataUrl) return;

    const container = containerRef.current;
    let cancelled = false;
    let instance: ItkVtkViewerInstance | null = null;

    const disposeInstance = () => {
      if (!instance) return;
      try {
        instance.getViewProxy().delete(); // frees the WebGL/VTK render context
      } catch (error) {
        console.warn('ItkVktNative: viewer dispose failed:', error);
      }
      instance = null;
      onReadyRef.current?.(null);
    };

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

    // A viewer created while its tab was hidden (display:none → zero-sized) — or when the window
    // resizes — needs an explicit resize when the container regains size, or the canvas renders
    // black/stretched.
    const resizeObserver = new ResizeObserver(() => {
      if (instance && container.offsetWidth > 0 && container.offsetHeight > 0) {
        try {
          instance.getViewProxy().resize?.();
        } catch {
          /* ignore */
        }
      }
    });
    resizeObserver.observe(container);

    loadItkVtkViewer()
      .then((api) => {
        if (cancelled) return undefined;
        // createViewerFromUrl empties `viewer` and renders the new volume into it.
        return api.createViewerFromUrl(viewer, { files: [dataUrl], rotate: false });
      })
      .then((created) => {
        instance = created ?? null;
        // Unmounted while still loading — dispose immediately so we never leak the context.
        if (cancelled) {
          disposeInstance();
          return;
        }
        if (instance) onReadyRef.current?.(instance);
      })
      .catch((error) => {
        if (!cancelled) {
          console.error('ItkVktNative: failed to load volume:', error);
        }
      });

    return () => {
      cancelled = true;
      resizeObserver.disconnect();
      disposeInstance();
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
