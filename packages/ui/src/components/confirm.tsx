'use client';

import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from './button';
import { Input } from './primitives';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './overlays';

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /**
   * When set, the user must type this exact string to enable the confirm
   * button. Reserved for genuinely irreversible actions — deleting a server,
   * wiping a data directory — where a mis-click is unrecoverable.
   */
  confirmText?: string;
}

type Resolver = (confirmed: boolean) => void;

const ConfirmContext = React.createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(
  null,
);

export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  const context = React.useContext(ConfirmContext);
  if (!context) throw new Error('useConfirm must be used inside <ConfirmProvider>');
  return context;
}

export function ConfirmProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [state, setState] = React.useState<{ options: ConfirmOptions; resolve: Resolver } | null>(
    null,
  );
  const [typed, setTyped] = React.useState('');

  const confirm = React.useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setTyped('');
        setState({ options, resolve });
      }),
    [],
  );

  const close = (confirmed: boolean): void => {
    state?.resolve(confirmed);
    setState(null);
    setTyped('');
  };

  const options = state?.options;
  const gateSatisfied = !options?.confirmText || typed.trim() === options.confirmText;

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog open={state !== null} onOpenChange={(open) => !open && close(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <div className="flex items-start gap-3">
              {options?.destructive ? (
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-destructive/15">
                  <AlertTriangle className="h-4 w-4 text-destructive" />
                </div>
              ) : null}
              <div className="space-y-1.5">
                <DialogTitle>{options?.title}</DialogTitle>
                {options?.description ? (
                  <DialogDescription>{options.description}</DialogDescription>
                ) : null}
              </div>
            </div>
          </DialogHeader>

          {options?.confirmText ? (
            <div className="space-y-1.5">
              <p className="text-sm text-muted-foreground">
                Type{' '}
                <span className="font-mono font-semibold text-foreground">
                  {options.confirmText}
                </span>{' '}
                to confirm.
              </p>
              <Input
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                placeholder={options.confirmText}
                autoComplete="off"
                autoFocus
              />
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => close(false)}>
              {options?.cancelLabel ?? 'Cancel'}
            </Button>
            <Button
              variant={options?.destructive ? 'destructive' : 'default'}
              onClick={() => close(true)}
              disabled={!gateSatisfied}
            >
              {options?.confirmLabel ?? 'Confirm'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConfirmContext.Provider>
  );
}
