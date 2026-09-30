import { Button } from '@storm-bet/ui';
import Link from 'next/link';
import { Brand } from '@/components/shell/brand';
import { getT } from '@/i18n/server';

export default async function NotFound() {
  const t = await getT();
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 text-center">
      <Brand alwaysShowName />
      <div className="space-y-2">
        <p className="tabular text-5xl font-semibold text-fg-subtle">404</p>
        <h1 className="text-lg font-semibold">{t('Seite nicht gefunden')}</h1>
        <p className="text-sm text-fg-muted">
          {t('Die angeforderte Seite existiert nicht oder ist nicht mehr verfügbar.')}
        </p>
      </div>
      <Button asChild>
        <Link href="/">{t('Zur Startseite')}</Link>
      </Button>
    </div>
  );
}
