'use client';

import type {
  EventDetailDto,
  EventInsightsDto,
  FormEntryDto,
  IncidentDto,
  IncidentKind,
} from '@storm-bet/types';
import { PERIOD_LABELS } from '@storm-bet/types';
import { Card, cn, Tabs, TabsList, TabsTrigger } from '@storm-bet/ui';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { useLiveEvent } from './hooks';

const INCIDENT_LABELS: Record<IncidentKind, string> = {
  KICK_OFF: 'Anpfiff',
  PERIOD_START: 'Beginn',
  HALF_TIME: 'Halbzeit',
  FULL_TIME: 'Abpfiff',
  GOAL: 'Tor',
  GOAL_CANCELLED: 'Tor zurückgenommen',
  YELLOW_CARD: 'Gelbe Karte',
  RED_CARD: 'Rote Karte',
  CORNER: 'Ecke',
};

const ICONS: Partial<Record<IncidentKind, React.ReactNode>> = {
  GOAL: <span aria-hidden="true">⚽</span>,
  YELLOW_CARD: (
    <span aria-hidden="true" className="inline-block h-3.5 w-2.5 rounded-[2px] bg-yellow-400" />
  ),
  RED_CARD: (
    <span aria-hidden="true" className="inline-block h-3.5 w-2.5 rounded-[2px] bg-red-500" />
  ),
  CORNER: <span aria-hidden="true">⚑</span>,
};

type Tab = 'ticker' | 'form' | 'h2h' | 'table';

