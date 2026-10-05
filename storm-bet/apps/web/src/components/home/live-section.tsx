'use client';

import type { EventSummaryDto } from '@storm-bet/types';
import { CalendarClock } from 'lucide-react';
import Link from 'next/link';
import { useT } from '@/i18n/client';
import { useRealtimeTopics } from '../providers/realtime';
import { LiveDot } from '../sportsbook/live-indicator';
import { MatchCard } from '../sportsbook/match-card';
import { SectionHeader } from './section-header';

/** Matches running right now – score, clock and live prices kept current. */
export function LiveSection({ events, total }: { events: EventSummaryDto[]; total: number }) {
  const t = useT();
  useRealtimeTopics(['live', ...events.map((e) => `event:${e.id}`)]);
  return (
    <section className="space-y-3" aria-labelledby="live-now-title" data-testid="live-section">
      <SectionHeader
        id="live-now-title"
        title={t('Live jetzt')}
        icon={<LiveDot className="size-2" />}
        count={total}
        href="/live"
        linkLabel={t('Alle')}
      />
      {events.length ? (
        <div className="scrollbar-none -mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto overscroll-x-contain px-4 pb-1 md:mx-0 md:grid md:grid-cols-2 md:overflow-visible min-[1700px]:grid-cols-3 md:px-0">
          {events.map((event) => (
            <MatchCard
              key={event.id}
              event={event}
              variant="live"
              className="w-[85%] shrink-0 snap-start md:w-auto"
            />
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-3 rounded-xl border border-dashed border-border-strong bg-surface/60 p-4">
          <CalendarClock className="size-5 shrink-0 text-fg-subtle" aria-hidden="true" />
          <p className="min-w-0 flex-1 text-sm text-fg-muted">
            {t('Gerade läuft kein Live-Event.')}
          </p>
          <Link href="/sports" className="text-sm font-semibold text-accent-strong hover:text-fg">
            {t('Kommende Spiele')}
          </Link>
        </div>
      )}
    </section>
  );
}
