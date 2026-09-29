'use client';

import { Button } from '@storm-bet/ui';
import { useEffect } from 'react';

/**
 * Last-resort boundary. It never shows the error itself — only a digest the
 * operator can find in the server logs.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error.digest ?? 'client error');
  }, [error]);
  return (
    <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-lg font-semibold">Etwas ist schiefgelaufen</h1>
      <p className="max-w-md text-sm text-fg-muted">
        Die Seite konnte nicht geladen werden. Bitte versuche es erneut. Falls das Problem bleibt,
        kontaktiere den Support
        {error.digest ? ` und nenne den Code ${error.digest}` : ''}.
      </p>
      <Button onClick={reset}>Erneut versuchen</Button>
    </div>
  );
}
