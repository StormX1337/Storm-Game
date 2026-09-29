'use client';

import { Toaster as Sonner, toast } from 'sonner';

export { toast };

export function Toaster() {
  return (
    <Sonner
      theme="dark"
      position="bottom-right"
      closeButton
      toastOptions={{
        classNames: {
          toast:
            '!bg-surface-2 !border !border-border-strong !text-fg !rounded-lg !shadow-[var(--shadow-pop)]',
          description: '!text-fg-muted',
          success: '[&_[data-icon]]:!text-up',
          error: '[&_[data-icon]]:!text-down',
          warning: '[&_[data-icon]]:!text-warning',
        },
      }}
    />
  );
}
