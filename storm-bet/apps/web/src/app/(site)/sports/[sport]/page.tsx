import type { EventSummaryDto, LeagueDto, Paginated, SportDto, SportKey } from '@storm-bet/types';
import { SPORT_KEYS } from '@storm-bet/types';
import { cn } from '@storm-bet/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { EventList } from '@/components/sportsbook/event-list';
import { LiveDot } from '@/components/sportsbook/live-indicator';
import { PageHeader, SectionTitle } from '@/components/sportsbook/page-header';
import { SPORT_LABELS } from '@/lib/labels';
import { getPlatformMeta, tryServerApi } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ sport: string }>;
}): Promise<Metadata> {
  const { sport } = await params;
  return { title: SPORT_LABELS[sport as SportKey] ?? 'Sport' };
}

export default async function SportPage({
  params,
  searchParams,
}: {
  params: Promise<{ sport: string }>;
  searchParams: Promise<{ league?: string }>;
}) {
  const { sport } = await params;
  const { league } = await searchParams;
  if (!(SPORT_KEYS as readonly string[]).includes(sport)) notFound();
  const leagueFilter = league && /^[0-9a-f-]{36}$/i.test(league) ? `&league=${league}` : '';

  const { odds } = await getPlatformMeta();
  const within = odds.isSimulated ? 36 : 7 * 24;
  const [detail, live, upcoming] = await Promise.all([
    tryServerApi<{ sport: SportDto; leagues: LeagueDto[] }>(`/sports/${sport}`),
    tryServerApi<Paginated<EventSummaryDto>>(
      `/events?sport=${sport}&status=live&limit=50${leagueFilter}`,
    ),
    tryServerApi<Paginated<EventSummaryDto>>(
      `/events?sport=${sport}&status=upcoming&withinHours=${within}&limit=60${leagueFilter}`,
    ),
  ]);
  if (!detail) notFound();

  const chip = (active: boolean) =>
    cn(
      'shrink-0 rounded-full border px-3 py-1.5 text-sm transition-colors',
      active
        ? 'border-accent/40 bg-accent-soft text-fg'
        : 'border-border bg-surface text-fg-muted hover:text-fg',
    );

  return (
    <div className="space-y-6">
      <PageHeader
        title={detail.sport.name}
        description={`${detail.sport.eventCount} Events · ${detail.sport.liveCount} live · ${
          odds.isSimulated ? 'simulierte Demo-Daten' : `Quoten: ${odds.name}`
        }`}
      />
      {detail.leagues.length > 1 ? (
        <div
          className="scrollbar-none -mx-4 flex gap-2 overflow-x-auto px-4"
          aria-label="Wettbewerbe"
        >
          <Link href={`/sports/${sport}`} className={chip(!league)}>
            Alle Wettbewerbe
          </Link>
          {detail.leagues.map((l) => (
            <Link
              key={l.id}
              href={`/sports/${sport}?league=${l.id}`}
              className={chip(league === l.id)}
            >
              {l.name} <span className="tabular text-xs text-fg-subtle">{l.eventCount}</span>
            </Link>
          ))}
        </div>
      ) : null}
      {live && live.items.length > 0 ? (
        <section className="space-y-3">
          <SectionTitle>
            <LiveDot /> Live
          </SectionTitle>
          <EventList events={live.items} subscribeLive />
        </section>
      ) : null}
      <section className="space-y-3">
        <SectionTitle>Demnächst</SectionTitle>
        <EventList
          events={upcoming?.items ?? []}
          emptyTitle="Keine anstehenden Events"
          emptyDescription="In diesem Wettbewerb sind aktuell keine Spiele angesetzt."
        />
      </section>
    </div>
  );
}
