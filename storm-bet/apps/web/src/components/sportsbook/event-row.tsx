'use client';

import type { EventSummaryDto } from '@storm-bet/types';
import { OUTCOME_LABELS } from '@storm-bet/types';
import { cn } from '@storm-bet/ui';
import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { formatKickoff } from '@/lib/format';
import { useLiveEvent } from './hooks';
import { LiveBadge } from './live-indicator';
import { OddsButton } from './odds-button';
import { TeamBadge } from './team-badge';

export function eventName(e: Pick<EventSummaryDto, 'home' | 'away'>) {
  return `${e.home.name} – ${e.away.name}`;
}

export function EventRow({
  event,
  showLeague = false,
}: {
  event: EventSummaryDto;
  showLeague?: boolean;
}) {
  const live = useLiveEvent(event);
  const market = event.mainMarket;
  const closed = live.status === 'FINISHED' || live.status === 'CANCELLED';
  const cols = market?.selections.length === 3 ? 'grid-cols-3' : 'grid-cols-2';

  return (
    <div
      className="grid grid-cols-1 gap-3 border-b border-border/70 px-3 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_minmax(240px,300px)_auto] md:items-center md:gap-4 md:px-4"
      data-testid="event-row"
    >
      <Link
        href={`/events/${event.id}`}
        className="group flex min-w-0 items-center gap-3"
        data-testid="event-link"
      >
        <div className="w-16 shrink-0 text-xs">
          {live.isLive ? (
            <div className="space-y-1">
              <LiveBadge />
              <p className="tabular text-fg-muted">
                {live.liveState?.clock ?? live.liveState?.period ?? ''}
              </p>
            </div>
          ) : closed ? (
            <span className="text-fg-subtle">
              {live.status === 'CANCELLED' ? 'Abgesagt' : 'Beendet'}
            </span>
          ) : (
            <span className="tabular text-fg-muted">{formatKickoff(event.startTime)}</span>
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          {showLeague ? (
            <p className="truncate text-[11px] text-fg-subtle">{event.league.name}</p>
          ) : null}
          {[event.home, event.away].map((team, i) => (
            <div key={team.id} className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-2">
                <TeamBadge name={team.name} />
                <span className="truncate text-sm text-fg group-hover:text-accent-strong">
                  {team.name}
                </span>
              </span>
              {live.score ? (
                <span
                  className={cn(
                    'tabular text-sm font-semibold',
                    live.isLive ? 'text-fg' : 'text-fg-muted',
                  )}
                >
                  {i === 0 ? live.score.home : live.score.away}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </Link>
      {market && !closed ? (
        <div className={cn('grid gap-1.5', cols)}>
          {market.selections.map((s) => (
            <OddsButton
              key={s.id}
              selection={s}
              label={OUTCOME_LABELS[s.outcome]}
              layout="inline"
              className="min-h-10"
              context={{
                eventId: event.id,
                eventName: eventName(event),
                sportKey: event.sport.key,
                startTime: event.startTime,
                isLive: live.isLive,
                marketId: market.id,
                marketName: market.name,
                marketStatus: market.status,
              }}
            />
          ))}
        </div>
      ) : (
        <div className="hidden text-center text-xs text-fg-subtle md:block">
          {closed ? 'Keine Wetten' : 'Keine Quoten'}
        </div>
      )}
      <Link
        href={`/events/${event.id}`}
        className="hidden items-center gap-0.5 justify-self-end rounded-md px-2 py-1 text-xs text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg md:flex"
        aria-label={`Alle Märkte für ${eventName(event)}`}
      >
        +{Math.max(0, event.marketCount - 1)}
        <ChevronRight className="size-3.5" aria-hidden="true" />
      </Link>
    </div>
  );
}
