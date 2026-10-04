'use client';

import type { BoostDto, EventSummaryDto } from '@storm-bet/types';
import { cn } from '@storm-bet/ui';
import { Zap } from 'lucide-react';
import Link from 'next/link';
import { useT } from '@/i18n/client';
import { formatKickoff } from '@/lib/format';
import { OUTCOME_LABELS } from '@storm-bet/types';
import { useLiveEvent } from '../sportsbook/hooks';
import { LiveDot } from '../sportsbook/live-indicator';
import { OddsButton } from '../sportsbook/odds-button';
import { TeamBadge, teamHue } from '../sportsbook/team-badge';

/** Featured matches to swipe through, each with its 1X2 (or winner) prices. */
export function TopMatches({ events, boosts }: { events: EventSummaryDto[]; boosts: BoostDto[] }) {
  if (events.length === 0) return null;
  return (
    <section aria-label="Top-Spiele" className="-mx-4 lg:mx-0">
      <div className="flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none] lg:px-0 [&::-webkit-scrollbar]:hidden">
        {events.map((event) => (
          <MatchCard
            key={event.id}
            event={event}
            boost={boosts.find((b) => b.eventId === event.id && b.open && !b.used) ?? null}
          />
        ))}
      </div>
    </section>
  );
}

function MatchCard({ event, boost }: { event: EventSummaryDto; boost: BoostDto | null }) {
  const t = useT();
  const live = useLiveEvent(event);
  const market = event.mainMarket;
  const h1 = teamHue(event.home.name);
  const h2 = teamHue(event.away.name);
  const name = `${event.home.name} – ${event.away.name}`;
  return (
    <article
      className="relative w-[86%] shrink-0 snap-center overflow-hidden rounded-2xl border border-white/10 sm:w-[420px]"
      style={{
        background: `radial-gradient(120% 90% at 0% 0%, hsl(${h1} 60% 32% / 0.95), transparent 60%), radial-gradient(120% 90% at 100% 100%, hsl(${h2} 60% 28% / 0.95), transparent 60%), #0b0d14`,
      }}
      data-testid="top-match"
    >
      {/* Generated pattern instead of photos: no third-party images. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.07] [background-image:repeating-linear-gradient(115deg,#fff_0_2px,transparent_2px_14px)]"
      />
      <Link href={`/events/${event.id}`} className="relative block px-4 pt-3">
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-black/45 px-2.5 py-1 text-xs font-medium text-white backdrop-blur">
            {live.isLive ? (
              <span className="inline-flex items-center gap-1.5 text-live">
                <LiveDot /> {live.liveState?.clock ?? t('Live')}
              </span>
            ) : (
              t(formatKickoff(event.startTime))
            )}
          </span>
          <span className="truncate text-xs text-white/70">{event.league.name}</span>
          {boost ? (
            <span className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md bg-accent px-2 py-0.5 text-[11px] font-bold uppercase text-accent-fg">
              <Zap className="size-3" aria-hidden="true" /> Boost +{boost.upliftPct}%
            </span>
          ) : null}
        </div>
        <div className="space-y-1.5 py-4">
          {[event.home, event.away].map((team, i) => (
            <div key={team.id} className="flex items-center gap-2.5">
              <TeamBadge name={team.name} short={team.shortName} className="size-8 text-[11px]" />
              <span className="min-w-0 flex-1 truncate text-lg font-extrabold uppercase tracking-tight text-white sm:text-xl">
                {team.name}
              </span>
              {live.score ? (
                <span className="tabular text-xl font-bold text-white">
                  {i === 0 ? live.score.home : live.score.away}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </Link>
      {market ? (
        <div
          className={cn(
            'relative grid gap-2 px-3 pb-3',
            market.selections.length === 3 ? 'grid-cols-3' : 'grid-cols-2',
          )}
        >
          {market.selections.map((s) => (
            <OddsButton
              key={s.id}
              selection={s}
              label={t(OUTCOME_LABELS[s.outcome])}
              layout="inline"
              className="min-h-11 border-white/10 bg-black/40 backdrop-blur hover:bg-black/55"
              context={{
                eventId: event.id,
                eventName: name,
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
        <div className="h-3" />
      )}
    </article>
  );
}
