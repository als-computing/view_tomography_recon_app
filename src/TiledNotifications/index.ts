/**
 * Public API for the Tiled notifications component.
 *
 * The seam for a future library build: consumers import only from here.
 * `TiledNotifications` is the drop-in component; the rest are exposed for advanced composition.
 */

export { TiledNotifications } from './TiledNotifications';
export type { TiledNotificationsProps } from './TiledNotifications';

export { ToastProvider, useToasts } from './ToastProvider';
export type { ToastProviderProps, ToastContextValue, ToastPosition } from './ToastProvider';
export { Toast } from './Toast';
export type { ToastProps } from './Toast';

export { useTiledNodeStream } from './useTiledNodeStream';
export type { UseTiledNodeStreamOptions, UseTiledNodeStreamResult } from './useTiledNodeStream';

export { buildTiledStreamUrl, buildZarrUrlForChild } from './buildTiledStreamUrl';
export { ensureNotificationPermission, showOsNotification } from './osNotifications';
export type { OsNotificationOptions } from './osNotifications';

export type {
  TiledStreamConfig,
  TiledStreamStatus,
  TiledStreamMessage,
  TiledStructureFamily,
  TiledContainerChildCreatedEvent,
  TiledContainerSchemaEvent,
} from './types';
