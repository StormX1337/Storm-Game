'use client';

import type { EventDetailDto, EventStatistics, Pair } from '@storm-bet/types';
import { PERIOD_LABELS } from '@storm-bet/types';
import { Card, cn } from '@storm-bet/ui';
import { formatDateTime, formatKickoff } from '@/lib/format';
import { EVENT_STATUS_LABELS } from '@/lib/labels';
import { useLiveEvent } from './hooks';
import { DemoDataBadge, LiveBadge } from './live-indicator';
import { SportIcon } from './sport-icon';

export function Scoreboard({ event }: { event: EventDetailDto }) {
  const live = useLiveEvent(event);
  const stats = live.statistics ?? event.statistics;
  const started = live.score !== null;
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5 text-xs text-fg-muted">
        <SportIcon sport={event.sport.key} />
        <span>{event.sport.name}</span>
        <span className="text-fg-subtle">/</span>
        <span className="truncate">{event.league.name}</span>
        <span className="ml-auto flex items-center gap-2">
          <DemoDataBadge />
          {live.isLive ? <LiveBadge /> : <span>{EVENT_STATUS_LABELS[live.status]}</span>}
        </span>
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4 px-4 py-6 sm:px-8">
        <TeamName name={event.home.name} short={event.home.shortName} align="right" />
        <div className="text-center">
          {started && live.score ? (
            <p
              className="tabular text-4xl font-semibold tracking-tight sm:text-5xl"
              data-testid="score"
            >
              {live.score.home}
              <span className="px-2 text-fg-subtle">:</span>
              {live.score.away}
            </p>
          ) : (
            <p className="text-sm font-medium text-fg-muted">{formatKickoff(event.startTime)}</p>
          )}
          <p className={cn('mt-1 text-xs', live.isLive ? 'text-live' : 'text-fg-subtle')}>
            {live.isLive
              ? [
                  PERIOD_LABELS[live.liveState?.period ?? ''] ?? live.liveState?.period,
                  live.liveState?.clock,
                ]
                  .filter(Boolean)
                  .join(' · ')
              : started
                ? EVENT_STATUS_LABELS[live.status]
                : formatDateTime(event.startTime)}
          </p>
        </div>
        <TeamName name={event.away.name} short={event.away.shortName} align="left" />
      </div>
      {stats ? (
        <StatisticsPanel stats={stats} home={event.home.shortName} away={event.away.shortName} />
      ) : null}
    </Card>
  );
}

function TeamName({
  name,
  short,
  align,
}: {
  name: string;
  short: string;
  align: 'left' | 'right';
}) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-2',
        align === 'right' ? 'items-end text-right' : 'items-start text-left',
      )}
    >
      <span className="grid size-11 place-items-center rounded-full border border-border-strong bg-surface-3 text-xs font-bold tracking-wider text-fg-muted">
        {short}
      </span>
      <span className="line-clamp-2 text-sm font-semibold sm:text-base">{name}</span>
    </div>
  );
}

function StatBar({
  label,
  value,
  percent = false,
}: {
  label: string;
  value: Pair;
  percent?: boolean;
}) {
  const total = value.home + value.away || 1;
  const homeShare = (value.home / total) * 100;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="tabular font-semibold">
          {value.home}
          {percent ? '%' : ''}
        </span>
        <span className="text-fg-muted">{label}</span>
        <span className="tabular font-semibold">
          {value.away}
          {percent ? '%' : ''}
        </span>
      </div>
      <div className="flex h-1.5 gap-1 overflow-hidden rounded-full">
        <div className="rounded-full bg-accent" style={{ width: `${homeShare}%` }} />
        <div className="flex-1 rounded-full bg-border-strong" />
      </div>
    </div>
  );
}

function StatisticsPanel({
  stats,
  home,
  away,
}: {
  stats: EventStatistics;
  home: string;
  away: string;
}) {
  if (stats.sport === 'football') {
    return (
      <div className="grid gap-5 border-t border-border px-4 py-4 md:grid-cols-2">
        <div className="space-y-3">
          <StatBar label="Ballbesitz" value={stats.possession} percent />
          <StatBar label="Schüsse aufs Tor" value={stats.shotsOnTarget} />
          <StatBar label="Ecken" value={stats.corners} />
          <StatBar
            label="Karten (Gelb/Rot)"
            value={{
              home: stats.yellowCards.home + stats.redCards.home,
              away: stats.yellowCards.away + stats.redCards.away,
            }}
          />
        </div>
        <div>
          <p className="mb-2 text-xs font-medium text-fg-muted">Tore</p>
          {stats.goalEvents.length === 0 ? (
            <p className="text-xs text-fg-subtle">Noch keine Tore.</p>
          ) : (
            <ol className="space-y-1.5 text-sm">
              {stats.goalEvents.map((g, i) => (
                <li
                  key={i}
                  className={cn(
                    'flex items-center gap-2',
                    g.side === 'AWAY' && 'flex-row-reverse text-right',
                  )}
                >
                  <span className="tabular w-9 text-xs text-fg-subtle">{g.minute}&apos;</span>
                  <span className="truncate">
                    {g.playerName ?? (g.side === 'HOME' ? home : away)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    );
  }
  if (stats.sport === 'tennis') {
    return (
      <div className="overflow-x-auto border-t border-border px-4 py-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-fg-subtle">
              <th className="py-1 text-left font-medium">Spieler</th>
              {stats.sets.map((_, i) => (
                <th key={i} className="w-10 py-1 text-center font-medium">
                  S{i + 1}
                </th>
              ))}
              <th className="w-14 py-1 text-center font-medium">Punkte</th>
            </tr>
          </thead>
          <tbody>
            {(['home', 'away'] as const).map((side) => (
              <tr key={side} className="border-t border-border/60">
                <td className="py-1.5 font-medium">
                  {side === 'home' ? home : away}
                  {stats.server === (side === 'home' ? 'HOME' : 'AWAY') ? (
                    <span
                      className="ml-1.5 inline-block size-1.5 rounded-full bg-warning"
                      title="Aufschlag"
                    />
                  ) : null}
                </td>
                {stats.sets.map((set, i) => (
                  <td key={i} className="tabular py-1.5 text-center">
                    {set[side]}
                  </td>
                ))}
                <td className="tabular py-1.5 text-center font-semibold text-accent-strong">
                  {stats.currentGame?.[side] ?? '–'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <div className="overflow-x-auto border-t border-border px-4 py-4">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-fg-subtle">
            <th className="py-1 text-left font-medium">Team</th>
            {stats.periods.map((_, i) => (
              <th key={i} className="w-10 py-1 text-center font-medium">
                {i < 4 ? `Q${i + 1}` : 'OT'}
              </th>
            ))}
            <th className="w-12 py-1 text-center font-medium">Fouls</th>
          </tr>
        </thead>
        <tbody>
          {(['home', 'away'] as const).map((side) => (
            <tr key={side} className="border-t border-border/60">
              <td className="py-1.5 font-medium">{side === 'home' ? home : away}</td>
              {stats.periods.map((p, i) => (
                <td key={i} className="tabular py-1.5 text-center">
                  {p[side]}
                </td>
              ))}
              <td className="tabular py-1.5 text-center text-fg-muted">{stats.fouls[side]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
