/**
 * tiledTokenBridge.ts
 *
 * The ITK viewer runs inside a same-origin iframe (built via document.write) that loads a
 * remote CDN bundle. That bundle fires its own zarr fetch/XHR requests to the Tiled server,
 * which requires authentication, but it has no access to our tokens. The interceptor injected
 * into the iframe (public/tiled-auth-interceptor.js) needs a valid token to attach.
 *
 * Because a document.write iframe is same-origin with the parent, the interceptor can call the
 * parent directly rather than using postMessage. This module exposes `window.getValidTiledToken`
 * for it: a function that reads the access/refresh tokens @blueskyproject/tiled stores in
 * localStorage, refreshes the access token when it is expired (or close to it), and returns a
 * valid token. The refresh call mirrors what the tiled library does internally on a 401:
 * `POST {tiledBaseUrl}/auth/session/refresh` with `{ refresh_token }`.
 */

import { getTiledBaseUrl, isTokenExpired } from './utils';

// localStorage keys used by @blueskyproject/tiled.
const ACCESS_TOKEN_KEY = 'tiledAccessToken';
const REFRESH_TOKEN_KEY = 'tiledRefreshToken';

/**
 * Refreshes the Tiled access token using the stored refresh token and persists the new token(s)
 * back to localStorage so the rest of the app stays consistent.
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
            console.warn('tiledTokenBridge: token refresh failed with status', response.status);
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
        console.warn('tiledTokenBridge: token refresh request errored:', error);
        return null;
    }
};

/**
 * Returns a valid (non-expired) Tiled access token, refreshing it first if necessary.
 */
const getValidAccessToken = async (): Promise<string | null> => {
    const accessToken = localStorage.getItem(ACCESS_TOKEN_KEY);
    if (accessToken && !isTokenExpired(accessToken)) {
        return accessToken;
    }
    // If the refresh fails (e.g. the server has no /auth/refresh route → 404), fall back to the
    // stored token rather than returning null and forcing an unauthenticated request.
    const refreshed = await refreshAccessToken();
    return refreshed ?? accessToken ?? null;
};

declare global {
    interface Window {
        getValidTiledToken?: () => Promise<string | null>;
    }
}

/**
 * Exposes `window.getValidTiledToken` so the same-origin viewer iframe can fetch a valid
 * (refreshed-if-needed) Tiled access token by calling the parent directly.
 *
 * @returns A cleanup function that removes the exposed getter.
 */
export const installTiledTokenBridge = (): (() => void) => {
    window.getValidTiledToken = getValidAccessToken;
    return () => {
        delete window.getValidTiledToken;
    };
};
