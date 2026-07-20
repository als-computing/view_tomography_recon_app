import { useEffect, useState } from 'react';
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
  fileName: string;
  /**
   * Callback that receives the selected file URL.
   */
  onSelect?: (file_url: string) => void;
}

type FolderStatus = 'loading' | 'ready' | 'error';

export const Header = ({ logoUrl, title, fileName, onSelect }: HeaderProps) => {
  const [folders, setFolders] = useState<string[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<string>('');
  const [status, setStatus] = useState<FolderStatus>('loading');

  // Load the subfolders under the processed path once, to populate the folder dropdown.
  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    fetchTiledContainerChildren(TILED_PROCESSED_PATH, controller.signal)
      .then((names) => {
        setFolders(names);
        // Preserve the app's previous default of opening into 'dabramov' when it exists.
        setSelectedFolder(names.includes('dabramov') ? 'dabramov' : names[0] ?? '');
        setStatus('ready');
      })
      .catch((error) => {
        if (error?.name === 'AbortError') {
          return;
        }
        console.error('Header: failed to load Tiled folders:', error);
        setStatus('error');
      });
    return () => controller.abort();
  }, []);

  // Full catalog path passed to the Tiled browser as its starting location.
  const selectedPath = selectedFolder ? `${TILED_PROCESSED_PATH}/${selectedFolder}` : '';

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
          <div className="header-file-name">{fileName}</div>
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
          {selectedPath && (
            <Tiled
              key={selectedPath}
              oidcRedirectUrl="http://tiled-test:5174/react/"
              isButtonMode={true}
              onSelectCallback={handleTiledWidgetSelect}
              tiledBaseUrl={getTiledBaseUrl()}
              singleColumnMode={true}
              includeAuthTokensInSelectCallback={true}
              initialPath={selectedPath}
            />
          )}
        </div>
      </div>
    </header>
  );
};
