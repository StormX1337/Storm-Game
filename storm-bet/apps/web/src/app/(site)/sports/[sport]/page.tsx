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
  searchParams: Promise<{ league?: string; day?: string }>;
}) {
  const t = await getT();
  const { sport } = await params;
  const { league, day: dayParam } = await searchParams;
  const days = calendarDays();
  const day = days.some((d) => d.value === dayParam) ? dayParam : undefined;
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
      `/events?sport=${sport}&status=upcoming&limit=60${leagueFilter}${
        day ? `&day=${day}` : `&withinHours=${within}`
      }`,
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
        title={t(detail.sport.name)}
        description={t('{0} Events · {1} live · {2}', [
          detail.sport.eventCount,
          detail.sport.liveCount,
          odds.isSimulated ? t('simulierte Demo-Daten') : t('Quoten: {0}', [odds.name]),
        ])}
      />
      {detail.leagues.length > 1 ? (
        <div
          className="scrollbar-none -mx-4 flex gap-2 overflow-x-auto px-4"
          aria-label={t('Wettbewerbe')}
        >
          <Link href={`/sports/${sport}`} className={chip(!league)}>
            {t('Alle Wettbewerbe')}
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
            <LiveDot /> {t('Live')}
          </SectionTitle>
          <EventList events={live.items} subscribeLive />
        </section>
      ) : null}
      <section className="space-y-3">
        <SectionTitle>{t('Demnächst')}</SectionTitle>
        <div
          className="scrollbar-none -mx-4 flex gap-2 overflow-x-auto px-4"
          aria-label={t('Tage')}
        >
          {[{ value: undefined, label: t('Alle') }, ...days].map((d) => {
            const query = new URLSearchParams();
            if (league) query.set('league', league);
            if (d.value) query.set('day', d.value);
            const qs = query.toString();
            return (
              <Link
                key={d.label}
                href={`/sports/${sport}${qs ? `?${qs}` : ''}`}
                className={chip(day === d.value)}
                data-testid="day-chip"
              >
                {t(d.label)}
              </Link>
            );
          })}
        </div>
        <EventList
          events={upcoming?.items ?? []}
          emptyTitle={t('Keine anstehenden Events')}
          emptyDescription={
            day
              ? t('An diesem Tag sind keine Spiele angesetzt.')
              : t('In diesem Wettbewerb sind aktuell keine Spiele angesetzt.')
          }
        />
      </section>
    </div>
  );
}

/** Today and the next six days (Europe/Berlin) as filter chips. */
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
