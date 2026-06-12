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

import React, { useEffect, useState } from 'react';
import { Header } from './Header';
import './App.css';


import { getDefaultZarrFileUrl } from './utils';
import { installTiledTokenBridge } from './tiledTokenBridge';
import ItkVktNative from './ItkVtkNative/ItkVtkNative';
// import ItkVtkFrame from './ItkVtkFrame/ItkVtkFrame';

const defaultZarrFileUrl = getDefaultZarrFileUrl() || '';

function App() {
  const [fileUrl, setFileUrl] = useState(defaultZarrFileUrl);
  const fileName = fileUrl.split('/').pop() || '';

  // Answer token requests from the viewer iframe so its zarr requests can be authenticated.
  useEffect(() => installTiledTokenBridge(), []);

  return (
    <div id="app" style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <Header
        logoUrl="images/als_logo_wheel.png"
        title="Tomography Visualizer powered by itk-vtk-viewer"
        fileName={fileName}
        onSelect={setFileUrl}
      />
      <ItkVktNative dataUrl={fileUrl} />
      {/* <ItkVtkFrame dataUrl={fileUrl} /> */}
    </div>
  );
}

export default App;
