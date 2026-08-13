/**
 * App.jsx
 *
 * The main application component: a header, a tab strip, and a viewer stack. Multiple reconstructions
 * can be open at once as tabs, split across a left and right pane. Only live tabs (each pane's active
 * tab + those still inside the 45s keep-alive window) are mounted, so idle WebGL contexts are freed.
 *
 * Split view: every tab belongs to the left or right pane; split is "on" when both panes have a tab.
 * Drag a tab onto a pane (or onto the other tab group) to move it there. The two panes can have their
 * camera / rendering / cropping linked via the toggles (see useLinkedViewers).
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
import WebGpuNative from './WebGpuNative/WebGpuNative';
import { TiledNotifications } from './TiledNotifications';
import { TabBar } from './TabBar';
import { useTabsStore } from './stores/useTabsStore';
import { useLinkedViewers } from './hooks/useLinkedViewers';
import { applyViewState, captureViewState } from './viewerState';
import {
  buildShareUrl,
  copyToClipboard,
  fileIdFromZarrUrl,
  readShareFromLocation,
  zarrUrlFromFileId,
} from './shareLink';

const defaultZarrFileUrl = getDefaultZarrFileUrl() || '';

function App() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeLeftId = useTabsStore((s) => s.activeLeftId);
  const activeRightId = useTabsStore((s) => s.activeRightId);
  const liveIds = useTabsStore((s) => s.liveIds);
  const linkCamera = useTabsStore((s) => s.linkCamera);
  const linkRendering = useTabsStore((s) => s.linkRendering);
  const linkCropping = useTabsStore((s) => s.linkCropping);
  const openTab = useTabsStore((s) => s.openTab);
  const closeTab = useTabsStore((s) => s.closeTab);
  const setActive = useTabsStore((s) => s.setActive);
  const moveTabToPane = useTabsStore((s) => s.moveTabToPane);
  const reorderTab = useTabsStore((s) => s.reorderTab);
  const exitSplit = useTabsStore((s) => s.exitSplit);
  const setLinkCamera = useTabsStore((s) => s.setLinkCamera);
  const setLinkRendering = useTabsStore((s) => s.setLinkRendering);
  const setLinkCropping = useTabsStore((s) => s.setLinkCropping);
  const renderer = useTabsStore((s) => s.renderer);
  const toggleRenderer = useTabsStore((s) => s.toggleRenderer);

  const hasLeft = useMemo(() => tabs.some((t) => t.pane === 'left'), [tabs]);
  const hasRight = useMemo(() => tabs.some((t) => t.pane === 'right'), [tabs]);
  const isSplit = hasLeft && hasRight;
  // The single tab shown when not split (whichever pane holds the tabs).
  const soloId = hasRight && !hasLeft ? activeRightId : activeLeftId;

  // Captured viewer instances keyed by tab id (populated via each pane's onReady). Kept in a ref so
  // capturing an instance doesn't itself trigger a render; `instanceVersion` bumps to recompute the
  // pane instances passed to useLinkedViewers.
  const instancesRef = useRef(new Map());
  const [instanceVersion, setInstanceVersion] = useState(0);
  // View state from a shared link, waiting to be replayed onto its viewer once it loads. Keyed by
  // the tab's zarr url (the tab id isn't known when the deep-link opens the tab).
  const pendingStateRef = useRef(new Map());
  const handleReady = useCallback((id, instance) => {
    if (instance) {
      instancesRef.current.set(id, instance);
      // If this viewer was opened from a shared link, replay the saved camera/colors/cropping now
      // that it's renderable, then consume the pending state so it only applies once.
      const tab = useTabsStore.getState().tabs.find((t) => t.id === id);
      const pending = tab && pendingStateRef.current.get(tab.url);
      if (pending) {
        pendingStateRef.current.delete(tab.url);
        applyViewState(instance, pending);
      }
    } else {
      instancesRef.current.delete(id);
    }
    setInstanceVersion((v) => v + 1);
  }, []);

  // Link the two panes only in split view (each side's active viewer).
  const leftInstance = useMemo(
    () => (isSplit && activeLeftId ? instancesRef.current.get(activeLeftId) ?? null : null),
    [isSplit, activeLeftId, instanceVersion],
  );
  const rightInstance = useMemo(
    () => (isSplit && activeRightId ? instancesRef.current.get(activeRightId) ?? null : null),
    [isSplit, activeRightId, instanceVersion],
  );
  useLinkedViewers(leftInstance, rightInstance, {
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

  // Seed the first tab, once. A shared link (?share=…) wins over the configured default: open its
  // reconstruction and stash the saved view state for handleReady to replay when the viewer loads.
  useEffect(() => {
    const shared = readShareFromLocation();
    if (shared) {
      const url = zarrUrlFromFileId(shared.f);
      pendingStateRef.current.set(url, shared);
      openTab(url);
    } else if (defaultZarrFileUrl) {
      openTab(defaultZarrFileUrl);
    }
  }, [openTab]);

  // The reconstruction a "Share" click captures: in split view the active left pane, else the sole
  // shown tab. Null when nothing is open yet.
  const shareTargetId = isSplit ? activeLeftId : soloId;
  const handleShare = useCallback(async () => {
    if (!shareTargetId) return false;
    const instance = instancesRef.current.get(shareTargetId);
    const tab = useTabsStore.getState().tabs.find((t) => t.id === shareTargetId);
    if (!instance || !tab) return false;
    const fileId = fileIdFromZarrUrl(tab.url);
    if (!fileId) return false;
    const url = buildShareUrl({ ...captureViewState(instance), f: fileId });
    const copied = await copyToClipboard(url);
    if (!copied) {
      // Both clipboard paths failed — surface the link so the user can copy it manually.
      console.warn('Share: could not copy automatically; copy this URL manually:', url);
      window.prompt('Copy this shareable link:', url);
    }
    return copied;
  }, [shareTargetId]);

  // Press Escape to leave split view.
  useEffect(() => {
    if (!isSplit) return;
    const onKey = (e) => {
      if (e.key === 'Escape') exitSplit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isSplit, exitSplit]);

  const paneStyle = (id) => {
    if (isSplit) {
      if (id === activeLeftId) return { left: 0, width: '50%' };
      if (id === activeRightId) return { left: '50%', width: '50%' };
      return { inset: 0, display: 'none' };
    }
    return { inset: 0, display: id === soloId ? 'flex' : 'none' };
  };

  return (
    <div id="app" style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <Header
        logoUrl="images/als_logo_wheel.png"
        title="Tomography Visualizer powered by itk-vtk-viewer"
        onSelect={openTab}
        onShare={handleShare}
        canShare={!!shareTargetId}
        renderer={renderer}
        onToggleRenderer={toggleRenderer}
      />
      <TabBar
        tabs={tabs}
        activeLeftId={activeLeftId}
        activeRightId={activeRightId}
        onActivate={setActive}
        onClose={closeTab}
        onReorder={reorderTab}
        onMoveToPane={moveTabToPane}
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
              {renderer === 'webgpu' ? (
                <WebGpuNative dataUrl={t.url} />
              ) : (
                <ItkVktNative dataUrl={t.url} onReady={(instance) => handleReady(t.id, instance)} />
              )}
            </div>
          ))}
        {isSplit && <div className="viewer-divider" />}
        {isSplit && (
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
            <button type="button" className="viewer-link-controls__exit" onClick={() => exitSplit()}>
              ✕ Exit split
            </button>
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
