'use client';

import type { EventDetailDto, MarketDto, MarketType, SportKey } from '@storm-bet/types';
import { MARKET_DEFINITIONS, OUTCOME_LABELS } from '@storm-bet/types';
import { Card, cn, EmptyState, Tabs, TabsList, TabsTrigger } from '@storm-bet/ui';
import { Lock, Timer } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLive } from '@/stores/live';
import { useRealtimeTopics } from '../providers/realtime';
import { eventName } from './event-row';
import { useLiveEvent, useLiveMarketStatus } from './hooks';
import { OddsButton, type OddsContext } from './odds-button';

const GROUPS: Record<SportKey, { key: string; label: string; types: MarketType[] }[]> = {
  football: [
    { key: 'main', label: 'Hauptwetten', types: ['MATCH_RESULT', 'DOUBLE_CHANCE', 'DRAW_NO_BET'] },
    { key: 'goals', label: 'Tore', types: ['TOTAL_GOALS', 'BOTH_TEAMS_TO_SCORE'] },
    { key: 'handicap', label: 'Handicap', types: ['ASIAN_HANDICAP'] },
    {
      key: 'halves',
      label: 'Halbzeiten',
      types: [
        'HALF_TIME_RESULT',
        'FIRST_HALF_HANDICAP',
        'FIRST_HALF_TOTAL_GOALS',
        'SECOND_HALF_RESULT',
        'SECOND_HALF_TOTAL_GOALS',
      ],
    },
    { key: 'specials', label: 'Ecken & Karten', types: ['TOTAL_CORNERS', 'TOTAL_CARDS'] },
    { key: 'players', label: 'Spieler', types: ['PLAYER_TO_SCORE'] },
  ],
  tennis: [
    { key: 'main', label: 'Sieger', types: ['MATCH_WINNER', 'FIRST_SET_WINNER'] },
    { key: 'sets', label: 'Sätze', types: ['SET_BETTING'] },
    { key: 'games', label: 'Spiele', types: ['TOTAL_GAMES', 'GAME_HANDICAP'] },
  ],
  basketball: [
    { key: 'main', label: 'Sieger', types: ['MATCH_WINNER'] },
    { key: 'spread', label: 'Handicap', types: ['POINT_SPREAD'] },
    { key: 'totals', label: 'Punkte', types: ['TOTAL_POINTS'] },
    {
      key: 'halves',
      label: '1. Halbzeit',
      types: ['FIRST_HALF_WINNER', 'FIRST_HALF_SPREAD', 'FIRST_HALF_TOTAL_POINTS'],
    },
    {
      key: 'players',
      label: 'Spieler',
      types: ['PLAYER_POINTS', 'PLAYER_REBOUNDS', 'PLAYER_ASSISTS'],
    },
  ],
};

const THREE_WAY_SHORT: MarketType[] = [
  'MATCH_RESULT',
  'DOUBLE_CHANCE',
  'HALF_TIME_RESULT',
  'SECOND_HALF_RESULT',
];

/** Over/Under and handicap lines of one type render as a single card. */
function combineLines(markets: MarketDto[]) {
  const byType = new Map<MarketType, MarketDto[]>();
  for (const m of markets) byType.set(m.type, [...(byType.get(m.type) ?? []), m]);
  return [...byType.entries()];
}

