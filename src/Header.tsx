import { useEffect, useState } from 'react';
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

export interface HeaderProps {
  logoUrl: string;
  title: string;
  /**
   * Callback that receives the selected file URL.
   */
  onSelect?: (file_url: string) => void;
}

export const Header = ({ logoUrl, title, onSelect }: HeaderProps) => {
  const [selectedFolder, setSelectedFolder] = useState<string>('');

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
        </div>
      </div>
    </header>
  );
};
