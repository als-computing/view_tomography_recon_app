/**
 * buildTiledStreamUrl.ts
 *
 * Pure URL helpers for the Tiled node-stream WebSocket. No React, no side effects —
 * unit-testable in isolation.
 */

/**
 * Builds the WebSocket URL for Tiled's single-node stream endpoint.
 *
 * Converts the REST base URL's scheme to WebSocket (`http`→`ws`, `https`→`wss`), keeps the host
 * and `/api/v1`, and appends `/stream/single/{containerPath}`. Slashes in `containerPath` are
 * path separators and are intentionally NOT percent-encoded (same convention as
 * `fetchTiledContainerChildren`).
 *
 * @param baseUrl - Tiled REST base incl. `/api/v1`, e.g. `https://host/api/v1`.
 * @param containerPath - Catalog path of the container to watch, e.g. `beamlines/bl832/processed/dabramov`.
 * @param opts.start - Optional sequence number to replay buffered history from (used on reconnect).
 * @param opts.envelopeFormat - Wire format; only `'json'` is supported here. Default `'json'`.
 * @returns The `ws(s)://…/api/v1/stream/single/{path}?envelope_format=json[&start=N]` URL.
 *
 * @example
 * buildTiledStreamUrl('https://tiled.example/api/v1', 'beamlines/bl832/processed/dabramov')
 * // → 'wss://tiled.example/api/v1/stream/single/beamlines/bl832/processed/dabramov?envelope_format=json'
 */
export const buildTiledStreamUrl = (
  baseUrl: string,
  containerPath: string,
  opts: { start?: number; envelopeFormat?: 'json' } = {},
): string => {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

  const base = url.href.replace(/\/+$/, ''); // trim trailing slash(es)
  const cleanedPath = containerPath.replace(/^\/+|\/+$/g, ''); // slashes are separators, don't encode

  const params = new URLSearchParams({ envelope_format: opts.envelopeFormat ?? 'json' });
  if (typeof opts.start === 'number') {
    params.set('start', String(opts.start));
  }

  return `${base}/stream/single/${cleanedPath}?${params.toString()}`;
};

/**
 * Builds the Zarr URL the viewer loads for a newly-created child node.
 *
 * Mirrors `createZarrFileUrlFromTiledItem`'s transform (`/api/v1`→`/zarr/v2`) but works from a
 * container path + child key, because the stream event carries no `links`/`default` URL.
 *
 * @param baseUrl - Tiled REST base incl. `/api/v1`.
 * @param containerPath - The watched container's catalog path.
 * @param key - The new child's key/name from the `container-child-created` event.
 * @returns The `{base}/zarr/v2/{containerPath}/{key}` URL.
 */
export const buildZarrUrlForChild = (
  baseUrl: string,
  containerPath: string,
  key: string,
): string => {
  const zarrBase = baseUrl.replace(/\/+$/, '').replace('/api/v1', '/zarr/v2');
  const cleanedPath = containerPath.replace(/^\/+|\/+$/g, '');
  return `${zarrBase}/${cleanedPath}/${key}`;
};
