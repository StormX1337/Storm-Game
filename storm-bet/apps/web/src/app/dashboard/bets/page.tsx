import type { BetDto, Paginated } from '@storm-bet/types';
import { Card, cn, EmptyState } from '@storm-bet/ui';
import { Receipt } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { BetCard } from '@/components/dashboard/bet-card';
import { MoreBets } from '@/components/dashboard/bet-list';
import { PageHeader } from '@/components/sportsbook/page-header';
import { serverApi } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Meine Wetten' };

const FILTERS = [
  { key: 'all', label: 'Alle' },
  { key: 'open', label: 'Offen' },
  { key: 'won', label: 'Gewonnen' },
  { key: 'lost', label: 'Verloren' },
  { key: 'void', label: 'Storniert' },
] as const;

export default async function BetsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status: raw } = await searchParams;
  const status = FILTERS.some((f) => f.key === raw) ? (raw as string) : 'all';
  const page = await serverApi<Paginated<BetDto>>(`/bets?status=${status}&limit=10`);
  return (
    <>
      <PageHeader
        title="Meine Wetten"
        description="Alle Wetten mit Einsatz, Quote zum Annahmezeitpunkt und Ergebnis."
      />
      <nav className="scrollbar-none flex gap-1 overflow-x-auto" aria-label="Filter">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={f.key === 'all' ? '/dashboard/bets' : `/dashboard/bets?status=${f.key}`}
            className={cn(
              'shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              status === f.key ? 'bg-surface-3 text-fg' : 'text-fg-muted hover:text-fg',
            )}
            aria-current={status === f.key ? 'page' : undefined}
          >
            {f.label}
          </Link>
        ))}
      </nav>
      {page.items.length === 0 ? (
        <Card>
          <EmptyState icon={<Receipt />} title="Keine Wetten in dieser Ansicht" />
        </Card>
      ) : (
        <div className="space-y-3">
          {page.items.map((bet) => (
            <BetCard key={bet.id} bet={bet} href={`/dashboard/bets/${bet.id}`} />
          ))}
          <MoreBets path={`/bets?status=${status}&limit=10`} cursor={page.nextCursor} />
        </div>
      )}
    </>
  );
}