/** Live ticker, form, head-to-head and league table below the scoreboard. */
export function MatchInfo({ event }: { event: EventDetailDto }) {
  const live = useLiveEvent(event);
  const started = live.status !== 'SCHEDULED' && live.status !== 'POSTPONED';
  const [tab, setTab] = useState<Tab>(started ? 'ticker' : 'form');
  const [incidents, setIncidents] = useState<IncidentDto[] | null>(null);
  const [insights, setInsights] = useState<EventInsightsDto | null>(null);

  // A new ticker line comes with a changed score, figure or period.
  const stats = live.statistics ?? event.statistics;
  const changeKey = useMemo(
    () => JSON.stringify([live.status, live.score, live.liveState?.period, stats]),
    [live.status, live.score, live.liveState?.period, stats],
  );
  useEffect(() => {
    if (!started) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api<{ items: IncidentDto[] }>(`/events/${event.id}/incidents`)
        .then((r) => !cancelled && setIncidents(r.items))
        .catch(() => undefined);
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [event.id, started, changeKey]);

  useEffect(() => {
    let cancelled = false;
    api<EventInsightsDto>(`/events/${event.id}/insights`)
      .then((r) => !cancelled && setInsights(r))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [event.id]);

  const tabs: { key: Tab; label: string }[] = [
    ...(started ? [{ key: 'ticker' as const, label: 'Live-Ticker' }] : []),
    { key: 'form', label: 'Form' },
    { key: 'h2h', label: 'Direkter Vergleich' },
    ...(insights?.standings ? [{ key: 'table' as const, label: 'Tabelle' }] : []),
  ];

  return (
    <Card className="overflow-hidden" data-testid="match-info">
      <div className="border-b border-border px-2 pt-2">
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList aria-label="Spielinfos">
            {tabs.map((t) => (
              <TabsTrigger key={t.key} value={t.key}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      <div className="max-h-96 overflow-y-auto p-3 text-sm">
        {tab === 'ticker' ? (
          <Ticker items={incidents} home={event.home.name} away={event.away.name} />
        ) : tab === 'form' ? (
          insights ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <FormList team={event.home.name} games={insights.form.home} />
              <FormList team={event.away.name} games={insights.form.away} />
            </div>
          ) : (
            <Muted>Lädt …</Muted>
          )
        ) : tab === 'h2h' ? (
          <HeadToHead insights={insights} />
        ) : (
          <Standings insights={insights} />
        )}
      </div>
    </Card>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="py-4 text-center text-xs text-fg-muted">{children}</p>;
}

function Ticker({
  items,
  home,
  away,
}: {
  items: IncidentDto[] | null;
  home: string;
  away: string;
}) {
  if (items === null) return <Muted>Lädt …</Muted>;
  if (items.length === 0)
    return <Muted>Noch keine Ereignisse. Neue Tore, Karten und Ecken erscheinen hier.</Muted>;
  return (
    <ol className="space-y-1" data-testid="ticker">
      {items.map((i) => {
        const team = i.side === 'HOME' ? home : i.side === 'AWAY' ? away : null;
        const phase =
          i.kind === 'PERIOD_START' && i.period
            ? `${PERIOD_LABELS[i.period] ?? i.period}`
            : INCIDENT_LABELS[i.kind];
        const major = i.kind === 'GOAL' || i.kind === 'RED_CARD';
        return (
          <li
            key={i.id}
            className={cn(
              'flex items-center gap-3 rounded-md px-2 py-1.5',
              major ? 'bg-accent-soft' : i.side === null ? 'bg-surface-2' : '',
            )}
            data-testid="ticker-item"
          >
            <span className="tabular w-10 shrink-0 text-xs text-fg-muted">{i.clock ?? ''}</span>
            <span className="flex w-4 shrink-0 justify-center">{ICONS[i.kind] ?? null}</span>
            <span className="min-w-0 flex-1">
              <span className={cn(major && 'font-semibold')}>{phase}</span>
              {team ? <span className="text-fg-muted"> · {team}</span> : null}
              {i.playerName ? <span className="text-fg-muted"> · {i.playerName}</span> : null}
            </span>
            {i.score && (i.kind === 'GOAL' || i.kind === 'GOAL_CANCELLED' || i.side === null) ? (
              <span className="tabular shrink-0 font-semibold">
                {i.score.home}:{i.score.away}
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

const RESULT_STYLE = {
  W: 'bg-up text-white',
  D: 'bg-surface-3 text-fg',
  L: 'bg-down text-white',
} as const;
const RESULT_LABEL = { W: 'S', D: 'U', L: 'N' } as const;

function FormList({ team, games }: { team: string; games: FormEntryDto[] }) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="truncate font-semibold">{team}</p>
        <span className="flex gap-1">
          {[...games].reverse().map((g) => (
            <span
              key={g.eventId}
              className={cn(
                'grid size-5 place-items-center rounded text-[10px] font-bold',
                RESULT_STYLE[g.result],
              )}
              title={`${g.goalsFor}:${g.goalsAgainst} gegen ${g.opponent}`}
            >
              {RESULT_LABEL[g.result]}
            </span>
          ))}
        </span>
      </div>
      {games.length === 0 ? (
        <p className="text-xs text-fg-muted">Keine erfassten Spiele.</p>
      ) : (
        <ul className="space-y-1 text-xs">
          {games.map((g) => (
            <li key={g.eventId} className="flex justify-between gap-2 text-fg-muted">
              <span className="truncate">
                {g.home ? 'vs' : '@'} {g.opponent}
              </span>
              <span className="tabular shrink-0 font-semibold text-fg">
                {g.goalsFor}:{g.goalsAgainst}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function HeadToHead({ insights }: { insights: EventInsightsDto | null }) {
  if (!insights) return <Muted>Lädt …</Muted>;
  if (insights.headToHead.length === 0) return <Muted>Keine erfassten Duelle dieser Teams.</Muted>;
  return (
    <ul className="space-y-1.5">
      {insights.headToHead.map((g) => (
        <li key={g.eventId} className="grid grid-cols-[auto_1fr_auto_1fr] items-center gap-2">
          <span className="text-xs text-fg-subtle">{formatDateTime(g.startTime)}</span>
          <span className="truncate text-right">{g.homeTeam}</span>
          <span className="tabular rounded bg-surface-3 px-2 font-semibold">
            {g.score.home}:{g.score.away}
          </span>
          <span className="truncate">{g.awayTeam}</span>
        </li>
      ))}
    </ul>
  );
}

function Standings({ insights }: { insights: EventInsightsDto | null }) {
  const table = insights?.standings;
  if (!table) return <Muted>Keine Tabelle verfügbar.</Muted>;
  return (
    <div>
      <p className="mb-2 text-xs text-fg-muted">
        {table.competition} · Quelle: {table.source}
      </p>
      <table className="tabular w-full text-xs">
        <thead className="text-fg-subtle">
          <tr>
            <th className="w-6 text-left font-normal">#</th>
            <th className="text-left font-normal">Team</th>
            <th className="w-7 font-normal">Sp</th>
            <th className="hidden w-7 font-normal sm:table-cell">S</th>
            <th className="hidden w-7 font-normal sm:table-cell">U</th>
            <th className="hidden w-7 font-normal sm:table-cell">N</th>
            <th className="w-12 font-normal">Tore</th>
            <th className="w-8 font-normal">Pkt</th>
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r) => (
            <tr key={r.position} className={cn(r.highlight && 'bg-accent-soft font-semibold')}>
              <td className="py-1">{r.position}</td>
              <td className="truncate py-1">{r.team}</td>
              <td className="text-center">{r.played}</td>
              <td className="hidden text-center sm:table-cell">{r.won}</td>
              <td className="hidden text-center sm:table-cell">{r.draw}</td>
              <td className="hidden text-center sm:table-cell">{r.lost}</td>
              <td className="text-center">
                {r.goalsFor}:{r.goalsAgainst}
              </td>
              <td className="text-center font-semibold">{r.points}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
