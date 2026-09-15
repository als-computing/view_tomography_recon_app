/**
 * tiledServers.ts
 *
 * Single source of truth for the selectable Tiled servers (Local vs Remote vs Production). The
 * actual server data (URLs, labels, OIDC redirects) lives in the repo root's `config.yml`, not here —
 * this file only owns the type/validation/lookup logic, so a deployer can edit server addresses
 * without touching TypeScript. `config.yml` is read at build time (via vite-yaml-plugin.js, shared by
 * vite.config.js/vitest.config.ts) and inlined into the bundle, same timing/cost as a hand-written
 * data file — nothing about this is fetched or re-parsed at runtime.
 *
 * The active choice is persisted in `localStorage` so non-React helpers (utils.ts) can read it
 * synchronously; the header dropdown writes it and re-renders the app (remounting the Tiled widget
 * and re-installing the auth interceptor).
 */
import rawConfig from '../config.yml';

export type TiledServerId = 'local' | 'staging' | 'production';

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

interface ConfigYamlServerEntry {
  label: string;
  apiUrl: string;
  processedPath: string;
  defaultFileId: string;
  oidcRedirectUrl: string;
  supportsStream: boolean;
}

interface ConfigYamlShape {
  tiledServers: Record<string, ConfigYamlServerEntry>;
  defaultServerId: string;
}

const ALL_SERVER_IDS: readonly TiledServerId[] = ['local', 'staging', 'production'];

const isTiledServerId = (v: unknown): v is TiledServerId =>
  v === 'local' || v === 'staging' || v === 'production';

/** Fail loudly and specifically at import time rather than surfacing a confusing runtime error later. */
const buildTiledServers = (): readonly TiledServer[] => {
  const config = rawConfig as ConfigYamlShape;
  if (!config || typeof config !== 'object' || typeof config.tiledServers !== 'object') {
    throw new Error('config.yml is missing its top-level "tiledServers" map.');
  }
  return ALL_SERVER_IDS.map((id) => {
    const entry = config.tiledServers[id];
    if (!entry) {
      throw new Error(`config.yml's "tiledServers" is missing a required "${id}" entry.`);
    }
    for (const field of ['label', 'apiUrl', 'processedPath', 'defaultFileId', 'oidcRedirectUrl'] as const) {
      if (typeof entry[field] !== 'string') {
        throw new Error(`config.yml's tiledServers.${id}.${field} must be a string.`);
      }
    }
    if (typeof entry.supportsStream !== 'boolean') {
      throw new Error(`config.yml's tiledServers.${id}.supportsStream must be a boolean.`);
    }
    return { id, ...entry };
  });
};

const buildDefaultServerId = (): TiledServerId => {
  const config = rawConfig as ConfigYamlShape;
  const v = config?.defaultServerId;
  if (!isTiledServerId(v)) {
    throw new Error(
      `config.yml's "defaultServerId" ("${String(v)}") must be one of: ${ALL_SERVER_IDS.join(', ')}.`,
    );
  }
  return v;
};

export const TILED_SERVERS: readonly TiledServer[] = buildTiledServers();

export const DEFAULT_SERVER_ID: TiledServerId = buildDefaultServerId();

const STORAGE_KEY = 'tiledServerId';

/**
 * Build-time-only (Vite auto-inlines VITE_-prefixed vars into import.meta.env at build time - see
 * react/Dockerfile's `build` stage `ARG FIXED_TILED_SERVER`). When set to a valid TiledServerId, the
 * app is locked to that one server: getActiveServerId() always returns it (ignoring localStorage/the
 * default), and setActiveServerId() becomes a no-op. Unset (the :local image's default) preserves
 * today's exact behavior - full switcher, last choice persisted in localStorage.
 */
const rawFixedServer = import.meta.env.VITE_FIXED_TILED_SERVER as string | undefined;
export const FIXED_SERVER_ID: TiledServerId | undefined = isTiledServerId(rawFixedServer)
  ? rawFixedServer
  : undefined;

/** The persisted active server id (falls back to the default if unset/invalid). */
export const getActiveServerId = (): TiledServerId => {
  if (FIXED_SERVER_ID) return FIXED_SERVER_ID;
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (isTiledServerId(v)) return v;
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
  if (FIXED_SERVER_ID) return; // locked build - the dropdown is hidden (see App.jsx), but stay a
  // no-op here too rather than relying solely on the UI being absent.
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
};
