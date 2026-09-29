import type { CasinoRoundDto, Paginated } from '@storm-bet/types';
import type { Metadata } from 'next';
import { CasinoHistory } from '@/components/casino/history';
import { PageHeader } from '@/components/sportsbook/page-header';
import { serverApi } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Verlauf' };

export default async function CasinoHistoryPage() {
  const rounds = await serverApi<Paginated<CasinoRoundDto>>('/casino/history?limit=25');
  return (
    <>
      <PageHeader
        title="Casino-Verlauf"
        description="Jede Runde mit Einsatz, Ergebnis und Auszahlung – serverseitig gespeichert."
      />
      <CasinoHistory initial={rounds} />
    </>
  );
}
