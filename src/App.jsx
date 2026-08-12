/**
 * App.jsx
 *
 * The main application component: a header, a tab strip, and a viewer stack that shows the active
 * reconstruction. Multiple reconstructions can be open at once as tabs; only live tabs (active +
 * split pane + those still inside the 45s keep-alive window) are mounted, so idle WebGL contexts
 * are released.
 *
 * Split view: dragging a tab onto the viewer stack opens a second (right) pane. The two panes can
 * have their camera and/or colormap linked via the toggles (see useLinkedViewers).
 *
 * @return {JSX.Element}
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Header } from './Header';
import './App.css';

import { getDefaultZarrFileUrl, getTiledBaseUrl, TILED_PROCESSED_PATH } from './utils';
import { installTiledTokenBridge } from './tiledTokenBridge';
import { installTiledFetchInterceptor } from './ItkVtkNative/tiledAuth';
import ItkVktNative from './ItkVtkNative/ItkVtkNative';
import { TiledNotifications } from './TiledNotifications';
import { TabBar, TAB_DND_MIME } from './TabBar';
import { useTabsStore } from './stores/useTabsStore';
import { useLinkedViewers } from './hooks/useLinkedViewers';

const defaultZarrFileUrl = getDefaultZarrFileUrl() || '';

function App() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeId = useTabsStore((s) => s.activeId);
  const splitId = useTabsStore((s) => s.splitId);
  const liveIds = useTabsStore((s) => s.liveIds);
  const linkCamera = useTabsStore((s) => s.linkCamera);
  const linkRendering = useTabsStore((s) => s.linkRendering);
  const linkCropping = useTabsStore((s) => s.linkCropping);
  const openTab = useTabsStore((s) => s.openTab);
  const closeTab = useTabsStore((s) => s.closeTab);
  const setActive = useTabsStore((s) => s.setActive);
  const setSplit = useTabsStore((s) => s.setSplit);
  const reorderTabs = useTabsStore((s) => s.reorderTabs);
  const setLinkCamera = useTabsStore((s) => s.setLinkCamera);
  const setLinkRendering = useTabsStore((s) => s.setLinkRendering);
  const setLinkCropping = useTabsStore((s) => s.setLinkCropping);

  // Captured viewer instances keyed by tab id (populated via each pane's onReady). Kept in a ref so
  // capturing an instance doesn't itself trigger a render; `instanceVersion` bumps to recompute the
  // active/split instances passed to useLinkedViewers.
  const instancesRef = useRef(new Map());
  const [instanceVersion, setInstanceVersion] = useState(0);
  const handleReady = useCallback((id, instance) => {
    if (instance) instancesRef.current.set(id, instance);
    else instancesRef.current.delete(id);
    setInstanceVersion((v) => v + 1);
  }, []);

  // Whether a tab is currently being dragged (drives the split drop overlay on the viewer stack).
  const [isTabDragging, setIsTabDragging] = useState(false);

  const activeInstance = useMemo(
    () => (activeId ? instancesRef.current.get(activeId) ?? null : null),
    [activeId, instanceVersion],
  );
  const splitInstance = useMemo(
    () => (splitId ? instancesRef.current.get(splitId) ?? null : null),
    [splitId, instanceVersion],
  );
  useLinkedViewers(activeInstance, splitInstance, {
    camera: linkCamera,
    rendering: linkRendering,
    cropping: linkCropping,
  });

  // Answer token requests from the (legacy) viewer iframe.
  useEffect(() => installTiledTokenBridge(), []);

  // Attach the Tiled Bearer token to every viewer's zarr requests via a SINGLE app-level fetch/XHR
  // interceptor (installed once for the Tiled origin). One interceptor covers all viewers, so it
  // survives the brief overlap of two live viewers during a tab switch.
  useEffect(() => installTiledFetchInterceptor(getTiledBaseUrl()), []);

  // Open the configured default reconstruction as the first tab, once.
  useEffect(() => {
    if (defaultZarrFileUrl) openTab(defaultZarrFileUrl);
  }, [openTab]);

  const paneStyle = (id) => {
    if (splitId) {
      if (id === activeId) return { left: 0, width: '50%' };
      if (id === splitId) return { left: '50%', width: '50%' };
      return { inset: 0, display: 'none' };
    }
    return { inset: 0, display: id === activeId ? 'flex' : 'none' };
  };

  const handleSplitDrop = (e) => {
    e.preventDefault();
    const id = e.dataTransfer.getData(TAB_DND_MIME);
    setIsTabDragging(false);
    if (id) setSplit(id);
  };

  return (
    <div id="app" style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <Header
        logoUrl="images/als_logo_wheel.png"
        title="Tomography Visualizer powered by itk-vtk-viewer"
        onSelect={openTab}
      />
      <TabBar
        tabs={tabs}
        activeId={activeId}
        onActivate={setActive}
        onClose={closeTab}
        onReorder={reorderTabs}
        onTabDragStart={() => setIsTabDragging(true)}
        onTabDragEnd={() => setIsTabDragging(false)}
      />
      <div className="viewer-stack">
        {tabs
          .filter((t) => liveIds.has(t.id))
          .map((t) => (
            <div
              key={t.id}
              className="viewer-pane"
              style={{ flexDirection: 'column', display: 'flex', ...paneStyle(t.id) }}
            >
              <ItkVktNative dataUrl={t.url} onReady={(instance) => handleReady(t.id, instance)} />
            </div>
          ))}
        {splitId && <div className="viewer-divider" />}
        {splitId && (
          <div className="viewer-link-controls">
            <span className="viewer-link-controls__label">Link:</span>
            <label>
              <input
                type="checkbox"
                checked={linkCamera}
                onChange={(e) => setLinkCamera(e.target.checked)}
              />
              Camera
            </label>
            <label title="Colormap, color range, transfer function, gradient opacity, blend mode, shadow…">
              <input
                type="checkbox"
                checked={linkRendering}
                onChange={(e) => setLinkRendering(e.target.checked)}
              />
              Rendering
            </label>
            <label>
              <input
                type="checkbox"
                checked={linkCropping}
                onChange={(e) => setLinkCropping(e.target.checked)}
              />
              Cropping
            </label>
            <button type="button" onClick={() => setSplit(null)}>
              Exit split
            </button>
          </div>
        )}
        {/* Drop zone shown only while a tab is being dragged; dropping opens/updates the split pane. */}
        {isTabDragging && (
          <div
            className="viewer-drop-overlay"
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
            }}
            onDrop={handleSplitDrop}
          >
            <span className="viewer-drop-hint">Drop here to open a split view</span>
          </div>
        )}
        {tabs.length === 0 && (
          <div className="viewer-empty">Please select a data set to start the viewer</div>
        )}
      </div>
      {/* Live "new reconstruction ready" toasts (+ OS notification) for the signed-in user's ESAFs. */}
      <TiledNotifications parentPath={TILED_PROCESSED_PATH} onView={openTab} />
    </div>
  );
}

export default App;
