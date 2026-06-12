import { useState } from 'react';
import './header.css';
import { Tiled, TiledItemLinks } from '@blueskyproject/tiled';
import '@blueskyproject/tiled/style.css';
import { createZarrFileUrlFromTiledItem, getTiledBaseUrl } from './utils';

export interface HeaderProps {
  logoUrl: string;
  title: string;
  fileName: string;
  /**
   * Callback that receives the selected file URL.
   */
  onSelect?: (file_url: string) => void;
}

export const Header = ({ logoUrl, title, fileName, onSelect }: HeaderProps) => {
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
        <div>
                    <Tiled isButtonMode={true} onSelectCallback={handleTiledWidgetSelect} tiledBaseUrl={getTiledBaseUrl()} initialPath='beamlines/bl832/processed/example_samples' singleColumnMode={true} includeAuthTokensInSelectCallback={true}/>
          {/* <Tiled isButtonMode={true} onSelectCallback={handleTiledWidgetSelect} tiledBaseUrl={getTiledBaseUrl()} initialPath='beamlines/bl832/processed/BLS-00761_clark' includeAuthTokensInSelectCallback={true} singleColumnMode={true}/> */}
          {/* <Tiled isButtonMode={true} onSelectCallback={handleTiledWidgetSelect} tiledBaseUrl={getTiledBaseUrl()} includeAuthTokensInSelectCallback={true} singleColumnMode={true}/> */}

        </div>
      </div>
    </header>
  );
};
