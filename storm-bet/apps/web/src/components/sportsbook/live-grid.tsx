'use client';

import type { EventSummaryDto } from '@storm-bet/types';
import { useRealtimeTopics } from '../providers/realtime';
import { MatchCard } from './match-card';

/** Running matches as cards; score, clock and prices follow the realtime stream. */
export function LiveGrid({ events }: { events: EventSummaryDto[] }) {
  useRealtimeTopics(['live', ...events.slice(0, 48).map((e) => `event:${e.id}`)]);
  return (
    <div className="grid gap-3 md:grid-cols-2" data-testid="live-grid">
      {events.map((event) => (
        <MatchCard key={event.id} event={event} variant="live" />
      ))}
    </div>
  );
}
