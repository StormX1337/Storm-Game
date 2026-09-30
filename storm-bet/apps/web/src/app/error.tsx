'use client';

import { Button } from '@storm-bet/ui';
import { useEffect } from 'react';
import { useT } from '@/i18n/client';

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
  const t = useT();
  useEffect(() => {
    console.error(error.digest ?? 'client error');
  }, [error]);
  return (
    <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-lg font-semibold">{t('Etwas ist schiefgelaufen')}</h1>
      <p className="max-w-md text-sm text-fg-muted">
        {t(
          'Die Seite konnte nicht geladen werden. Bitte versuche es erneut. Falls das Problem bleibt, kontaktiere den Support',
        )}
        {error.digest ? t(' und nenne den Code {0}', [error.digest]) : ''}.
      </p>
      <Button onClick={reset}>{t('Erneut versuchen')}</Button>
    </div>
  );
}
