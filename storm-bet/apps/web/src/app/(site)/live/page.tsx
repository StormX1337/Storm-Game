import type { EventSummaryDto, Paginated } from '@storm-bet/types';
import type { Metadata } from 'next';
import { AutoRefresh } from '@/components/sportsbook/auto-refresh';
import { EventList } from '@/components/sportsbook/event-list';
import { PageHeader } from '@/components/sportsbook/page-header';
import { getPlatformMeta, tryServerApi } from '@/lib/server-api';
import { getT } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('Live') };
}
export const dynamic = 'force-dynamic';

export default async function LivePage() {
  const t = await getT();
  const [live, { odds }] = await Promise.all([
    tryServerApi<Paginated<EventSummaryDto>>('/live'),
    getPlatformMeta(),
  ]);
  return (
    <div className="space-y-5">
      <PageHeader
        title={t('Live')}
        description={
          odds.isSimulated
            ? t('Laufende Events mit Live-Quoten. Alle Spiele sind simuliert (Demo-Daten).')
            : t('Laufende Events. Quoten: {0} – nur Live-Märkte mit aktuellen Quoten sind offen.', [
                odds.name,
              ])
        }
      />
      <AutoRefresh seconds={60} />
      <EventList
        events={live?.items ?? []}
        subscribeLive
        emptyTitle={t('Gerade läuft kein Event')}
        emptyDescription={t(
          'Neue Spiele beginnen laufend – die Seite aktualisiert sich automatisch.',
        )}
      />
    </div>
  );
}
