'use client';

import { Button, Card, EmptyState } from '@storm-bet/ui';
import { AlertTriangle, RotateCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { useT } from '@/i18n/client';

/**
 * Data that could not be loaded (API unreachable) – said plainly, with a retry,
 * instead of an empty list that would look like "no events today".
 */
export function LoadError({
  message = 'Die Events konnten nicht geladen werden.',
}: {
  message?: string;
}) {
  const t = useT();
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Card data-testid="load-error">
      <EmptyState
        icon={<AlertTriangle className="text-warning" />}
        title={t('Etwas ist schiefgelaufen.')}
        description={t(message)}
        action={
          <Button onClick={() => start(() => router.refresh())} loading={pending}>
            <RotateCw /> {t('Erneut versuchen')}
          </Button>
        }
      />
    </Card>
  );
}