export function EventMarkets({ event }: { event: EventDetailDto }) {
  const router = useRouter();
  const live = useLiveEvent(event);
  useRealtimeTopics([`event:${event.id}`]);
  const groups = GROUPS[event.sport.key];
  const [tab, setTab] = useState('all');

  // New in-play lines or a status change of the event: fetch the fresh book.
  const known = useMemo(() => new Set(event.markets.map((m) => m.id)), [event.markets]);
  const marketsSeen = useLive((s) => s.markets);
  const lastRefresh = useRef(0);
  useEffect(() => {
    const unknown = Object.keys(marketsSeen).some(
      (id) => !known.has(id) && marketsSeen[id] !== 'SETTLED',
    );
    const statusChanged = live.status !== event.status;
    if ((unknown || statusChanged) && Date.now() - lastRefresh.current > 5_000) {
      lastRefresh.current = Date.now();
      router.refresh();
    }
  }, [marketsSeen, known, live.status, event.status, router]);

  const visible = event.markets.filter((m) => m.status !== 'CLOSED' && m.status !== 'SETTLED');
  if (visible.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<Timer />}
          title={
            live.status === 'FINISHED'
              ? 'Das Event ist beendet'
              : live.status === 'CANCELLED'
                ? 'Das Event wurde abgesagt'
                : 'Keine Märkte verfügbar'
          }
          description={
            live.status === 'FINISHED' ? 'Offene Wetten werden automatisch abgerechnet.' : undefined
          }
        />
      </Card>
    );
  }

  const shown =
    tab === 'all'
      ? visible
      : visible.filter((m) => groups.find((g) => g.key === tab)?.types.includes(m.type));
  const context = (m: MarketDto): OddsContext => ({
    eventId: event.id,
    eventName: eventName(event),
    sportKey: event.sport.key,
    startTime: event.startTime,
    isLive: live.isLive,
    marketId: m.id,
    marketName: m.name,
    marketStatus: m.status,
  });

  return (
    <div className="space-y-3">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="Marktgruppen">
          <TabsTrigger value="all">Alle</TabsTrigger>
          {groups
            .filter((g) => visible.some((m) => g.types.includes(m.type)))
            .map((g) => (
              <TabsTrigger key={g.key} value={g.key}>
                {g.label}
              </TabsTrigger>
            ))}
        </TabsList>
      </Tabs>
      <div className="grid gap-3 xl:grid-cols-2">
        {combineLines(shown).map(([type, markets]) => (
          <MarketCard key={type} markets={markets} context={context} />
        ))}
      </div>
    </div>
  );
}

function MarketCard({
  markets,
  context,
}: {
  markets: MarketDto[];
  context: (m: MarketDto) => OddsContext;
}) {
  const first = markets[0]!;
  const playerTotal = MARKET_DEFINITIONS[first.type].kind === 'PLAYER_TOTAL';
  const title = playerTotal
    ? MARKET_DEFINITIONS[first.type].label
    : first.line == null
      ? first.name
      : first.name.replace(/\s[+-]?\d+(\.\d+)?$/, '');
  const player = first.type === 'PLAYER_TO_SCORE';
  const wide = player || playerTotal || markets.length > 1;
  return (
    <Card className={cn('overflow-hidden', wide && 'xl:col-span-2')} data-testid="market-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      <div className="space-y-2 p-3">
        {markets.map((m) => (
          <MarketRow
            key={m.id}
            market={m}
            context={context(m)}
            showLine={markets.length > 1 && !playerTotal}
            player={player}
            playerTotal={playerTotal}
          />
        ))}
      </div>
    </Card>
  );
}

function MarketRow({
  market,
  context,
  showLine,
  player,
  playerTotal,
}: {
  market: MarketDto;
  context: OddsContext;
  showLine: boolean;
  player: boolean;
  playerTotal: boolean;
}) {
  const status = useLiveMarketStatus(market.id, market.status);
  const cols = player
    ? 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4'
    : market.selections.length === 3
      ? 'grid-cols-3'
      : market.selections.length === 4
        ? 'grid-cols-2 sm:grid-cols-4'
        : 'grid-cols-2';
  const shortLabel = market.selections.length <= 3 && THREE_WAY_SHORT.includes(market.type);
  const signed = MARKET_DEFINITIONS[market.type].kind === 'HANDICAP';
  return (
    <div className="flex items-center gap-3">
      {playerTotal ? (
        // "Jayson Tatum – Punkte Über/Unter 27.5" → "Jayson Tatum"
        <span className="w-28 shrink-0 truncate text-xs font-medium sm:w-40" title={market.name}>
          {market.name.split(' – ')[0]}
        </span>
      ) : null}
      {showLine ? (
        <span className="tabular w-12 shrink-0 text-xs font-medium text-fg-muted">
          {market.line == null ? '' : signed && market.line > 0 ? `+${market.line}` : market.line}
        </span>
      ) : null}
      <div className={cn('grid flex-1 gap-1.5', cols)}>
        {market.selections.map((s) => (
          <OddsButton
            key={s.id}
            selection={s}
            context={{ ...context, marketStatus: status }}
            label={shortLabel ? `${OUTCOME_LABELS[s.outcome]} · ${s.name}` : s.name}
            layout={player ? 'inline' : 'stacked'}
          />
        ))}
      </div>
      {status === 'SUSPENDED' ? (
        <Lock className="size-3.5 shrink-0 text-fg-subtle" aria-label="Markt gesperrt" />
      ) : null}
    </div>
  );
}
