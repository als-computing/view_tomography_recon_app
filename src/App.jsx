/**
 * App.jsx
 *
 * The main application component. Renders a top header bar and an iframe that
 * takes up the remaining vertical space in the window.
 *
 * Usage:
 *   <App />
 *
 * @return {JSX.Element} A full-page layout with a header and auto-resizing iframe.
 */

import React, { useState } from 'react';
import { Header } from './Header';
import ItkVtkViewerComponent from './ItkVtkViewerComponent';
import './App.css';

function App() {
  const { protocol, hostname } = window.location;
  const port = import.meta.env.VITE_TILED_PORT ?? '8787';

  const defaultFileId = 'rec20240425_104614_nist-sand-30-100_27keV_z8mm_n2625';
  const defaultFileUrl = `${protocol}//${hostname}:${port}/zarr/v2/${defaultFileId}`;

  const [fileUrl, setFileUrl] = useState(defaultFileUrl);
  const fileName = fileUrl.split('/').pop() || '';

  const iframeSrc = `${protocol}//${hostname}:${port}/viewer/?fileToLoad=${encodeURIComponent(fileUrl)}`;

  return (
    <div id="app">
      <Header
        logoUrl="/images/als_logo_wheel.png"
        title="Tomography Visualizer powered by itk-vtk-viewer"
        fileName={fileName}
        onSelect={setFileUrl}
      />
      <ItkVtkViewerComponent
        src={iframeSrc}
        height="100%"
        flex="1"
      />
    </div>
  );
}

export default App;
