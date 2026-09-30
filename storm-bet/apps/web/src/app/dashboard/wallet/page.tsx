import type { Paginated, TransactionDto, WalletDto } from '@storm-bet/types';
import { Card, CardContent, CardHeader, CardTitle } from '@storm-bet/ui';
import { Info } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { TopUpButton } from '@/components/dashboard/top-up';
import { TransactionsTable } from '@/components/dashboard/transactions-table';
import { PageHeader } from '@/components/sportsbook/page-header';
import { formatMoney } from '@/lib/format';
import { serverApi } from '@/lib/server-api';
import { getT } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('Guthaben') };
}

export default async function WalletPage() {
  const t = await getT();
  const [wallet, recent] = await Promise.all([
    serverApi<WalletDto>('/wallet'),
    serverApi<Paginated<TransactionDto>>('/transactions?limit=8'),
  ]);
  return (
    <>
      <PageHeader
        title={t('Demo-Guthaben')}
        description={t('Spielgeld ohne Geldwert – nicht einzahlbar, nicht auszahlbar.')}
        actions={<TopUpButton />}
      />
      <Card className="p-6">
        <p className="text-xs font-medium text-fg-muted">{t('Verfügbar')}</p>
        <p
          className="tabular mt-1 text-4xl font-semibold tracking-tight"
          data-testid="wallet-available"
        >
          {formatMoney(wallet.available)}
        </p>
        <div className="mt-5 grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
          <div>
            <p className="text-xs text-fg-muted">{t('Kontostand gesamt')}</p>
            <p className="tabular text-lg font-semibold">{formatMoney(wallet.balance)}</p>
          </div>
          <div>
            <p className="text-xs text-fg-muted">{t('Reserviert für offene Wetten')}</p>
            <p className="tabular text-lg font-semibold">{formatMoney(wallet.reserved)}</p>
          </div>
        </div>
      </Card>
      <div className="flex gap-3 rounded-lg border border-border bg-surface-2/60 p-4 text-sm text-fg-muted">
        <Info className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
        <p>
          {t('Beim Platzieren wird dein Einsatz')} <strong className="text-fg">reserviert</strong>
          {t(
            '. Bei der Abrechnung wird er freigegeben: Gewinne werden gutgeschrieben, verlorene Einsätze abgebucht, stornierte Einsätze erstattet. Aufladen ist einmal pro Tag möglich, wenn weniger als 50 € verfügbar sind.',
          )}
        </p>
      </div>
      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle>{t('Letzte Buchungen')}</CardTitle>
          <Link href="/dashboard/transactions" className="text-sm text-accent hover:underline">
            {t('Alle anzeigen')}
          </Link>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <TransactionsTable items={recent.items} nextCursor={null} path="/transactions" />
        </CardContent>
      </Card>
    </>
  );
}
