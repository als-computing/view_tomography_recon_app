/**
 * tiledServers.ts
 *
 * Single source of truth for the selectable Tiled servers (Local vs Remote). All server-specific
 * addresses live here — nothing is hard-coded in components or read from build-time `VITE_*` env
 * (which is inlined at build and can't be switched at runtime). The active choice is persisted in
 * `localStorage` so non-React helpers (utils.ts) can read it synchronously; the header dropdown writes
 * it and re-renders the app (remounting the Tiled widget and re-installing the auth interceptor).
 */

export type TiledServerId = 'local' | 'staging';

export interface TiledServer {
  id: TiledServerId;
  /** Human label in the header dropdown. */
  label: string;
  /** REST base, ending in `/api/v1`. Drives getTiledBaseUrl + zarr URL derivation. */
  apiUrl: string;
  /** Parent catalog path whose subfolders populate the folder dropdown (`''` = catalog root). */
  processedPath: string;
  /** Scan auto-opened when this server becomes active (`''` = open nothing, browse to pick). */
  defaultFileId: string;
  /** OIDC redirect back to this app after login. Usually the app's own URL (same for both servers). */
  oidcRedirectUrl: string;
  /**
   * Whether this server exposes the live-notification WebSocket stream (`/api/v1/stream/...`). Local
   * static/0.2.11 Tiled doesn't, so we skip opening the socket (avoids console connection errors).
   */
  supportsStream: boolean;
}

export const TILED_SERVERS: readonly TiledServer[] = [
  {
    id: 'local',
    label: 'Local',
    apiUrl: 'http://localhost:8001/api/v1',
    processedPath: '',
    defaultFileId: 'scans/petiole22',
    oidcRedirectUrl: 'http://tiled-test:5174/tomo_viewer/',
    supportsStream: false,
  },
  {
    id: 'staging',
    label: 'Remote',
    apiUrl: 'https://tiled-staging.computing.als.lbl.gov/api/v1',
    processedPath: 'beamlines/bl832/processed',
    defaultFileId: '',
    oidcRedirectUrl: 'http://tiled-test:5174/tomo_viewer/',
    supportsStream: true,
  },
];

export const DEFAULT_SERVER_ID: TiledServerId = 'local';

const STORAGE_KEY = 'tiledServerId';

/** The persisted active server id (falls back to the default if unset/invalid). */
export const getActiveServerId = (): TiledServerId => {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'local' || v === 'staging') return v;
  } catch {
    /* localStorage unavailable — use default */
  }
  return DEFAULT_SERVER_ID;
};

/** The active {@link TiledServer} config. */
export const getActiveServer = (): TiledServer =>
  TILED_SERVERS.find((s) => s.id === getActiveServerId()) ?? TILED_SERVERS[0]!;

/** Persist the active server id. Callers should then re-render (remount widget, re-install interceptor). */
export const setActiveServerId = (id: TiledServerId): void => {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
};
