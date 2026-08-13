/**
 * shareLink.ts
 *
 * Self-contained shareable links: encode "which reconstruction + how it's being viewed" into a URL a
 * user can send to a colleague, who then sees the same scan at the same camera angle, color scheme,
 * and cropping. State is carried entirely in the link (a base64url-encoded JSON snapshot in the
 * `?share=` query param) — there is no backend or short-link store.
 *
 * A reconstruction is identified by its Tiled "file id" (the path segment after `/zarr/v2/`), NOT a
 * full URL, so a link stays valid across dev/staging/prod of the same Tiled catalog: the recipient's
 * own `getTiledBaseUrl()` rebuilds the absolute zarr URL. The link carries VIEW state only, not data —
 * the recipient must be authenticated to Tiled with access to that scan for the volume to load.
 */

import { getTiledBaseUrl } from './utils';
import type { CapturedViewState } from './viewerState';

/** A shareable snapshot: the reconstruction's file id `f` plus the captured view state. */
export interface ShareState extends CapturedViewState {
  /** Tiled file id — the path segment after `/zarr/v2/` (equivalently after `/api/v1/`). */
  f: string;
}

/** Extract the Tiled file id from a full zarr URL (`…/zarr/v2/<fileId>`), or null if absent. */
export const fileIdFromZarrUrl = (url: string): string | null => url.split('/zarr/v2/')[1] || null;

/** Rebuild a full zarr URL for a file id using this deployment's Tiled base URL. */
export const zarrUrlFromFileId = (fileId: string): string =>
  `${getTiledBaseUrl().replace('/api/v1', '/zarr/v2')}/${fileId}`;

const encodeState = (state: ShareState): string => {
  const bytes = new TextEncoder().encode(JSON.stringify(state));
  let binary = '';
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  // URL-safe base64 (RFC 4648 §5), padding stripped.
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const decodeState = (param: string | null): ShareState | null => {
  if (!param) return null;
  try {
    const b64 = param.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    // A valid share state must at least identify a reconstruction.
    if (parsed && typeof parsed === 'object' && typeof parsed.f === 'string') {
      return parsed as ShareState;
    }
    return null;
  } catch {
    return null;
  }
};

/** Build the absolute shareable URL for a snapshot, honoring the app's base path (`/tomo_viewer/`). */
export const buildShareUrl = (state: ShareState): string =>
  `${window.location.origin}${import.meta.env.BASE_URL}?share=${encodeState(state)}`;

/** Read + decode a share snapshot from the current address bar, or null if there isn't a valid one. */
export const readShareFromLocation = (): ShareState | null =>
  decodeState(new URLSearchParams(window.location.search).get('share'));

/**
 * Copy text to the clipboard, working in insecure (http) contexts too. The async Clipboard API only
 * exists in secure contexts (https / localhost) — and this app is served over plain http — so when
 * it's missing or blocked we fall back to a temporary <textarea> + document.execCommand('copy').
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through to the legacy path below */
    }
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    // Keep it out of view and from scrolling the page while it's briefly focused/selected.
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '0';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}
