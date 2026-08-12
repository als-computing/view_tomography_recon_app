import { useEffect } from 'react';
import './toast.css';

export interface ToastProps {
  /** Toast body text, e.g. "New reconstruction ready: sample_042". */
  message: string;
  /** Label for the primary action button. Omit to hide the action. */
  actionLabel?: string;
  /** Called when the action button is clicked. */
  onAction?: () => void;
  /** Called when the toast is dismissed (X button or auto-dismiss timer). */
  onDismiss: () => void;
  /** Auto-dismiss delay in ms; omit or 0 to keep the toast sticky (the default). */
  autoDismissMs?: number;
}

/**
 * A single toast card: a message, an optional primary action button, and a dismiss control.
 * Presentational only — it has no Tiled knowledge. Follows the repo's Button/CSS conventions.
 */
export const Toast = ({ message, actionLabel, onAction, onDismiss, autoDismissMs = 0 }: ToastProps) => {
  useEffect(() => {
    if (!autoDismissMs || autoDismissMs <= 0) return;
    const timer = setTimeout(onDismiss, autoDismissMs);
    return () => clearTimeout(timer);
    // onDismiss is provided by the (stable) provider; re-running on identity change is harmless.
  }, [autoDismissMs, onDismiss]);

  return (
    <div className="tiled-toast" role="status" aria-live="polite">
      <span className="tiled-toast__message">{message}</span>
      <div className="tiled-toast__actions">
        {actionLabel && onAction && (
          <button type="button" className="tiled-toast__view" onClick={onAction}>
            {actionLabel}
          </button>
        )}
        <button
          type="button"
          className="tiled-toast__dismiss"
          aria-label="Dismiss notification"
          onClick={onDismiss}
        >
          ×
        </button>
      </div>
    </div>
  );
};
