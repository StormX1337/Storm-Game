import type { EventSummaryDto, Paginated } from '@storm-bet/types';
import type { Metadata } from 'next';
import { AutoRefresh } from '@/components/sportsbook/auto-refresh';
import { EventList } from '@/components/sportsbook/event-list';
import { PageHeader } from '@/components/sportsbook/page-header';
import { tryServerApi } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Live' };
export const dynamic = 'force-dynamic';

export default async function LivePage() {
  const live = await tryServerApi<Paginated<EventSummaryDto>>('/live');
  return (
    <div className="space-y-5">
      <PageHeader
        title="Live"
        description="Laufende Events mit Live-Quoten. Alle Spiele sind simuliert (Demo-Daten)."
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
