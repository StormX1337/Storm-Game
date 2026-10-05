'use client';

import { Button, Card, EmptyState } from '@storm-bet/ui';
import { AlertTriangle, RotateCw } from 'lucide-react';
import Link from 'next/link';
import { useEffect } from 'react';
import { useT } from '@/i18n/client';

/** A failed sportsbook page: header, navigation and bet slip stay; this part retries. */
export default function SiteError({
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
    <Card>
      <EmptyState
        icon={<AlertTriangle className="text-warning" />}
        title={t('Etwas ist schiefgelaufen.')}
        description={
          <>
            {t('Wir konnten die Inhalte nicht laden. Bitte versuche es erneut.')}
            {error.digest ? (
              <span className="mt-1 block font-mono text-xs text-fg-subtle">{error.digest}</span>
            ) : null}
          </>
        }
        action={
          <div className="flex gap-2">
            <Button onClick={reset}>
              <RotateCw /> {t('Erneut versuchen')}
            </Button>
            <Button variant="outline" asChild>
              <Link href="/">{t('Zur Startseite')}</Link>
            </Button>
          </div>
        }
      />
    </Card>
  );
}
