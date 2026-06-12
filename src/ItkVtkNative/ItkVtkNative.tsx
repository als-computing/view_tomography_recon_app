/**
 * ItkVkt.tsx
 *
 * Inline (non-iframe) variant of the ITK/VTK viewer. Instead of writing the viewer into an iframe
 * document, it renders the `.itk-vtk-viewer` element directly in the main DOM and loads the
 * itk-vtk-viewer CDN bundle, which scans for that element and renders the volume from its
 * `data-url`.
 *
 * Auth: since everything runs in the main window, fetch/XHR are patched in-place (see ./tiledAuth)
 * to attach the Tiled Bearer token — no iframe, no postMessage.
 */

import { useEffect, useRef } from 'react';
import { installTiledFetchInterceptor } from './tiledAuth';

const jsDelivrUrl = 'https://cdn.jsdelivr.net/gh/als-computing/itk-vtk-viewer@publish-dist/dist/itkVtkViewer.js';

type ItkVktProps = {
  dataUrl?: string;
};

export default function ItkVktNative({ dataUrl }: ItkVktProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!containerRef.current || !dataUrl) return;

    const container = containerRef.current;

    // Patch fetch/XHR so the viewer's zarr requests to the data origin are authenticated.
    const removeInterceptor = installTiledFetchInterceptor(dataUrl);

    // Build the element the itk-vtk-viewer bundle looks for.
    const viewer = document.createElement('div');
    viewer.className = 'itk-vtk-viewer';
    viewer.dataset.url = dataUrl;
    viewer.dataset.rotate = 'false';
    // Fill the parent container (the space left below the header), not the whole browser window.
    // The bundle reads this and writes the values onto the element's style.width/height.
    viewer.dataset.viewport = '100%x100%';
    viewer.style.width = '100%';
    viewer.style.height = '100%';
    container.appendChild(viewer);

    // Load the viewer bundle, which scans for .itk-vtk-viewer elements and renders them.
    const script = document.createElement('script');
    script.src = jsDelivrUrl;
    document.body.appendChild(script);

    return () => {
      removeInterceptor();
      script.remove();
      container.innerHTML = '';
    };
  }, [dataUrl]);

  if (!dataUrl) {
    return <div style={{ textAlign: 'center', marginTop: '3rem' }}>Please select a data set to start the viewer</div>;
  }

  return (
    <div
      key={dataUrl}
      ref={containerRef}
      style={{ flex: 1, minHeight: 0, width: '100%', zIndex: 0 }}
    />
  );
}
