/**
 * TiledNotifications.tsx
 *
 * The single component an app mounts. It:
 *   1. resolves the container paths to watch (default: the ESAF folders the signed-in user can
 *      see under `parentPath` — admins see all of them),
 *   2. opens one push WebSocket per watched container (via `useTiledNodeStream`),
 *   3. on a `container-child-created` event raises an in-app Toast + an OS notification with a
 *      "View" button that loads the new reconstruction into the viewer.
 *
 * It self-contains its own `ToastProvider`, so a one-line mount is all that's needed. Everything
 * is portable: transport defaults (base URL / token) come from `TiledStreamConfig` and can be
 * overridden per project.
 */

import { useEffect, useRef, useState } from 'react';
import { fetchTiledContainerChildren, getTiledBaseUrl, TILED_PROCESSED_PATH } from '../utils';
import { buildZarrUrlForChild } from './buildTiledStreamUrl';
import { ensureNotificationPermission, showOsNotification } from './osNotifications';
import { ToastProvider, useToasts } from './ToastProvider';
import type { ToastPosition } from './ToastProvider';
import { useTiledNodeStream } from './useTiledNodeStream';
import type {
  TiledContainerChildCreatedEvent,
  TiledStreamConfig,
  TiledStructureFamily,
} from './types';

export interface TiledNotificationsProps {
  /** Parent catalog path whose (accessible) child containers are watched. Default TILED_PROCESSED_PATH. */
  parentPath?: string;
  /** Called with a zarr URL when the user clicks "View" on a notification (e.g. `setFileUrl`). */
  onView: (zarrUrl: string) => void;
  /**
   * Override how the watched container paths are resolved. Default: the accessible child folders
   * of `parentPath` (the signed-in user's ESAFs), returned as full paths.
   */
  resolveWatchPaths?: () => Promise<string[]>;
  /** How often (ms) to re-resolve the watched paths (picks up login / newly-granted ESAFs). Default 60000. */
  resolveIntervalMs?: number;
  /** Only raise notifications for these structure families. Default ['container', 'array']. */
  notifyStructureFamilies?: TiledStructureFamily[];
  /** Also fire a browser/OS notification (requests permission). Default true. */
  enableOsNotifications?: boolean;
  /** Build the toast/notification message from an event. Default: "New reconstruction ready: <key>". */
  formatMessage?: (event: TiledContainerChildCreatedEvent, watchPath: string) => string;
  /** Corner for the toast stack. Default 'bottom-right'. */
  position?: ToastPosition;
  /** Transport config (injectable base URL / token getter / backoff). */
  streamConfig?: TiledStreamConfig;
  /** Master enable switch. Default true. */
  enabled?: boolean;
}

/** Hosts exactly one WebSocket for `watchPath`; renders nothing. */
const NodeStream = ({
  watchPath,
  onChildCreated,
  streamConfig,
}: {
  watchPath: string;
  onChildCreated: (event: TiledContainerChildCreatedEvent) => void;
  streamConfig?: TiledStreamConfig;
}) => {
  useTiledNodeStream({ watchPath, onChildCreated, ...streamConfig });
  return null;
};

const TiledNotificationsInner = ({
  parentPath = TILED_PROCESSED_PATH,
  onView,
  resolveWatchPaths,
  resolveIntervalMs = 60000,
  notifyStructureFamilies = ['container', 'array'],
  enableOsNotifications = true,
  formatMessage = (event) => `New reconstruction ready: ${event.key}`,
  streamConfig,
  enabled = true,
}: TiledNotificationsProps) => {
  const { pushToast, dismissToast } = useToasts();
  const [watchPaths, setWatchPaths] = useState<string[]>([]);

  // Latest-value refs so the stream callback stays stable but reads current props.
  const onViewRef = useRef(onView);
  const formatMessageRef = useRef(formatMessage);
  onViewRef.current = onView;
  formatMessageRef.current = formatMessage;

  const getBaseUrl = streamConfig?.getBaseUrl ?? getTiledBaseUrl;

  // Dedup guard: `container-child-created` may be re-delivered on reconnect via `start=` replay.
  const seenRef = useRef<Set<string>>(new Set());

  // Ask for OS-notification permission once.
  useEffect(() => {
    if (enableOsNotifications) {
      void ensureNotificationPermission();
    }
  }, [enableOsNotifications]);

  // Resolve (and periodically re-resolve) the watched container paths.
  useEffect(() => {
    if (!enabled) {
      setWatchPaths([]);
      return;
    }
    let cancelled = false;

    const resolve = async () => {
      try {
        const paths = resolveWatchPaths
          ? await resolveWatchPaths()
          : (await fetchTiledContainerChildren(parentPath)).map((name) =>
              [parentPath, name].filter(Boolean).join('/'),
            );
        if (cancelled) return;
        // Only update state when the set actually changes, to avoid remounting streams needlessly.
        setWatchPaths((prev) => {
          const a = [...prev].sort();
          const b = [...paths].sort();
          const same = a.length === b.length && a.every((v, i) => v === b[i]);
          return same ? prev : b;
        });
      } catch (error) {
        // Not-yet-logged-in (401) etc. — keep trying on the interval; existing streams stay up.
        if (!cancelled) {
          console.debug('TiledNotifications: could not resolve watch paths yet:', error);
        }
      }
    };

    void resolve();
    const interval = setInterval(resolve, resolveIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [enabled, parentPath, resolveWatchPaths, resolveIntervalMs]);

  const handleChildCreated = (watchPath: string, event: TiledContainerChildCreatedEvent) => {
    if (!notifyStructureFamilies.includes(event.structure_family)) return;

    const dedupKey = `${watchPath}#${event.sequence}`;
    if (seenRef.current.has(dedupKey)) return;
    seenRef.current.add(dedupKey);

    const message = formatMessageRef.current(event, watchPath);
    const view = () => onViewRef.current(buildZarrUrlForChild(getBaseUrl(), watchPath, event.key));

    const id = pushToast({
      message,
      actionLabel: 'View',
      onAction: () => {
        view();
        dismissToast(id);
      },
    });

    if (enableOsNotifications) {
      showOsNotification({ title: 'New reconstruction ready', body: event.key, tag: dedupKey, onClick: view });
    }
  };

  return (
    <>
      {watchPaths.map((watchPath) => (
        <NodeStream
          key={watchPath}
          watchPath={watchPath}
          streamConfig={streamConfig}
          onChildCreated={(event) => handleChildCreated(watchPath, event)}
        />
      ))}
    </>
  );
};

/**
 * Drop-in notifications for new Tiled reconstructions. Includes its own ToastProvider.
 *
 * @example
 * <TiledNotifications parentPath={TILED_PROCESSED_PATH} onView={setFileUrl} />
 */
export const TiledNotifications = ({ position = 'bottom-right', ...props }: TiledNotificationsProps) => (
  <ToastProvider position={position}>
    <TiledNotificationsInner {...props} />
  </ToastProvider>
);
