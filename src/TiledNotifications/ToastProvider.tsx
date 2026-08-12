import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Toast } from './Toast';
import './toast.css';

export type ToastPosition = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';

interface ToastItem {
  id: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  autoDismissMs?: number;
}

/** Imperative API for pushing/dismissing toasts, exposed via {@link useToasts}. */
export interface ToastContextValue {
  /** Show a toast; returns its id (usable with {@link dismissToast}). */
  pushToast: (toast: Omit<ToastItem, 'id'>) => string;
  /** Dismiss a toast by id. */
  dismissToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/**
 * Hook to access the toast API. Must be called within a {@link ToastProvider}.
 */
export const useToasts = (): ToastContextValue => {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToasts must be used within a <ToastProvider>');
  }
  return ctx;
};

export interface ToastProviderProps {
  children: ReactNode;
  /** Corner to stack toasts in. Default 'bottom-right'. */
  position?: ToastPosition;
  /** Maximum toasts shown at once; oldest are dropped past this. Default 5. */
  maxVisible?: number;
}

/**
 * Provides the toast context and renders the fixed-corner toast stack.
 */
export const ToastProvider = ({ children, position = 'bottom-right', maxVisible = 5 }: ToastProviderProps) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counterRef = useRef(0);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pushToast = useCallback(
    (toast: Omit<ToastItem, 'id'>): string => {
      const id =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `toast-${counterRef.current++}`;
      setToasts((prev) => {
        const next = [...prev, { ...toast, id }];
        // Drop oldest beyond the cap.
        return next.length > maxVisible ? next.slice(next.length - maxVisible) : next;
      });
      return id;
    },
    [maxVisible],
  );

  const value = useMemo<ToastContextValue>(() => ({ pushToast, dismissToast }), [pushToast, dismissToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className={`tiled-toast-container tiled-toast-container--${position}`}>
        {toasts.map((t) => (
          <Toast
            key={t.id}
            message={t.message}
            actionLabel={t.actionLabel}
            onAction={t.onAction}
            autoDismissMs={t.autoDismissMs}
            onDismiss={() => dismissToast(t.id)}
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
};
