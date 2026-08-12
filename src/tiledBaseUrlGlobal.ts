/**
 * tiledBaseUrlGlobal.ts
 *
 * Publishes the configured Tiled base URL as `window.__TILED_BASE_URL__` before the
 * `@blueskyproject/tiled` widget module evaluates.
 *
 * The widget (v0.0.30) otherwise hardcodes its auth/refresh base URL to
 * `<window.location.hostname>:8000` and posts to the wrong refresh route — see
 * `patches/@blueskyproject+tiled+0.0.30.patch`, which makes `Jv()` read this global and use the
 * correct `/auth/session/refresh` endpoint. Without a valid base URL here the widget's login/token
 * refresh fails against any server not sitting at `<host>:8000`.
 *
 * IMPORTANT: this must be imported before `<App>` (and therefore before the widget) so the global
 * is set at the time the widget's module-level `gr = Jv()` runs.
 */
import { getTiledBaseUrl } from './utils';

declare global {
  interface Window {
    __TILED_BASE_URL__?: string;
  }
}

if (typeof window !== 'undefined') {
  window.__TILED_BASE_URL__ = getTiledBaseUrl();
}
