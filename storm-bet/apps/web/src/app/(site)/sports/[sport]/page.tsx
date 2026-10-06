import type {
  BoostDto,
  EventSummaryDto,
  LeagueDto,
  Paginated,
  SportDto,
  SportKey,
} from '@storm-bet/types';
import { SPORT_KEYS } from '@storm-bet/types';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LoadError } from '@/components/shell/load-error';
import { EventList } from '@/components/sportsbook/event-list';
import { FilterChips, ViewTabs } from '@/components/sportsbook/filter-chips';
import { LiveDot } from '@/components/sportsbook/live-indicator';
import { SectionTitle } from '@/components/sportsbook/page-header';
import { SportIcon } from '@/components/sportsbook/sport-icon';
import { SPORT_LABELS } from '@/lib/labels';
import { getPlatformMeta, serverApi, ServerApiError, tryServerApi } from '@/lib/server-api';
import { getT } from '@/i18n/server';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ sport: string }>;
}): Promise<Metadata> {
  const { sport } = await params;
  const t = await getT();
  return { title: t(SPORT_LABELS[sport as SportKey] ?? 'Sport') };
}

export default async function SportPage({
  params,
  searchParams,
}: {
  params: Promise<{ sport: string }>;
  searchParams: Promise<{ league?: string; day?: string; tab?: string }>;
}) {
  const t = await getT();
  const { sport } = await params;
  const { league, day: dayParam, tab: tabParam } = await searchParams;
  if (!(SPORT_KEYS as readonly string[]).includes(sport)) notFound();
  const days = calendarDays();
  const day = days.some((d) => d.value === dayParam) ? dayParam : undefined;
  const tab = tabParam === 'live' ? 'live' : day ? 'day' : 'popular';
  const leagueId = league && /^[0-9a-f-]{36}$/i.test(league) ? league : undefined;
  const leagueFilter = leagueId ? `&league=${leagueId}` : '';

  const { odds } = await getPlatformMeta();
  const within = odds.isSimulated ? 36 : 7 * 24;
  const [detail, events, boostList] = await Promise.all([
    loadSport(sport),
    tryServerApi<Paginated<EventSummaryDto>>(
      tab === 'live'
        ? `/events?sport=${sport}&status=live&limit=50${leagueFilter}`
        : `/events?sport=${sport}&status=upcoming&limit=60${leagueFilter}${
            day ? `&day=${day}` : `&withinHours=${within}`
          }`,
    ),
    tryServerApi<{ boosts: BoostDto[] }>('/boosts'),
  ]);
  const boosts = Object.fromEntries(
    (boostList?.boosts ?? []).filter((b) => b.open).map((b) => [b.eventId, b.upliftPct]),
  );
  if (detail === 'missing') notFound();
  if (detail === null) return <LoadError message="Spiele konnten nicht geladen werden." />;

  const href = (next: { tab?: string; day?: string; league?: string | null }) => {
    const q = new URLSearchParams();
    const l = next.league === undefined ? leagueId : next.league;
    if (next.tab) q.set('tab', next.tab);
    if (next.day) q.set('day', next.day);
    if (l) q.set('league', l);
    const qs = q.toString();
    return `/sports/${sport}${qs ? `?${qs}` : ''}`;
  };
  const [today, tomorrow, ...later] = days;
  const keepView = tab === 'live' ? { tab: 'live' } : day ? { day } : {};

  return (
    <div className="space-y-5">
      <header className="flex items-center gap-3">
        <span className="grid size-12 shrink-0 place-items-center rounded-2xl border border-accent/25 bg-accent-soft text-accent-strong">
          <SportIcon sport={sport} className="size-6" />
        </span>
        <div className="min-w-0">
          <h1 className="text-2xl font-extrabold tracking-tight">{t(detail.sport.name)}</h1>
          <p className="text-sm text-fg-muted">
            {t('{0} Events · {1} live · {2}', [
              detail.sport.eventCount,
              detail.sport.liveCount,
              odds.isSimulated ? t('simulierte Demo-Daten') : t('Quoten: {0}', [odds.name]),
            ])}
          </p>
        </div>
      </header>

      <ViewTabs
        label={t('Ansicht')}
        items={[
          { key: 'popular', href: href({}), label: t('Beliebt'), active: tab === 'popular' },
          {
            key: 'live',
            href: href({ tab: 'live' }),
            active: tab === 'live',
            label: (
              <>
                <LiveDot /> {t('Live')}
                <span className="tabular text-xs text-fg-subtle">{detail.sport.liveCount}</span>
              </>
            ),
          },
          {
            key: 'today',
            href: href({ day: today!.value }),
            label: t('Heute'),
            active: day === today!.value,
          },
          {
            key: 'tomorrow',
            href: href({ day: tomorrow!.value }),
            label: t('Morgen'),
            active: day === tomorrow!.value,
          },
        ]}
      />
      {tab !== 'live' ? (
        <FilterChips
          label={t('Tage')}
          items={later.map((d) => ({
            key: d.value,
            href: href({ day: d.value }),
            label: t(d.label),
            active: day === d.value,
            testId: 'day-chip',
          }))}
        />
      ) : null}

      {detail.leagues.length > 1 ? (
        <section className="space-y-2.5">
          <SectionTitle>{t('Wettbewerbe')}</SectionTitle>
          <FilterChips
            label={t('Wettbewerbe')}
            items={[
              {
                key: 'all',
                href: href({ ...keepView, league: null }),
                label: t('Alle Wettbewerbe'),
                active: !leagueId,
              },
              ...detail.leagues.map((l) => ({
                key: l.id,
                href: href({ ...keepView, league: l.id }),
                label: l.name,
                active: leagueId === l.id,
                count: l.eventCount,
              })),
            ]}
          />
        </section>
      ) : null}

      {events === null ? (
        <LoadError message="Spiele konnten nicht geladen werden." />
      ) : (
        <EventList
          events={events.items}
          boosts={boosts}
          subscribeLive={tab === 'live'}
          emptyTitle={tab === 'live' ? t('Gerade läuft kein Event') : t('Keine Spiele verfügbar.')}
          emptyDescription={
            tab === 'live'
              ? t('Neue Spiele beginnen laufend – schau gleich wieder vorbei.')
              : t('Versuche ein anderes Datum oder einen anderen Wettbewerb.')
          }
          emptyAction={
            tab !== 'popular' || leagueId ? (
              <Link
                href={`/sports/${sport}`}
                className="inline-flex h-9 items-center rounded-lg bg-accent px-4 text-sm font-semibold text-accent-fg hover:bg-accent-hover"
              >
                {t('Andere Spiele anzeigen')}
              </Link>
            ) : undefined
          }
        />
      )}
    </div>
  );
}

/** The sport's leagues; 'missing' for an unknown sport, null when the API is unreachable. */
async function loadSport(sport: string) {
  try {
    return await serverApi<{ sport: SportDto; leagues: LeagueDto[] }>(`/sports/${sport}`);
  } catch (error) {
    if (error instanceof ServerApiError && error.status === 404) return 'missing' as const;
    return null;
  }
}

/** Today and the next six days (Europe/Berlin). */
function calendarDays(): { value: string; label: string }[] {
  const key = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' });
  const label = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
  });
  return Array.from({ length: 7 }, (_, i) => {
    const date = new Date(Date.now() + i * 86_400_000);
    return {
      value: key.format(date),
      label: i === 0 ? 'Heute' : i === 1 ? 'Morgen' : label.format(date),
    };
  });
}
