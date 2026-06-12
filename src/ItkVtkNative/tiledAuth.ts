/**
 * tiledAuth.ts
 *
 * Same-window auth for the inline (non-iframe) ITK viewer. Because the viewer bundle now runs in
 * the main window, we patch `fetch`/XMLHttpRequest directly and read the Tiled tokens straight
 * from localStorage — no iframe, no postMessage bridge.
 *
 * Requests bound for the Tiled data origin get an `Authorization: Bearer <token>` header. The
 * access token is refreshed when expired via `POST {tiledBaseUrl}/auth/refresh` (the same call the
 * tiled library makes internally on a 401).
 */

import { getTiledBaseUrl, isTokenExpired } from '../utils';

// localStorage keys used by @blueskyproject/tiled.
const ACCESS_TOKEN_KEY = 'tiledAccessToken';
const REFRESH_TOKEN_KEY = 'tiledRefreshToken';

// Captured at module load (before the interceptor patches window.fetch) so the refresh request
// itself is never intercepted — otherwise it would recurse into getValidAccessToken and hang.
const nativeFetch = window.fetch.bind(window);

// Reused across the burst of zarr chunk requests so we don't fire concurrent refreshes.
let inFlightRefresh: Promise<string | null> | null = null;

const refreshAccessToken = async (): Promise<string | null> => {
  const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
  if (!refreshToken) {
    return null;
  }
  try {
    const response = await nativeFetch(`${getTiledBaseUrl()}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!response.ok) {
      console.warn('tiledAuth: token refresh failed with status', response.status);
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
    console.warn('tiledAuth: token refresh request errored:', error);
    return null;
  }
};

/** Returns a valid (non-expired) access token, refreshing it first if necessary. */
const getValidAccessToken = async (): Promise<string | null> => {
  const accessToken = localStorage.getItem(ACCESS_TOKEN_KEY);
  if (!isTokenExpired(accessToken)) {
    return accessToken;
  }
  // Collapse concurrent refreshes (many chunk requests) into one network call.
  if (!inFlightRefresh) {
    inFlightRefresh = refreshAccessToken().finally(() => {
      inFlightRefresh = null;
    });
  }
  return inFlightRefresh;
};

/**
 * Patches `fetch` and `XMLHttpRequest` so requests to the data's origin carry a Tiled Bearer token.
 *
 * @param dataUrl - The zarr data URL; its origin is the only origin that receives the token, so
 *                  the token is never leaked to the CDN or wasm asset hosts.
 * @returns A cleanup function that restores the original `fetch`/`XMLHttpRequest` methods.
 */
export const installTiledFetchInterceptor = (dataUrl: string): (() => void) => {
  let tiledOrigin = '';
  try {
    tiledOrigin = new URL(dataUrl).origin;
  } catch {
    tiledOrigin = '';
  }

  const needsAuth = (url?: string | null): boolean => {
    if (!url) return false;
    try {
      const resolved = new URL(url, window.location.href);
      return tiledOrigin ? resolved.origin === tiledOrigin : resolved.href.includes('zarr');
    } catch {
      return false;
    }
  };

  // --- fetch ---
  const originalFetch = window.fetch;
  window.fetch = function (input: RequestInfo | URL, init: RequestInit = {}) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!needsAuth(url)) {
      return originalFetch(input, init);
    }
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined) || {});
    // If the caller already set an Authorization header, leave the request alone.
    if (headers.has('Authorization')) {
      return originalFetch(input, init);
    }
    return getValidAccessToken().then((token) => {
      if (token) {
        headers.set('Authorization', `Bearer ${token}`);
      }
      return originalFetch(input, { ...init, headers });
    });
  };

  // --- XMLHttpRequest ---
  type TiledXHR = XMLHttpRequest & { _tiledUrl?: string; _tiledHasAuth?: boolean };
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (this: TiledXHR, method: string, url: string, ...args: any[]) {
    this._tiledUrl = url;
    this._tiledHasAuth = false;
    // @ts-expect-error - forwarding the original variadic signature
    return originalOpen.call(this, method, url, ...args);
  };

  // Track whether the caller set its own Authorization header (setRequestHeader appends, so
  // adding ours on top would corrupt an already-valid token).
  XMLHttpRequest.prototype.setRequestHeader = function (this: TiledXHR, name: string, value: string) {
    if (typeof name === 'string' && name.toLowerCase() === 'authorization') {
      this._tiledHasAuth = true;
    }
    return originalSetRequestHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function (this: TiledXHR, body?: Document | XMLHttpRequestBodyInit | null) {
    if (!needsAuth(this._tiledUrl) || this._tiledHasAuth) {
      return originalSend.call(this, body ?? null);
    }
    getValidAccessToken()
      .then((token) => {
        if (token) {
          this.setRequestHeader('Authorization', `Bearer ${token}`);
        }
        originalSend.call(this, body ?? null);
      })
      .catch(() => originalSend.call(this, body ?? null));
  };

  return () => {
    window.fetch = originalFetch;
    XMLHttpRequest.prototype.open = originalOpen;
    XMLHttpRequest.prototype.send = originalSend;
    XMLHttpRequest.prototype.setRequestHeader = originalSetRequestHeader;
  };
};
