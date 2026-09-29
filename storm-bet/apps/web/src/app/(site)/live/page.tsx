import type { EventSummaryDto, Paginated } from '@storm-bet/types';
import type { Metadata } from 'next';
import { AutoRefresh } from '@/components/sportsbook/auto-refresh';
import { EventList } from '@/components/sportsbook/event-list';
import { PageHeader } from '@/components/sportsbook/page-header';
import { getPlatformMeta, tryServerApi } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Live' };
export const dynamic = 'force-dynamic';

export default async function LivePage() {
  const [live, { odds }] = await Promise.all([
    tryServerApi<Paginated<EventSummaryDto>>('/live'),
    getPlatformMeta(),
  ]);
  return (
    <div className="space-y-5">
      <PageHeader
        title="Live"
        description={
          odds.isSimulated
            ? 'Laufende Events mit Live-Quoten. Alle Spiele sind simuliert (Demo-Daten).'
            : `Laufende Events. Quoten: ${odds.name} – nur Live-Märkte mit aktuellen Quoten sind offen.`
        }
      />
      <AutoRefresh seconds={60} />
      <EventList
        events={live?.items ?? []}
        subscribeLive
        emptyTitle="Gerade läuft kein Event"
        emptyDescription="Neue Spiele beginnen laufend – die Seite aktualisiert sich automatisch."
      />
    </div>
  );
}
