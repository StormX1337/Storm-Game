import type { CasinoRoundDto, Paginated } from '@storm-bet/types';
import type { Metadata } from 'next';
import { CasinoHistory } from '@/components/casino/history';
import { PageHeader } from '@/components/sportsbook/page-header';
import { serverApi } from '@/lib/server-api';
import { getT } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('Verlauf') };
}

export default async function CasinoHistoryPage() {
  const t = await getT();
  const rounds = await serverApi<Paginated<CasinoRoundDto>>('/casino/history?limit=25');
  return (
    <>
      <PageHeader
        title={t('Casino-Verlauf')}
        description={t(
          'Jede Runde mit Einsatz, Ergebnis und Auszahlung – serverseitig gespeichert.',
        )}
      />
      <CasinoHistory initial={rounds} />
    </>
  );
}
