/**
 * tiledToken.ts
 *
 * Shared helper for obtaining a valid (non-expired) Tiled access token. The same
 * read-from-localStorage / refresh-via-`POST {base}/auth/session/refresh` logic also lives in
 * tiledTokenBridge.ts and ItkVtkNative/tiledAuth.ts, but those run inside fetch/XHR
 * interceptors and have their own constraints (a pre-patch `nativeFetch`, a `window`
 * getter). This standalone helper is for ordinary app code — e.g. listing catalog
 * folders — that just needs a bearer token and uses plain `window.fetch`.
 */

import { getTiledBaseUrl, isTokenExpired } from './utils';

// localStorage keys used by @blueskyproject/tiled.
const ACCESS_TOKEN_KEY = 'tiledAccessToken';
const REFRESH_TOKEN_KEY = 'tiledRefreshToken';

// Collapse concurrent refreshes (e.g. multiple callers at once) into one network call.
let inFlightRefresh: Promise<string | null> | null = null;

/**
 * Refreshes the Tiled access token using the stored refresh token and persists the new
 * token(s) back to localStorage so the rest of the app stays consistent.
 *
 * @returns The new access token, or null if no refresh token exists or the refresh fails.
 */
const refreshAccessToken = async (): Promise<string | null> => {
  const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
  if (!refreshToken) {
    return null;
  }
  try {
    const response = await fetch(`${getTiledBaseUrl()}/auth/session/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!response.ok) {
      console.warn('tiledToken: token refresh failed with status', response.status);
      return null;
    }
    const data = await response.json();
    if (data.access_token) {
      localStorage.setItem(ACCESS_TOKEN_KEY, data.access_token);
    }
    if (data.refresh_token) {
      localStorage.setItem(REFRESH_TOKEN_KEY, data.refresh_token);
    }
    return data.access_token ?? null;
  } catch (error) {
    console.warn('tiledToken: token refresh request errored:', error);
    return null;
  }
};

/**
 * Returns a valid (non-expired) Tiled access token, refreshing it first if necessary.
 *
 * @returns A valid access token, or null if none is available and a refresh was not possible.
 */
export const getValidTiledToken = async (): Promise<string | null> => {
  const accessToken = localStorage.getItem(ACCESS_TOKEN_KEY);
  if (!isTokenExpired(accessToken)) {
    return accessToken;
  }
  if (!inFlightRefresh) {
    inFlightRefresh = refreshAccessToken().finally(() => {
      inFlightRefresh = null;
    });
  }
  return inFlightRefresh;
};
