/**
 * tiledTokenBridge.ts
 *
 * The ITK viewer runs inside a same-origin iframe (built via document.write) that loads a
 * remote CDN bundle. That bundle fires its own zarr fetch/XHR requests to the Tiled server,
 * which requires authentication, but it has no access to our tokens. The interceptor injected
 * into the iframe (public/tiled-auth-interceptor.js) asks the parent for a token over
 * postMessage; this module is the parent-side responder.
 *
 * It reads the access/refresh tokens that @blueskyproject/tiled stores in localStorage, refreshes
 * the access token when it is expired (or close to it), and replies with a valid token. The
 * refresh call mirrors what the tiled library does internally on a 401:
 * `POST {tiledBaseUrl}/auth/refresh` with `{ refresh_token }`.
 */

import { getTiledBaseUrl, isTokenExpired } from './utils';

// localStorage keys used by @blueskyproject/tiled.
const ACCESS_TOKEN_KEY = 'tiledAccessToken';
const REFRESH_TOKEN_KEY = 'tiledRefreshToken';

const REQUEST_TYPE = 'REQUEST_TILED_TOKEN';
const RESPONSE_TYPE = 'TILED_TOKEN_RESPONSE';

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
        const response = await fetch(`${getTiledBaseUrl()}/auth/refresh`, {
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
    if (!isTokenExpired(accessToken)) {
        return accessToken;
    }
    return refreshAccessToken();
};

/**
 * Installs a message listener that answers token requests from the viewer iframe.
 *
 * Only same-origin messages of type `REQUEST_TILED_TOKEN` are handled; the reply is targeted
 * back at the requesting window and origin.
 *
 * @returns A cleanup function that removes the listener.
 */
export const installTiledTokenBridge = (): (() => void) => {
    const handleMessage = async (event: MessageEvent) => {
        // The iframe is same-origin; ignore anything from another origin.
        if (event.origin !== window.location.origin) {
            return;
        }
        if (!event.data || event.data.type !== REQUEST_TYPE) {
            return;
        }

        const { requestId } = event.data;
        const token = await getValidAccessToken();

        const source = event.source as WindowProxy | null;
        source?.postMessage({ type: RESPONSE_TYPE, requestId, token }, event.origin);
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
};
