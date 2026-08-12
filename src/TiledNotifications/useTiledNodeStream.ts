/**
 * useTiledNodeStream.ts
 *
 * React hook that manages ONE Tiled node-stream WebSocket (`/api/v1/stream/single/{path}`):
 * connect → browser first-message auth → receive `container-schema` then `container-child-created`
 * events → reconnect with exponential backoff (replaying missed events via `start=`) → clean up on
 * unmount. Handles access-token expiry mid-session (close 4001/4003 → refresh → reconnect once).
 *
 * The transport is portable: it imports only the injectable defaults (`getTiledBaseUrl`,
 * `getValidTiledToken`), both overridable via `TiledStreamConfig`.
 */

import { useEffect, useRef, useState } from 'react';
import { getTiledBaseUrl } from '../utils';
import { getValidTiledToken } from '../tiledToken';
import { buildTiledStreamUrl } from './buildTiledStreamUrl';
import type {
  TiledContainerChildCreatedEvent,
  TiledStreamConfig,
  TiledStreamMessage,
  TiledStreamStatus,
} from './types';

// WebSocket close codes Tiled uses for auth failures (see server first-message auth).
const AUTH_FAILURE_CODES = new Set([4001, 4003]);

export interface UseTiledNodeStreamOptions extends TiledStreamConfig {
  /** Catalog path of the container to watch; its direct children raise events. */
  watchPath: string;
  /** When false, the socket is not opened (and any open one is closed). Default true. */
  enabled?: boolean;
  /** Called for each `container-child-created` event. */
  onChildCreated: (event: TiledContainerChildCreatedEvent) => void;
  /** Called whenever the connection status changes. */
  onStatusChange?: (status: TiledStreamStatus) => void;
}

export interface UseTiledNodeStreamResult {
  status: TiledStreamStatus;
  /** Highest event sequence seen so far (drives `start=` replay). */
  lastSequence: number | null;
  /** Force an immediate reconnect (e.g. after the user re-authenticates). */
  reconnectNow: () => void;
}

export const useTiledNodeStream = ({
  watchPath,
  enabled = true,
  onChildCreated,
  onStatusChange,
  getBaseUrl = getTiledBaseUrl,
  getToken = getValidTiledToken,
  baseReconnectDelayMs = 1000,
  maxReconnectDelayMs = 30000,
}: UseTiledNodeStreamOptions): UseTiledNodeStreamResult => {
  const [status, setStatusState] = useState<TiledStreamStatus>('closed');
  const [lastSequence, setLastSequence] = useState<number | null>(null);

  // Latest-ref pattern: keep callbacks/config in refs so a changing identity (inline callbacks)
  // does not tear down and re-open the socket. The effect below only depends on [watchPath, enabled].
  const onChildCreatedRef = useRef(onChildCreated);
  const onStatusChangeRef = useRef(onStatusChange);
  const getBaseUrlRef = useRef(getBaseUrl);
  const getTokenRef = useRef(getToken);
  onChildCreatedRef.current = onChildCreated;
  onStatusChangeRef.current = onStatusChange;
  getBaseUrlRef.current = getBaseUrl;
  getTokenRef.current = getToken;

  // Exposed via reconnectNow(); reassigned by the effect on each (watchPath, enabled) change.
  const reconnectNowRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!enabled || !watchPath) {
      return;
    }

    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let closedByUs = false;
    let authRetried = false; // one token-refresh retry per successful open
    const lastSequenceRef = { current: null as number | null };

    const setStatus = (next: TiledStreamStatus) => {
      setStatusState(next);
      onStatusChangeRef.current?.(next);
    };

    const scheduleReconnect = () => {
      if (closedByUs) return;
      const capped = Math.min(baseReconnectDelayMs * 2 ** attempt, maxReconnectDelayMs);
      const delay = capped * (0.5 + Math.random() * 0.5); // jitter
      attempt += 1;
      setStatus('reconnecting');
      reconnectTimer = setTimeout(connect, delay);
    };

    const connect = () => {
      if (closedByUs) return;
      setStatus('connecting');

      const url = buildTiledStreamUrl(getBaseUrlRef.current(), watchPath, {
        start: lastSequenceRef.current != null ? lastSequenceRef.current + 1 : undefined,
      });

      try {
        ws = new WebSocket(url);
      } catch (error) {
        console.warn('useTiledNodeStream: failed to open WebSocket:', error);
        scheduleReconnect();
        return;
      }
      const socket = ws;

      socket.onopen = async () => {
        // Browser first-message auth: the Authorization header isn't available on WebSocket, so
        // credentials are sent as the first message. A null token means anonymous (public server).
        try {
          const token = await getTokenRef.current();
          if (socket.readyState !== WebSocket.OPEN) return; // closed while awaiting the token
          if (token) {
            socket.send(JSON.stringify({ type: 'auth', access_token: token }));
          }
        } catch (error) {
          console.warn('useTiledNodeStream: token fetch for WS auth failed:', error);
        }
      };

      socket.onmessage = (event) => {
        let msg: TiledStreamMessage;
        try {
          msg = JSON.parse(event.data);
        } catch {
          console.warn('useTiledNodeStream: non-JSON stream message:', event.data);
          return;
        }
        switch (msg.type) {
          case 'container-schema':
            // Auth + subscribe succeeded; connection is healthy.
            attempt = 0;
            authRetried = false;
            setStatus('open');
            break;
          case 'container-child-created': {
            const created = msg as TiledContainerChildCreatedEvent;
            lastSequenceRef.current = created.sequence;
            setLastSequence(created.sequence);
            onChildCreatedRef.current(created);
            break;
          }
          default:
            console.debug('useTiledNodeStream: unhandled stream message type:', msg.type);
        }
      };

      socket.onerror = () => {
        // Let the ensuing onclose drive reconnection.
      };

      socket.onclose = async (evt) => {
        ws = null;
        if (closedByUs) return;

        if (AUTH_FAILURE_CODES.has(evt.code)) {
          setStatus('auth-failed');
          // One refresh-and-retry: getToken() refreshes; if it yields a token, reconnect once.
          if (!authRetried) {
            authRetried = true;
            try {
              const token = await getTokenRef.current();
              if (!closedByUs && token) {
                connect();
                return;
              }
            } catch {
              /* fall through to terminal auth-failed */
            }
          }
          return; // terminal until reconnectNow() (e.g. after user re-logs in)
        }

        scheduleReconnect();
      };
    };

    reconnectNowRef.current = () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      attempt = 0;
      authRetried = false;
      if (ws) {
        try {
          ws.close(1000);
        } catch {
          /* ignore */
        }
        ws = null;
      }
      connect();
    };

    connect();

    return () => {
      closedByUs = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        try {
          ws.close(1000);
        } catch {
          /* ignore */
        }
      }
    };
  }, [watchPath, enabled, baseReconnectDelayMs, maxReconnectDelayMs]);

  return {
    status,
    lastSequence,
    reconnectNow: () => reconnectNowRef.current(),
  };
};
