import type {
  BoostDto,
  CasinoLobbyDto,
  EventSummaryDto,
  LeagueDto,
  Paginated,
  SportDto,
} from '@storm-bet/types';
import { Button, Card } from '@storm-bet/ui';
import { ArrowRight, HeartHandshake, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { EventBrowser } from '@/components/home/event-browser';
import { LeagueChips } from '@/components/home/league-chips';
import { QuickTiles, type QuickTile } from '@/components/home/quick-tiles';
import { TopMatches } from '@/components/home/top-matches';
import { BoostList } from '@/components/sportsbook/boost-list';
import { getT } from '@/i18n/server';
import { getPlatformMeta, getSessionUser, tryServerApi } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

/** Matches worth a hero card: boosted ones first, then live, then the next kick-offs. */
function featured(live: EventSummaryDto[], upcoming: EventSummaryDto[], boosts: BoostDto[]) {
  const boosted = new Set(boosts.filter((b) => b.open).map((b) => b.eventId));
  const withPrices = (e: EventSummaryDto) => e.mainMarket !== null;
  const all = [...live, ...upcoming].filter(withPrices);
  const ranked = [
    ...all.filter((e) => boosted.has(e.id)),
    ...live.filter((e) => withPrices(e) && e.sport.key === 'football'),
    ...upcoming.filter((e) => withPrices(e) && e.sport.key === 'football'),
    ...all,
  ];
  return [...new Map(ranked.map((e) => [e.id, e])).values()].slice(0, 8);
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
  const game = (slug: string) => casino?.games.find((g) => g.slug === slug);
  const casinoTile = (slug: string, label: string, icon: QuickTile['icon'], gradient: string) => {
    const g = game(slug);
    return g
      ? { href: `/casino/${g.id}`, label, theme: g.theme }
      : { href: user ? '/casino' : '/login?next=/casino', label, icon, gradient };
  };
  const tiles: QuickTile[] = [
    casinoTile('storm-crash', 'Storm Crash', 'crash', 'linear-gradient(135deg,#0f172a,#7c3aed)'),
    {
      href: '#boosts',
      label: 'Quoten-Boosts',
      icon: 'boost',
      gradient: 'linear-gradient(135deg,#1e3a8a,#6d8bff)',
    },
    {
      href: '/sports/football',
      label: 'Bet Builder',
      icon: 'builder',
      gradient: 'linear-gradient(135deg,#064e3b,#10b981)',
    },
    casinoTile('storm-wheel', 'Glücksrad', 'wheel', 'linear-gradient(135deg,#7c2d12,#f59e0b)'),
    {
      href: '/feed',
      label: 'Tipp-Feed',
      icon: 'feed',
      gradient: 'linear-gradient(135deg,#4c1d95,#db2777)',
    },
    {
      href: '/leaderboard',
      label: 'Rangliste',
      icon: 'trophy',
      gradient: 'linear-gradient(135deg,#713f12,#eab308)',
    },
  ];

  return (
    <div className="space-y-6">
      {!user ? (
        <Card className="relative overflow-hidden p-4 sm:p-5">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -right-16 -top-16 size-56 rounded-full bg-accent/20 blur-3xl"
          />
          <div className="relative flex flex-wrap items-center gap-3">
            <Sparkles className="size-5 text-accent" aria-hidden="true" />
            <p className="min-w-0 flex-1 text-sm">
              <span className="font-semibold">{t('1.000 € Startguthaben')}</span>{' '}
              <span className="text-fg-muted">
                {t('Spielgeld ohne Geldwert – nicht einzahlbar, nicht auszahlbar.')}
              </span>
            </p>
            <Button size="sm" asChild>
              <Link href="/register">
                {t('Kostenlos testen')} <ArrowRight />
              </Link>
            </Button>
          </div>
        </Card>
      ) : null}

      <TopMatches events={featured(liveItems, upcomingItems, boostList)} boosts={boostList} />
      <QuickTiles tiles={tiles} />
      <LeagueChips leagues={leagues ?? []} />

      <div id="boosts" className="scroll-mt-20">
        <BoostList />
      </div>

      <EventBrowser
        sports={sports ?? []}
        initial={liveItems.length ? liveItems : upcomingItems}
        initialMode={liveItems.length ? 'live' : 'upcoming'}
        withinHours={within}
      />

      <Card className="p-5">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-warning-soft text-warning">
            <HeartHandshake className="size-5" aria-hidden="true" />
          </span>
          <div className="space-y-2">
            <p className="font-semibold">{t('Verantwortungsvoll spielen')}</p>
            <p className="text-sm text-fg-muted">
              {t(
                'Wetten sollen unterhalten, nicht belasten. Nutze Einsatzlimits und die Selbstsperre in deinem Konto. Teilnahme ab 18 Jahren. Hilfe bei Glücksspielproblemen: BZgA-Hotline 0800 1 37 27 00.',
              )}
            </p>
            <Link
              href="/responsible-gaming"
              className="inline-flex items-center gap-1 text-sm text-accent hover:underline"
            >
              {t('Mehr erfahren')} <ArrowRight className="size-3.5" aria-hidden="true" />
            </Link>
          </div>
        </div>
      </Card>
    </div>
  );
}
