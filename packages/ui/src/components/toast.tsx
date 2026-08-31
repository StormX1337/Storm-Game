'use client';

import * as React from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2, X, XCircle } from 'lucide-react';
import { cn } from '../lib/cn';

export type ToastLevel = 'success' | 'error' | 'warning' | 'info' | 'loading';

export interface Toast {
  id: string;
  title: string;
  description?: string;
  level: ToastLevel;
  /** Milliseconds before auto-dismiss; 0 keeps it until dismissed. */
  duration: number;
  action?: { label: string; onClick: () => void };
}

interface ToastContextValue {
  toasts: Toast[];
  push: (
    toast: Omit<Toast, 'id' | 'level' | 'duration'> & Partial<Pick<Toast, 'level' | 'duration'>>,
  ) => string;
  dismiss: (id: string) => void;
  success: (title: string, description?: string) => string;
  error: (title: string, description?: string) => string;
  warning: (title: string, description?: string) => string;
  info: (title: string, description?: string) => string;
  /** Shows a loading toast and swaps it for the outcome when the promise settles. */
  promise: <T>(
    promise: Promise<T>,
    messages: {
      loading: string;
      success: string | ((value: T) => string);
      error: string | ((error: unknown) => string);
    },
  ) => Promise<T>;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const context = React.useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>');
  return context;
}

const DEFAULT_DURATION = 5000;

export function ToastProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const timers = React.useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = React.useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = React.useCallback<ToastContextValue['push']>(
    (input) => {
      const id = Math.random().toString(36).slice(2, 10);
      const toast: Toast = {
        id,
        title: input.title,
        level: input.level ?? 'info',
        duration: input.duration ?? DEFAULT_DURATION,
        ...(input.description ? { description: input.description } : {}),
        ...(input.action ? { action: input.action } : {}),
      };

      // Cap the stack so a burst of websocket events cannot bury the screen.
      setToasts((current) => [...current.slice(-4), toast]);

      if (toast.duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), toast.duration),
        );
      }
      return id;
    },
    [dismiss],
  );

  const update = React.useCallback((id: string, patch: Partial<Toast>) => {
    setToasts((current) =>
      current.map((toast) => (toast.id === id ? { ...toast, ...patch } : toast)),
    );
  }, []);

  React.useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const value = React.useMemo<ToastContextValue>(
    () => ({
      toasts,
      push,
      dismiss,
      success: (title, description) => push({ title, description, level: 'success' }),
      error: (title, description) => push({ title, description, level: 'error', duration: 8000 }),
      warning: (title, description) => push({ title, description, level: 'warning' }),
      info: (title, description) => push({ title, description, level: 'info' }),
      async promise(promise, messages) {
        const id = push({ title: messages.loading, level: 'loading', duration: 0 });
        try {
          const result = await promise;
          const title =
            typeof messages.success === 'function' ? messages.success(result) : messages.success;
          update(id, { title, level: 'success', duration: DEFAULT_DURATION });
          timers.current.set(
            id,
            setTimeout(() => dismiss(id), DEFAULT_DURATION),
          );
          return result;
        } catch (error) {
          const title =
            typeof messages.error === 'function' ? messages.error(error) : messages.error;
          update(id, { title, level: 'error', duration: 8000 });
          timers.current.set(
            id,
            setTimeout(() => dismiss(id), 8000),
          );
          throw error;
        }
      },
    }),
    [toasts, push, dismiss, update],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

const LEVEL_ICON: Record<ToastLevel, React.ComponentType<{ className?: string }>> = {
  success: CheckCircle2,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
  loading: Loader2,
};

const LEVEL_COLOUR: Record<ToastLevel, string> = {
  success: 'text-success',
  error: 'text-destructive',
  warning: 'text-warning',
  info: 'text-primary',
  loading: 'text-muted-foreground',
};

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}) {
  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-full max-w-sm flex-col gap-2"
      role="region"
      aria-live="polite"
    >
      {toasts.map((toast) => {
        const Icon = LEVEL_ICON[toast.level];
        return (
          <div
            key={toast.id}
            className="pointer-events-auto flex items-start gap-3 rounded-xl border border-border bg-popover/95 p-3.5 shadow-2xl backdrop-blur"
            style={{ animation: 'storm-fade-in 180ms ease-out' }}
          >
            <Icon
              className={cn(
                'mt-0.5 h-4 w-4 shrink-0',
                LEVEL_COLOUR[toast.level],
                toast.level === 'loading' && 'animate-spin',
              )}
            />
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="text-sm font-medium leading-snug">{toast.title}</p>
              {toast.description ? (
                <p className="break-words text-xs text-muted-foreground">{toast.description}</p>
              ) : null}
              {toast.action ? (
                <button
                  type="button"
                  onClick={() => {
                    toast.action?.onClick();
                    onDismiss(toast.id);
                  }}
                  className="mt-1 text-xs font-semibold text-primary hover:underline"
                >
                  {toast.action.label}
                </button>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
              aria-label="Dismiss notification"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
