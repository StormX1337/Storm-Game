import type { EventSummaryDto, Paginated, SportDto } from '@storm-bet/types';
import type { Metadata } from 'next';
import Link from 'next/link';
import { EventList } from '@/components/sportsbook/event-list';
import { LiveDot } from '@/components/sportsbook/live-indicator';
import { PageHeader, SectionTitle } from '@/components/sportsbook/page-header';
import { SportIcon } from '@/components/sportsbook/sport-icon';
import { getPlatformMeta, tryServerApi } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Sportarten' };
export const dynamic = 'force-dynamic';

export default async function SportsPage() {
  const { odds } = await getPlatformMeta();
  const within = odds.isSimulated ? 12 : 72;
  const [sports, upcoming] = await Promise.all([
    tryServerApi<SportDto[]>('/sports'),
    tryServerApi<Paginated<EventSummaryDto>>(
      `/events?status=upcoming&withinHours=${within}&limit=30`,
    ),
  ]);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Sportarten"
        description={`Alle verfügbaren Sportarten und die nächsten Events. ${
          odds.isSimulated ? 'Sämtliche Daten sind simuliert.' : `Quoten: ${odds.name}.`
        }`}
      />
      <div className="grid gap-3 sm:grid-cols-3">
        {(sports ?? []).map((s) => (
          <Link
            key={s.key}
            href={`/sports/${s.key}`}
            className="rounded-lg border border-border bg-surface p-4 transition-colors hover:border-border-strong hover:bg-surface-2"
          >
            <SportIcon sport={s.key} className="size-5 text-accent" />
            <p className="mt-3 font-semibold">{s.name}</p>
            <p className="mt-0.5 text-xs text-fg-muted">
              {s.eventCount} Events
              {s.liveCount ? (
                <span className="ml-2 inline-flex items-center gap-1 text-live">
                  <LiveDot /> {s.liveCount} live
                </span>
              ) : null}
            </p>
          </Link>
        ))}
      </div>
      <SectionTitle>Die nächsten Events</SectionTitle>
      <EventList events={upcoming?.items ?? []} emptyTitle="Keine anstehenden Events" />
    </div>
  );
}
