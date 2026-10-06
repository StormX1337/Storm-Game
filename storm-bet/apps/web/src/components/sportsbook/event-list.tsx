'use client';

import type { EventSummaryDto } from '@storm-bet/types';
import { Card, EmptyState } from '@storm-bet/ui';
import { CalendarX } from 'lucide-react';
import { useRealtimeTopics } from '../providers/realtime';
import { DemoDataBadge } from './live-indicator';
import { EventRow } from './event-row';
import { SportIcon } from './sport-icon';
import { useT } from '@/i18n/client';

function groupByLeague(events: EventSummaryDto[]) {
  const groups = new Map<
    string,
    {
      league: EventSummaryDto['league'];
      sport: EventSummaryDto['sport'];
      events: EventSummaryDto[];
    }
  >();
  for (const e of events) {
    const g = groups.get(e.league.id) ?? { league: e.league, sport: e.sport, events: [] };
    g.events.push(e);
    groups.set(e.league.id, g);
  }
  return [...groups.values()];
}

export function LeagueHeader({
  name,
  country,
  sport,
  count,
  simulated,
}: {
  name: string;
  country: string | null;
  sport: string;
  count: number;
  simulated: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5 border-b border-border bg-surface-2/50 px-3 py-2.5 md:px-5 md:py-3">
      <span className="grid size-6 shrink-0 place-items-center rounded-md bg-surface-3 text-fg-muted">
        <SportIcon sport={sport} className="size-3.5" />
      </span>
      <h3 className="truncate text-[13px] font-bold tracking-tight text-fg md:text-sm">{name}</h3>
      {country ? <span className="truncate text-xs text-fg-subtle">{country}</span> : null}
      <span className="ml-auto flex items-center gap-2.5">
        {simulated ? <DemoDataBadge /> : null}
        <span className="tabular text-xs text-fg-subtle">{count}</span>
      </span>
    </div>
  );
}

/** Events grouped by league, kept live over the realtime stream. */
export function EventList({
  events,
  subscribeLive = false,
  emptyTitle = 'Keine Events',
  emptyDescription,
  boosts,
  emptyAction,
}: {
  events: EventSummaryDto[];
  emptyAction?: React.ReactNode;
  subscribeLive?: boolean;
  /** Open odds boosts: event id → uplift in percent. */
  boosts?: Record<string, number>;
  emptyTitle?: string;
  emptyDescription?: string;
}) {
  const t = useT();
  useRealtimeTopics([
    ...(subscribeLive ? ['live'] : []),
    ...events.slice(0, 48).map((e) => `event:${e.id}`),
  ]);
  if (events.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<CalendarX />}
          title={t(emptyTitle)}
          description={emptyDescription}
          action={emptyAction}
        />
      </Card>
    );
  }
  return (
    <div className="space-y-4">
      {groupByLeague(events).map((group) => (
        <Card key={group.league.id} className="overflow-hidden">
          <LeagueHeader
            name={group.league.name}
            country={group.league.country}
            sport={group.sport.key}
            count={group.events.length}
            simulated={group.events.some((e) => e.dataSource.isSimulated)}
          />
          <div>
            {group.events.map((e) => (
              <EventRow key={e.id} event={e} boost={boosts?.[e.id]} />
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}

export function EventListSkeleton({ rows = 6 }: { rows?: number }) {
  const t = useT();
  return (
    <Card className="overflow-hidden" aria-busy="true" aria-label={t('Lädt')}>
      <div className="border-b border-border px-4 py-3">
        <div className="h-4 w-40 animate-pulse rounded bg-surface-3" />
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="grid gap-3 border-b border-border/70 px-3 py-3 md:grid-cols-[minmax(0,1fr)_minmax(270px,340px)_56px] md:items-center md:px-5 md:py-3.5"
        >
          <div className="space-y-2">
            <div className="h-3.5 w-3/5 animate-pulse rounded bg-surface-3" />
            <div className="h-3.5 w-2/5 animate-pulse rounded bg-surface-3" />
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {[0, 1, 2].map((k) => (
              <div key={k} className="h-11 animate-pulse rounded-lg bg-surface-3 md:h-12" />
            ))}
          </div>
        </div>
      ))}
    </Card>
  );
}
