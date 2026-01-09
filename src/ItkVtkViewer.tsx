const jsDelivrUrl = 'https://cdn.jsdelivr.net/gh/als-computing/itk-vtk-viewer@publish-dist/dist/itkVtkViewer.js';

import React, { useEffect, useState, useRef } from 'react';

type ItkVtkViewerProps = {
    dataUrl?: string;
};

export default function ItkVtkViewer({ dataUrl }: ItkVtkViewerProps) {
  const [size, setSize] = useState({ width: 400, height: 401 });
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    if (!iframeRef.current || !dataUrl) return;

    const iframe = iframeRef.current;
    const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
    
    if (!iframeDoc) return;

    // Create iframe content
    iframeDoc.open();
    iframeDoc.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { 
            margin: 0; 
            padding: 0; 
            overflow: hidden;
            font-family: Arial, sans-serif;
          }
        </style>
      </head>
      <body>
        <div 
          class="itk-vtk-viewer"
          data-url="${dataUrl}"
          data-rotate="false"
          data-viewport="100vwx100vh"
          style="width: 100vw; height: 100vh;"
        ></div>
        <script src="${jsDelivrUrl}"></script>
      </body>
      </html>
    `);
    iframeDoc.close();

  }, [dataUrl]);

  useEffect(() => {
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });

    if (iframeRef.current) {
      resizeObserver.observe(iframeRef.current);
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  if (!dataUrl) {
    return <div style={{textAlign: 'center', marginTop: '3rem'}}>Please select a data set to start the viewer</div>;
  } else {
      return (
        <iframe
          key={dataUrl}
          ref={iframeRef}
          style={{
            width: '100%', 
            height: '100%'
          }}
          title="ITK VTK Viewer"
        />
      );
  }
}