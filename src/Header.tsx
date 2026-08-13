import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import './header.css';
import { Tiled, TiledItemLinks } from '@blueskyproject/tiled';
import '@blueskyproject/tiled/style.css';
import {
  createZarrFileUrlFromTiledItem,
  fetchTiledContainerChildren,
  getTiledBaseUrl,
  TILED_PROCESSED_PATH,
} from './utils';
import type { RendererKind } from './stores/useTabsStore';
import { webGpuAvailability } from './WebGpuNative/WebGpuNative';

export interface HeaderProps {
  logoUrl: string;
  title: string;
  /**
   * Callback that receives the selected file URL.
   */
  onSelect?: (file_url: string) => void;
  /**
   * Copy a shareable link for the current reconstruction/view to the clipboard. Resolves true when
   * the link was copied (drives the transient "Copied!" confirmation).
   */
  onShare?: () => Promise<boolean> | boolean;
  /** Whether there's an active reconstruction to share (disables the button when false). */
  canShare?: boolean;
  /** The app-wide volume renderer currently in use. */
  renderer?: RendererKind;
  /** Flip the app-wide volume renderer between itk and webgpu. */
  onToggleRenderer?: () => void;
}

export const Header = ({
  logoUrl,
  title,
  onSelect,
  onShare,
  canShare = false,
  renderer = 'itk',
  onToggleRenderer,
}: HeaderProps) => {
  const [selectedFolder, setSelectedFolder] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);

  const handleShareClick = async () => {
    if (!onShare) return;
    const ok = await onShare();
    if (!ok) return;
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1500);
  };

  // Server state: the subfolders under the processed path that populate the folder dropdown.
  // TanStack Query handles caching, retries, and refetch-on-focus (so it recovers once the user
  // logs in on an auth-required server).
  const { data: folders = [], isLoading, isError } = useQuery({
    queryKey: ['tiled-children', TILED_PROCESSED_PATH],
    queryFn: ({ signal }) => fetchTiledContainerChildren(TILED_PROCESSED_PATH, signal),
  });
  const status: 'loading' | 'ready' | 'error' = isLoading ? 'loading' : isError ? 'error' : 'ready';

  // Default the selection once folders load (preserve the app's previous default of 'dabramov').
  useEffect(() => {
    if (!selectedFolder && folders.length > 0) {
      setSelectedFolder(folders.includes('dabramov') ? 'dabramov' : folders[0]);
    }
  }, [folders, selectedFolder]);

  // Full catalog path passed to the Tiled browser as its starting location. When no folder is
  // selected yet (e.g. the folder list hasn't loaded, or failed because the user isn't logged in
  // on an auth-required server), fall back to the base path so the widget still renders — the user
  // needs it visible to open the browser and log in, which is what lets the dropdown load.
  // Join parent + folder, dropping empty segments so a root parent ('') doesn't yield a leading '/'.
  const selectedPath = selectedFolder
    ? [TILED_PROCESSED_PATH, selectedFolder].filter(Boolean).join('/')
    : '';
  const tiledInitialPath = selectedPath || TILED_PROCESSED_PATH;

  const handleTiledWidgetSelect = (tiledSelectedItemData: TiledItemLinks) => {
    const file_url = createZarrFileUrlFromTiledItem(tiledSelectedItemData);
    if (!file_url) {
      console.error("Valid file url not found");
      return;
    }
    console.log("User selected file:", file_url);
    if (onSelect) {
      onSelect(file_url);
    }
  };

  return (
    <header style={{flexShrink: 0}}>
      <div className="storybook-header">
        <div>
          <img src={logoUrl} className="header-logo" alt="Logo" />
          <h1>{title}</h1>
        </div>
        <div className="header-tiled-controls">
          <label className="header-folder-picker">
            Folder:{' '}
            <select
              value={selectedFolder}
              onChange={(event) => setSelectedFolder(event.target.value)}
              disabled={status !== 'ready' || folders.length === 0}
            >
              {status === 'loading' && <option value="">Loading folders…</option>}
              {status === 'error' && <option value="">Failed to load folders</option>}
              {status === 'ready' && folders.length === 0 && (
                <option value="">No folders found</option>
              )}
              {status === 'ready' &&
                folders.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
            </select>
          </label>
          <Tiled
            key={tiledInitialPath}
            oidcRedirectUrl="http://tiled-test:5174/tomo_viewer/"
            isButtonMode={true}
            onSelectCallback={handleTiledWidgetSelect}
            tiledBaseUrl={getTiledBaseUrl()}
            singleColumnMode={true}
            includeAuthTokensInSelectCallback={true}
            initialPath={tiledInitialPath}
          />
          {onShare && (
            <button
              type="button"
              className="header-share-button"
              onClick={handleShareClick}
              disabled={!canShare}
              title="Copy a link that reopens this scan at the current view"
            >
              {copied ? 'Copied!' : 'Share'}
            </button>
          )}
          {onToggleRenderer && (
            <button
              type="button"
              className="header-renderer-toggle"
              onClick={onToggleRenderer}
              disabled={!webGpuAvailability().ok}
              title={
                webGpuAvailability().ok
                  ? 'Switch the volume renderer between ITK (itk-vtk) and WebGPU'
                  : webGpuAvailability().reason
              }
            >
              Renderer: {renderer === 'webgpu' ? 'WebGPU' : 'ITK'} ⇄
            </button>
          )}
        </div>
      </div>
    </header>
  );
};
