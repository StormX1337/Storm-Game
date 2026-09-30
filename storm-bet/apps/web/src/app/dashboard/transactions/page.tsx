import type { Paginated, TransactionDto } from '@storm-bet/types';
import { TRANSACTION_TYPES } from '@storm-bet/types';
import { Card, cn, EmptyState } from '@storm-bet/ui';
import { ArrowLeftRight } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { TransactionsTable } from '@/components/dashboard/transactions-table';
import { PageHeader } from '@/components/sportsbook/page-header';
import { TRANSACTION_LABELS } from '@/lib/labels';
import { serverApi } from '@/lib/server-api';
import { getT } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('Transaktionen') };
}

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  const t = await getT();
  const { type: raw } = await searchParams;
  const type = (TRANSACTION_TYPES as readonly string[]).includes(raw ?? '') ? raw : undefined;
  const path = `/transactions?limit=25${type ? `&type=${type}` : ''}`;
  const page = await serverApi<Paginated<TransactionDto>>(path);
  const chip = (active: boolean) =>
    cn(
      'shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
      active ? 'bg-surface-3 text-fg' : 'text-fg-muted hover:text-fg',
    );
  return (
    <>
      <PageHeader
        title={t('Transaktionen')}
        description={t('Jede Bewegung deines Demo-Guthabens – unveränderlich protokolliert.')}
      />
      <nav className="scrollbar-none flex gap-1 overflow-x-auto" aria-label={t('Filter')}>
        <Link href="/dashboard/transactions" className={chip(!type)}>
          {t('Alle')}
        </Link>
        {TRANSACTION_TYPES.map((kind) => (
          <Link
            key={kind}
            href={`/dashboard/transactions?type=${kind}`}
            className={chip(type === kind)}
          >
            {t(TRANSACTION_LABELS[kind])}
          </Link>
        ))}
      </nav>
      <Card className="overflow-hidden">
        {page.items.length === 0 ? (
          <EmptyState icon={<ArrowLeftRight />} title={t('Keine Transaktionen')} />
        ) : (
          <TransactionsTable items={page.items} nextCursor={page.nextCursor} path={path} />
        )}
      </Card>
    </>
  );
}
