'use client';

import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@storm/ui';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    // Surface the detail in the browser console for support, but never render
    // a raw stack trace to the customer.
    console.error('Unhandled panel error:', error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-5 px-6 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-destructive/10">
        <AlertTriangle className="h-5 w-5 text-destructive" />
      </div>
      <div className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight">Something went wrong</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          The page could not be displayed. Trying again usually clears it; if it keeps happening,
          the reference below will help support track it down.
        </p>
        {error.digest ? (
          <p className="pt-1 font-mono text-xs text-muted-foreground">Reference: {error.digest}</p>
        ) : null}
      </div>
      <Button onClick={reset}>Try again</Button>
    </div>
  );
}
