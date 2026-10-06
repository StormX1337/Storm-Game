'use client';

import type { BoostDto, EventSummaryDto } from '@storm-bet/types';
import { OUTCOME_LABELS, PERIOD_LABELS } from '@storm-bet/types';
import { cn } from '@storm-bet/ui';
import { ChevronRight, Lock, Zap } from 'lucide-react';
import Link from 'next/link';
import { memo } from 'react';
import { useT } from '@/i18n/client';
import { formatKickoff } from '@/lib/format';
import { eventName } from './event-row';
import { useLiveEvent } from './hooks';
import { LiveBadge } from './live-indicator';
import { OddsButton } from './odds-button';
import { SportIcon } from './sport-icon';
import { TeamBadge, teamHue } from './team-badge';

/**
 * One match as a card: when and where, both teams (with the score once it
 * runs) and the main market. `variant="live"` puts score and clock first.
 */
export const MatchCard = memo(function MatchCard({
  event,
  boost = null,
  variant = 'featured',
  className,
}: {
  event: EventSummaryDto;
  boost?: BoostDto | null;
  variant?: 'featured' | 'live';
  className?: string;
}) {
  const t = useT();
  const live = useLiveEvent(event);
  const market = event.mainMarket;
  const closed = live.status === 'FINISHED' || live.status === 'CANCELLED';
  const h1 = teamHue(event.home.name);
  const h2 = teamHue(event.away.name);
  // Markets beyond the one shown on the card.
  const more = Math.max(0, event.marketCount - (market ? 1 : 0));
  const clock = [
    t(PERIOD_LABELS[live.liveState?.period ?? ''] ?? live.liveState?.period ?? ''),
    live.liveState?.clock,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <article
      className={cn(
        'relative flex flex-col overflow-hidden rounded-xl border bg-surface p-3 shadow-[var(--shadow-card)] transition-[border-color,box-shadow] duration-200 hover:border-border-strong hover:shadow-[var(--shadow-pop)] lg:p-3.5',
        live.isLive
          ? 'border-live/30'
          : variant === 'featured'
            ? 'border-accent/20 bg-brand-soft'
            : 'border-border',
        className,
      )}
      data-testid={variant === 'live' ? 'live-card' : 'top-match'}
    >
      {/* A thin line in the teams' colours: identity without logos or photos. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-0.5 opacity-80"
        style={{
          // Live: a red-to-violet accent; otherwise the teams' colours.
          background: live.isLive
            ? 'linear-gradient(90deg, var(--color-live), var(--color-violet))'
            : `linear-gradient(90deg, hsl(${h1} 70% 55%), hsl(${h2} 70% 55%))`,
        }}
      />
      <Link href={`/events/${event.id}`} className="group block">
        <div className="flex items-center gap-2 text-[11px]">
          {live.isLive ? (
            <>
              <LiveBadge />
              <span className="tabular shrink-0 whitespace-nowrap font-semibold text-live">
                {clock || t('Läuft')}
              </span>
            </>
          ) : closed ? (
            <span className="font-semibold text-fg-subtle">
              {live.status === 'CANCELLED' ? t('Abgesagt') : t('Beendet')}
            </span>
          ) : (
            <span className="tabular shrink-0 whitespace-nowrap font-semibold text-fg">
              {t(formatKickoff(event.startTime))}
            </span>
          )}
          <span className="flex min-w-0 items-center gap-1 text-fg-subtle">
            <SportIcon sport={event.sport.key} className="size-3" />
            <span className="truncate">{event.league.name}</span>
          </span>
          {boost ? (
            <span className="ml-auto inline-flex shrink-0 items-center gap-0.5 rounded-md bg-violet-soft px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-strong">
              <Zap className="size-3" aria-hidden="true" /> {t('Boost')} +{boost.upliftPct}%
            </span>
          ) : null}
        </div>
        <div className="mt-2.5 space-y-1.5">
          {[event.home, event.away].map((team, i) => (
            <div key={team.id} className="flex items-center gap-2.5">
              <TeamBadge name={team.name} className="size-6 text-[9px]" />
              <span
                className={cn(
                  'min-w-0 flex-1 truncate font-bold tracking-tight transition-colors group-hover:text-accent-strong',
                  // Featured cards set the teams like a fixture poster; live cards stay compact.
                  variant === 'featured'
                    ? 'text-[14px] uppercase lg:text-[15px]'
                    : 'text-[15px] lg:text-base',
                )}
              >
                {team.name}
              </span>
              {live.score ? (
                <span
                  className={cn(
                    'tabular w-8 shrink-0 text-right text-xl font-extrabold leading-none',
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
        <div
          className={cn(
            'mt-3 grid gap-1.5',
            market.selections.length === 3 ? 'grid-cols-3' : 'grid-cols-2',
          )}
        >
          {market.selections.map((s) => (
            <OddsButton
              key={s.id}
              selection={s}
              label={t(OUTCOME_LABELS[s.outcome])}
              layout="stacked"
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
      ) : !closed ? (
        // No main market right now (e.g. a sport without 1X2): one quiet line, no empty block.
        <p className="mt-2.5 flex items-center gap-1.5 rounded-lg bg-surface-2 px-3 py-2 text-xs text-fg-muted">
          <Lock className="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
          {t('Quoten aktuell nicht verfügbar')}
        </p>
      ) : null}
      {more > 0 ? (
        <Link
          href={`/events/${event.id}`}
          className="mt-2 flex items-center justify-center gap-0.5 text-[11px] font-medium text-fg-muted transition-colors hover:text-fg lg:text-xs"
        >
          {t('{0} weitere Märkte', [more])}
          <ChevronRight className="size-3.5" aria-hidden="true" />
        </Link>
      ) : null}
    </article>
  );
});

/** Placeholder with the card's exact shape, so nothing jumps when data arrives. */
export function MatchCardSkeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn('rounded-xl border border-border bg-surface p-3.5', className)}
    >
      <div className="h-3 w-32 animate-pulse rounded bg-surface-3" />
      <div className="mt-4 space-y-2.5">
        {[0, 1].map((i) => (
          <div key={i} className="flex items-center gap-2.5">
            <div className="size-6 animate-pulse rounded-full bg-surface-3" />
            <div className="h-3.5 w-40 animate-pulse rounded bg-surface-3" />
          </div>
        ))}
      </div>
      <div className="mt-4 grid grid-cols-3 gap-1.5">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-11 animate-pulse rounded-lg bg-surface-3" />
        ))}
      </div>
    </div>
  );
}
