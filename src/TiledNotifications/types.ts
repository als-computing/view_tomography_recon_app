/**
 * types.ts
 *
 * Shared types for the Tiled notifications component. No runtime code.
 *
 * Payload shapes mirror Tiled 0.2.x's node-stream WebSocket
 * (`/api/v1/stream/single/{path}`): on connect the server sends a `container-schema`
 * message, then one `container-child-created` message per new child registered under the
 * watched container.
 */

/** `structure_family` values Tiled reports for a node. */
export type TiledStructureFamily = 'array' | 'container' | 'table' | 'sparse' | 'awkward';

/** First message the server sends after a successful (authenticated) subscribe. */
export interface TiledContainerSchemaEvent {
  type: 'container-schema';
  version: number;
}

/**
 * Emitted when a new child (e.g. a reconstruction) is registered under the watched container.
 * Keyed to the parent container the socket subscribed to — `key` is the new child's name.
 * There is no `links` block; build a URL from `{watchPath}/{key}`.
 */
export interface TiledContainerChildCreatedEvent {
  type: 'container-child-created';
  /** Monotonic per-parent sequence number; use as `start=` to replay on reconnect. */
  sequence: number;
  timestamp: string;
  /** The new child's key/name within the parent container. */
  key: string;
  structure_family: TiledStructureFamily;
  specs?: unknown[];
  metadata?: Record<string, unknown>;
  data_sources?: unknown[];
  access_blob?: Record<string, unknown>;
}

/** Any envelope the stream may deliver (kept open for forward-compat with new event types). */
export type TiledStreamMessage =
  | TiledContainerSchemaEvent
  | TiledContainerChildCreatedEvent
  | { type: string; [key: string]: unknown };

/** Lifecycle state of a single node-stream socket. */
export type TiledStreamStatus =
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'auth-failed'
  | 'closed';

/**
 * Injectable configuration that keeps the transport layer portable across projects.
 * All fields are optional and default to this repo's helpers / sensible values.
 */
export interface TiledStreamConfig {
  /** Returns the Tiled REST base URL including `/api/v1`. Default: `getTiledBaseUrl`. */
  getBaseUrl?: () => string;
  /** Resolves a valid Tiled access token (or null for anonymous). Default: `getValidTiledToken`. */
  getToken?: () => Promise<string | null>;
  /** Initial reconnect backoff in ms (doubles per attempt). Default 1000. */
  baseReconnectDelayMs?: number;
  /** Maximum reconnect backoff in ms. Default 30000. */
  maxReconnectDelayMs?: number;
}
