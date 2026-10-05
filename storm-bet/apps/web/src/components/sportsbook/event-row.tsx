'use client';

import type { EventSummaryDto } from '@storm-bet/types';
import { OUTCOME_LABELS } from '@storm-bet/types';
import { cn } from '@storm-bet/ui';
import { ChevronRight, Zap } from 'lucide-react';
import Link from 'next/link';
import { formatKickoff } from '@/lib/format';
import { useLiveEvent } from './hooks';
import { LiveBadge } from './live-indicator';
import { OddsButton } from './odds-button';
import { TeamBadge } from './team-badge';
import { useT } from '@/i18n/client';

export function eventName(e: Pick<EventSummaryDto, 'home' | 'away'>) {
  return `${e.home.name} – ${e.away.name}`;
}

export function EventRow({
  event,
  showLeague = false,
  boost,
}: {
  event: EventSummaryDto;
  showLeague?: boolean;
  /** Uplift of an open odds boost on this match, in percent. */
  boost?: number;
}) {
  const t = useT();
  const live = useLiveEvent(event);
  const market = event.mainMarket;
  const closed = live.status === 'FINISHED' || live.status === 'CANCELLED';
  const cols = market?.selections.length === 3 ? 'grid-cols-3' : 'grid-cols-2';
  const more = Math.max(0, event.marketCount - 1);

  return (
    <div
      className="grid grid-cols-1 gap-2.5 border-b border-border/70 px-3 py-3 transition-colors last:border-b-0 hover:bg-surface-2/40 md:grid-cols-[minmax(0,1fr)_minmax(270px,340px)_56px] md:items-center md:gap-5 md:px-5 md:py-3.5"
      data-testid="event-row"
    >
      <Link
        href={`/events/${event.id}`}
        className="group min-w-0 space-y-1.5"
        data-testid="event-link"
      >
        <div className="flex items-center gap-2 text-xs md:text-[13px]">
          {live.isLive ? (
            <>
              <LiveBadge />
              <span className="tabular font-semibold text-live">
                {live.liveState?.clock ?? live.liveState?.period ?? ''}
              </span>
            </>
          ) : closed ? (
            <span className="text-fg-subtle">
              {live.status === 'CANCELLED' ? t('Abgesagt') : t('Beendet')}
            </span>
          ) : (
            <span className="tabular font-medium text-fg-muted">
              {t(formatKickoff(event.startTime))}
            </span>
          )}
          {showLeague ? (
            <span className="min-w-0 truncate text-fg-subtle">· {event.league.name}</span>
          ) : null}
          {boost ? (
            <span className="inline-flex shrink-0 items-center gap-0.5 rounded-md bg-violet-soft px-1.5 py-px text-[10px] font-bold text-violet-strong md:text-[11px]">
              <Zap className="size-3" aria-hidden="true" />+{boost} %
            </span>
          ) : null}
          {more > 0 ? (
            <span className="ml-auto flex shrink-0 items-center text-fg-subtle md:hidden">
              +{more}
              <ChevronRight className="size-3.5" aria-hidden="true" />
            </span>
          ) : null}
        </div>
        {[event.home, event.away].map((team, i) => (
          <div key={team.id} className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2">
              <TeamBadge name={team.name} />
              <span
                className="truncate text-sm font-semibold text-fg transition-colors group-hover:text-accent-strong md:text-[15px]"
                data-testid="team-name"
              >
                {team.name}
              </span>
            </span>
            {live.score ? (
              <span
                className={cn(
                  'tabular min-w-5 text-right text-sm font-bold',
                  live.isLive ? 'text-fg' : 'text-fg-muted',
                )}
              >
                {i === 0 ? live.score.home : live.score.away}
              </span>
            ) : null}
          </div>
        ))}
      </Link>
      {market && !closed ? (
        <div className={cn('grid gap-1.5', cols)}>
          {market.selections.map((s) => (
            <OddsButton
              key={s.id}
              selection={s}
              label={t(OUTCOME_LABELS[s.outcome])}
              layout="stacked"
              className="md:min-h-12"
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
          {closed ? t('Keine Wetten') : t('Keine Quoten')}
        </div>
      )}
      <Link
        href={`/events/${event.id}`}
        className="hidden h-12 items-center justify-center gap-0.5 rounded-lg border border-transparent text-xs font-semibold text-fg-muted transition-colors hover:border-border hover:bg-surface-2 hover:text-fg md:flex"
        aria-label={t('Alle Märkte für {0}', [eventName(event)])}
      >
        +{more}
        <ChevronRight className="size-3.5" aria-hidden="true" />
      </Link>
    </div>
  );
}
