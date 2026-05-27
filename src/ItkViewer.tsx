const jsDelivrUrl = 'https://cdn.jsdelivr.net/gh/als-computing/itk-vtk-viewer@publish-dist/dist/itkVtkViewer.js';

import React, { useEffect, useState, useRef } from 'react';

type ItkViewerProps = {
    dataUrl?: string;
};

export default function ItkViewer({ dataUrl }: ItkViewerProps) {
  



  if (!dataUrl) {
    return <div style={{textAlign: 'center', marginTop: '3rem'}}>Please select a data set to start the viewer</div>;
  } else {
      return (
        <>
        <div 
          className="itk-vtk-viewer"
          data-url="${dataUrl}"
          data-rotate="false"
          data-viewport="100vwx100vh"
          style="width: 100vw; height: 100vh;"
        ></div>
        <script>
          // Wait 3 seconds for service worker to set up before loading ITK viewer
          setTimeout(function() {
            var script = document.createElement('script');
            script.src = '${jsDelivrUrl}';
            document.body.appendChild(script);
          }, 3000);
        </script>
        
        </>

      );
  }
}