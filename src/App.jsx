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
import ItkVtkViewer from './ItkVtkViewer';
import './App.css';


import { getDefaultZarrFileUrl } from './utils';

const defaultZarrFileUrl = getDefaultZarrFileUrl() || '';

function App() {
  const [fileUrl, setFileUrl] = useState(defaultZarrFileUrl);
  const fileName = fileUrl.split('/').pop() || '';

  return (
    <div id="app" style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <Header
        logoUrl="images/als_logo_wheel.png"
        title="Tomography Visualizer powered by itk-vtk-viewer"
        fileName={fileName}
        onSelect={setFileUrl}
      />
      <ItkVtkViewer dataUrl={fileUrl} />
    </div>
  );
}

export default App;
