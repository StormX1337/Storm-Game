import type {
  BoostDto,
  CasinoLobbyDto,
  EventDetailDto,
  EventSummaryDto,
  LeagueDto,
  Paginated,
  SportDto,
} from '@storm-bet/types';
import { ArrowRight, HeartHandshake } from 'lucide-react';
import Link from 'next/link';
import { BalanceCard } from '@/components/home/balance-card';
import { BetBuilderCard } from '@/components/home/bet-builder-card';
import { EventBrowser } from '@/components/home/event-browser';
import { Features } from '@/components/home/features';
import { LeagueChips } from '@/components/home/league-chips';
import { LiveSection } from '@/components/home/live-section';
import { TopMatches } from '@/components/home/top-matches';
import { LoadError } from '@/components/shell/load-error';
import { BoostList } from '@/components/sportsbook/boost-list';
import { getT } from '@/i18n/server';
import { getPlatformMeta, getSessionUser, tryServerApi } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

/** Demo credit every new account starts with (minor units). */
const START_CREDIT = 100_000;

/** Upcoming matches worth a card: boosted ones first, then football, then the rest. */
function featured(upcoming: EventSummaryDto[], boosts: BoostDto[]) {
  const boosted = new Set(boosts.filter((b) => b.open).map((b) => b.eventId));
  const priced = upcoming.filter((e) => e.mainMarket !== null);
  const ranked = [
    ...priced.filter((e) => boosted.has(e.id)),
    ...priced.filter((e) => e.sport.key === 'football'),
    ...priced,
  ];
  return [...new Map(ranked.map((e) => [e.id, e])).values()].slice(0, 6);
}

export default async function HomePage() {
  const t = await getT();
  const { odds } = await getPlatformMeta();
  // Real fixtures are days apart; the simulator fills every hour.
  const within = odds.isSimulated ? 24 : 72;
  const user = await getSessionUser();
  const [sports, live, upcoming, leagues, boosts, casino] = await Promise.all([
    tryServerApi<SportDto[]>('/sports'),
    tryServerApi<Paginated<EventSummaryDto>>('/events?status=live&limit=25'),
    tryServerApi<Paginated<EventSummaryDto>>(
      `/events?status=upcoming&withinHours=${within}&limit=25`,
    ),
    tryServerApi<LeagueDto[]>('/leagues/top'),
    tryServerApi<{ boosts: BoostDto[] }>('/boosts'),
    user ? tryServerApi<CasinoLobbyDto>('/casino/games') : Promise.resolve(null),
  ]);
  const liveItems = live?.items ?? [];
  const upcomingItems = upcoming?.items ?? [];
  const boostList = boosts?.boosts ?? [];
  const top = featured(upcomingItems, boostList);

  // Bet Builder showcase: the first football match of the featured list.
  const builderId = top.find((e) => e.sport.key === 'football')?.id;
  const builderEvent = builderId
    ? await tryServerApi<EventDetailDto>(`/events/${builderId}`)
    : null;

  const crash = casino?.games.find((g) => g.slug === 'storm-crash');
  const crashHref = crash ? `/casino/${crash.id}` : user ? '/casino' : '/login?next=/casino';
  const liveTotal = (sports ?? []).reduce((sum, s) => sum + s.liveCount, 0);
  // Both lists missing means the API is unreachable, not that nothing is on.
  const failed = live === null && upcoming === null;

  return (
    <div className="space-y-8">
      <BalanceCard startCredit={START_CREDIT} />
      {failed ? (
        <LoadError />
      ) : (
        <LiveSection events={liveItems.slice(0, 6)} total={liveTotal || liveItems.length} />
      )}
      <TopMatches events={top} boosts={boostList} />
      <div id="boosts" className="scroll-mt-24">
        <BoostList />
      </div>
      {builderEvent ? <BetBuilderCard event={builderEvent} /> : null}
      <Features crashHref={crashHref} />
      <LeagueChips leagues={leagues ?? []} />
      {failed ? null : (
        <EventBrowser
          sports={sports ?? []}
          initial={liveItems.length ? liveItems : upcomingItems}
          initialMode={liveItems.length ? 'live' : 'upcoming'}
          withinHours={within}
        />
      )}
      <aside className="flex items-start gap-3 rounded-xl border border-border bg-surface p-4">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-warning-soft text-warning">
          <HeartHandshake className="size-[18px]" aria-hidden="true" />
        </span>
        <div className="space-y-1.5">
          <p className="text-sm font-semibold">{t('Verantwortungsvoll spielen')}</p>
          <p className="text-xs leading-relaxed text-fg-muted">
            {t(
              'Wetten sollen unterhalten, nicht belasten. Nutze Einsatzlimits und die Selbstsperre in deinem Konto. Teilnahme ab 18 Jahren. Hilfe bei Glücksspielproblemen: BZgA-Hotline 0800 1 37 27 00.',
            )}
          </p>
          <Link
            href="/responsible-gaming"
            className="inline-flex items-center gap-1 text-xs font-semibold text-accent-strong hover:text-fg"
          >
            {t('Mehr erfahren')} <ArrowRight className="size-3.5" aria-hidden="true" />
          </Link>
        </div>
      </aside>
    </div>
  );
}
