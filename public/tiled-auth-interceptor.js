// Tiled Authentication Interceptor
//
// Injected into the (same-origin) viewer iframe before the itk-vtk-viewer CDN bundle. It
// overrides fetch and XMLHttpRequest so that requests bound for the Tiled server carry an
// `Authorization: Bearer <token>` header. Because a document.write iframe is same-origin with
// the parent, the token is fetched by calling the parent directly via
// `window.parent.getValidTiledToken()` (exposed by src/tiledTokenBridge.ts), which refreshes it
// when needed. No postMessage is used (it can't bridge the iframe's "null" about:blank origin).
//
// The token is cached locally and only re-requested when missing or near expiry, so loading a
// volume (many zarr chunk requests) does not refetch on every chunk.

(function () {
  'use strict';

  // Origin of the Tiled server, injected by ItkVtkViewer.tsx. Only requests to this origin get
  // the Authorization header, so the token is never leaked to the CDN or wasm asset hosts.
  const tiledOrigin = window.__TILED_ORIGIN__ || '';

  let cachedToken = null;

  const needsAuth = (url) => {
    if (!url) return false;
    try {
      const resolved = new URL(url, window.location.href);
      if (tiledOrigin) {
        return resolved.origin === tiledOrigin;
      }
      // Fallback when no origin was injected: match zarr requests by path.
      return resolved.href.includes('zarr');
    } catch (_e) {
      return false;
    }
  };

  // Decode a JWT's `exp` claim and report whether it expires within `skewSeconds`.
  const isTokenExpired = (token, skewSeconds = 30) => {
    if (!token) return true;
    const segments = token.split('.');
    if (segments.length < 2) return true;
    try {
      const base64 = segments[1].replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(atob(base64));
      if (typeof payload.exp !== 'number') return true;
      return Date.now() >= payload.exp * 1000 - skewSeconds * 1000;
    } catch (_e) {
      return true;
    }
  };

  // Ask the parent window for a fresh token. The iframe is same-origin, so we can call the
  // parent's exposed getter directly; fall back to reading its localStorage if it isn't present.
  const requestTokenFromParent = async () => {
    try {
      if (typeof window.parent.getValidTiledToken === 'function') {
        return await window.parent.getValidTiledToken();
      }
      return window.parent.localStorage.getItem('tiledAccessToken');
    } catch (e) {
      console.warn('Tiled interceptor: could not reach parent for token:', e);
      return null;
    }
  };

  // Return a usable token, reusing the cached one until it is missing or near expiry.
  const getToken = async () => {
    if (cachedToken && !isTokenExpired(cachedToken)) {
      return cachedToken;
    }
    cachedToken = await requestTokenFromParent();
    return cachedToken;
  };

  // --- fetch override ---
  const originalFetch = window.fetch;
  window.fetch = function (input, init = {}) {
    const url = typeof input === 'string' ? input : input && input.url;

    if (!needsAuth(url)) {
      return originalFetch(input, init);
    }

    return getToken().then((token) => {
      const headers = new Headers(init.headers || (typeof input !== 'string' && input.headers) || {});
      if (token) {
        headers.set('Authorization', `Bearer ${token}`);
      }
      return originalFetch(input, { ...init, headers });
    });
  };

  // --- XMLHttpRequest override ---
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    this._tiledUrl = url;
    return originalOpen.call(this, method, url, ...args);
  };

  XMLHttpRequest.prototype.send = function (data) {
    if (!needsAuth(this._tiledUrl)) {
      return originalSend.call(this, data);
    }
    getToken()
      .then((token) => {
        if (token) {
          this.setRequestHeader('Authorization', `Bearer ${token}`);
        }
        originalSend.call(this, data);
      })
      .catch(() => originalSend.call(this, data));
  };
})();
