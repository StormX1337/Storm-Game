import type { EventSummaryDto, Paginated, SportDto, SportKey } from '@storm-bet/types';
import { SPORT_KEYS } from '@storm-bet/types';
import { Card, EmptyState } from '@storm-bet/ui';
import { CalendarClock, Radio } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { AutoRefresh } from '@/components/sportsbook/auto-refresh';
import { EventList } from '@/components/sportsbook/event-list';
import { FilterChips, ViewTabs } from '@/components/sportsbook/filter-chips';
import { LiveDot } from '@/components/sportsbook/live-indicator';
import { LiveGrid } from '@/components/sportsbook/live-grid';
import { PageHeader } from '@/components/sportsbook/page-header';
import { SportIcon } from '@/components/sportsbook/sport-icon';
import { getPlatformMeta, tryServerApi } from '@/lib/server-api';
import { getT } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('Live') };
}
export const dynamic = 'force-dynamic';

export default async function LivePage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; sport?: string }>;
}) {
  const t = await getT();
  const params = await searchParams;
  const view = params.view === 'upcoming' ? 'upcoming' : 'live';
  const sport = (SPORT_KEYS as readonly string[]).includes(params.sport ?? '')
    ? (params.sport as SportKey)
    : null;
  const sportFilter = sport ? `&sport=${sport}` : '';
  const [sports, events, { odds }] = await Promise.all([
    tryServerApi<SportDto[]>('/sports'),
    tryServerApi<Paginated<EventSummaryDto>>(
      view === 'live'
        ? `/live?${sportFilter.slice(1)}`
        : `/events?status=upcoming&withinHours=6&limit=60${sportFilter}`,
    ),
    getPlatformMeta(),
  ]);
  const items = events?.items ?? [];
  const liveTotal = (sports ?? []).reduce((sum, s) => sum + s.liveCount, 0);
  const href = (v: string, s: string | null) => {
    const q = new URLSearchParams();
    if (v === 'upcoming') q.set('view', v);
    if (s) q.set('sport', s);
    const qs = q.toString();
    return `/live${qs ? `?${qs}` : ''}`;
  };
  const chips = [
    { key: 'all', href: href(view, null), label: t('Alle'), active: !sport },
    ...(sports ?? [])
      .filter((s) => (view === 'live' ? s.liveCount > 0 : s.eventCount > 0) || s.key === sport)
      .map((s) => ({
        key: s.key,
        href: href(view, s.key),
        label: (
          <>
            <SportIcon sport={s.key} /> {t(s.name)}
          </>
        ),
        active: sport === s.key,
        count: view === 'live' ? s.liveCount : undefined,
      })),
  ];

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
      <ViewTabs
        label={t('Ansicht')}
        items={[
          {
            key: 'live',
            href: href('live', sport),
            active: view === 'live',
            label: (
              <>
                <LiveDot /> {t('Live jetzt')}
                <span className="tabular text-xs text-fg-subtle">{liveTotal}</span>
              </>
            ),
          },
          {
            key: 'upcoming',
            href: href('upcoming', sport),
            active: view === 'upcoming',
            label: t('Demnächst'),
          },
        ]}
      />
      <FilterChips label={t('Sportarten')} items={chips} />
      <AutoRefresh seconds={60} />
      {view === 'live' ? (
        items.length ? (
          <LiveGrid events={items} />
        ) : (
          <Card>
            <EmptyState
              icon={<Radio />}
              title={t('Keine Live-Events')}
              description={t('Gerade läuft kein Event. Neue Spiele beginnen laufend.')}
              action={
                <Link
                  href={href('upcoming', sport)}
                  className="inline-flex h-9 items-center rounded-lg bg-accent px-4 text-sm font-semibold text-accent-fg hover:bg-accent-hover"
                >
                  {t('Kommende Spiele ansehen')}
                </Link>
              }
            />
          </Card>
        )
      ) : (
        <EventList
          events={items}
          emptyTitle={t('Keine Spiele in den nächsten Stunden')}
          emptyDescription={t('Schau später wieder vorbei oder wähle eine andere Sportart.')}
        />
      )}
      {view === 'upcoming' ? (
        <p className="flex items-center gap-1.5 text-xs text-fg-subtle">
          <CalendarClock className="size-3.5" aria-hidden="true" />
          {t('Anstoß in den nächsten 6 Stunden.')}
        </p>
      ) : null}
    </div>
  );
}
