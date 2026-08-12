/**
 * App.jsx
 *
 * The main application component: a header, a tab strip, and a viewer stack that shows the active
 * reconstruction. Multiple reconstructions can be open at once as tabs; only live tabs (active +
 * those still inside the 45s keep-alive window) are mounted, so idle WebGL contexts are released.
 *
 * @return {JSX.Element}
 */

import React, { useEffect } from 'react';
import { Header } from './Header';
import './App.css';

import { getDefaultZarrFileUrl, getTiledBaseUrl, TILED_PROCESSED_PATH } from './utils';
import { installTiledTokenBridge } from './tiledTokenBridge';
import { installTiledFetchInterceptor } from './ItkVtkNative/tiledAuth';
import ItkVktNative from './ItkVtkNative/ItkVtkNative';
import { TiledNotifications } from './TiledNotifications';
import { TabBar } from './TabBar';
import { useTabsStore } from './stores/useTabsStore';

const defaultZarrFileUrl = getDefaultZarrFileUrl() || '';

function App() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeId = useTabsStore((s) => s.activeId);
  const liveIds = useTabsStore((s) => s.liveIds);
  const openTab = useTabsStore((s) => s.openTab);
  const closeTab = useTabsStore((s) => s.closeTab);
  const setActive = useTabsStore((s) => s.setActive);
  const reorderTabs = useTabsStore((s) => s.reorderTabs);

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
      />
      <div className="viewer-stack">
        {tabs
          .filter((t) => liveIds.has(t.id))
          .map((t) => (
            <div
              key={t.id}
              className="viewer-pane"
              style={{ display: t.id === activeId ? 'flex' : 'none', flexDirection: 'column' }}
            >
              <ItkVktNative dataUrl={t.url} />
            </div>
          ))}
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
