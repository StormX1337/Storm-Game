'use client';

import type { BetDto, EventStatistics, Pair } from '@storm-bet/types';
import { PERIOD_LABELS } from '@storm-bet/types';
import { cn } from '@storm-bet/ui';
import { BarChart3, Flag, RectangleVertical, Zap } from 'lucide-react';
import { formatKickoff } from '@/lib/format';
import { useRealtimeTopics } from '../providers/realtime';
import { useLiveEvent } from '../sportsbook/hooks';

type Leg = BetDto['selections'][number];

function figures(stats: EventStatistics | null, leg: Leg) {
  if (stats?.sport === 'football') {
    const cards =
      stats.yellowCards && stats.redCards
        ? {
            home: stats.yellowCards.home + stats.redCards.home,
            away: stats.yellowCards.away + stats.redCards.away,
          }
        : null;
    return { corners: stats.corners ?? leg.event.corners, cards: cards ?? leg.event.cards };
  }
  return { corners: leg.event.corners, cards: leg.event.cards };
}

const sum = (p: Pair | null) => (p ? p.home + p.away : null);

/**
 * The match beside a pick: running clock and score in play (pushed live),
 * the final score afterwards, and the figure a corners or cards pick is
 * decided on.
 */
export function LegLive({ leg }: { leg: Leg }) {
  useRealtimeTopics([`event:${leg.eventId}`]);
  const live = useLiveEvent({
    id: leg.eventId,
    status: leg.event.status,
    score: leg.event.score,
    liveState: leg.event.liveState,
    isLive: leg.event.status === 'LIVE',
  });
  const { corners, cards } = figures(live.statistics, leg);
  const stat =
    leg.marketType === 'TOTAL_CORNERS'
      ? { icon: Flag, value: sum(corners), label: 'Ecken' }
      : leg.marketType === 'TOTAL_CARDS'
        ? { icon: RectangleVertical, value: sum(cards), label: 'Karten' }
        : null;
  const statBadge =
    stat && stat.value !== null ? (
      <span
        className="tabular inline-flex items-center gap-1 text-[11px] font-semibold text-fg-muted"
        title={stat.label}
      >
        <stat.icon className="size-3" aria-hidden="true" /> {stat.value}
      </span>
    ) : null;

  if (live.isLive) {
    const period = live.liveState?.period;
    const clock = live.liveState?.clock ?? (period ? (PERIOD_LABELS[period] ?? period) : 'Live');
    return (
      <div className="flex shrink-0 items-center gap-2" data-testid="leg-live">
        {statBadge}
        <span className="tabular inline-flex items-center gap-1 text-xs font-semibold text-live">
          <Zap className="size-3.5 fill-current" aria-hidden="true" /> {clock}
        </span>
        {live.score ? (
          <span className="tabular flex flex-col text-right text-sm font-bold leading-tight text-accent-strong">
            <span>{live.score.home}</span>
            <span>{live.score.away}</span>
          </span>
        ) : null}
      </div>
    );
  }
  if (live.status === 'FINISHED' && live.score) {
    return (
      <div className="flex shrink-0 items-center gap-2">
        {statBadge}
        <span className="tabular inline-flex items-center gap-1 rounded-full bg-surface-3 px-2 py-0.5 text-[11px] font-semibold text-fg-muted">
          <BarChart3 className="size-3" aria-hidden="true" /> Ergebnis {live.score.home}:
          {live.score.away}
        </span>
      </div>
    );
  }
  if (live.status === 'CANCELLED' || live.status === 'POSTPONED')
    return (
      <span className="text-[11px] text-fg-subtle">
        {live.status === 'CANCELLED' ? 'Abgesagt' : 'Verschoben'}
      </span>
    );
  return (
    <span className={cn('tabular shrink-0 text-[11px] text-fg-subtle')}>
      {formatKickoff(leg.startTime)}
    </span>
  );
}
