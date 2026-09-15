/**
 * osNotifications.ts
 *
 * Thin, portable wrapper around the browser Notification API so notifications surface even when
 * the app tab is backgrounded. Every function degrades gracefully (no-op) when the API is
 * unsupported or permission is denied — the in-app Toast is always the source of truth.
 */

const isSupported = (): boolean => typeof window !== 'undefined' && 'Notification' in window;

/**
 * Requests OS-notification permission if not already decided. Safe to call repeatedly.
 *
 * @returns `true` if notifications are permitted, `false` otherwise (unsupported/denied/dismissed).
 */
export const ensureNotificationPermission = async (): Promise<boolean> => {
  if (!isSupported()) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    const result = await Notification.requestPermission();
    return result === 'granted';
  } catch {
    return false;
  }
};

export interface OsNotificationOptions {
  title: string;
  body?: string;
  /** Coalesces notifications that share a tag (later ones replace earlier). */
  tag?: string;
  /** Invoked when the user clicks the OS notification (also focuses the window). */
  onClick?: () => void;
}

/**
 * Shows an OS notification if permission has been granted. No-op otherwise.
 *
 * @returns The `Notification` instance, or `null` if it could not be shown.
 */
export const showOsNotification = ({ title, body, tag, onClick }: OsNotificationOptions): Notification | null => {
  if (!isSupported() || Notification.permission !== 'granted') return null;
  try {
    const notification = new Notification(title, { body, tag });
    notification.onclick = () => {
      try {
        window.focus();
      } catch {
        /* ignore */
      }
      onClick?.();
      notification.close();
    };
    return notification;
  } catch {
    return null;
  }
};
