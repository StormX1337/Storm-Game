'use client';

import type { BoostDto, EventSummaryDto } from '@storm-bet/types';
import { Star } from 'lucide-react';
import { useT } from '@/i18n/client';
import { MatchCard } from '../sportsbook/match-card';
import { SectionHeader } from './section-header';

/** Featured matches to swipe through (phones) or scan as a grid (desktop). */
export function TopMatches({ events, boosts }: { events: EventSummaryDto[]; boosts: BoostDto[] }) {
  const t = useT();
  if (events.length === 0) return null;
  return (
    <section className="space-y-3" aria-labelledby="top-matches-title">
      <SectionHeader
        id="top-matches-title"
        title={t('Top-Spiele')}
        icon={<Star className="size-4 text-warning" aria-hidden="true" />}
        href="/sports/football"
        linkLabel={t('Alle')}
      />
      <div className="scrollbar-none -mx-4 flex items-start snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto overscroll-x-contain px-4 pb-1 md:mx-0 md:grid md:grid-cols-2 md:overflow-visible min-[1700px]:grid-cols-3 md:px-0">
        {events.map((event) => (
          <MatchCard
            key={event.id}
            event={event}
            boost={boosts.find((b) => b.eventId === event.id && b.open && !b.used) ?? null}
            className="w-[85%] shrink-0 snap-start md:w-auto"
          />
        ))}
      </div>
    </section>
  );
}
