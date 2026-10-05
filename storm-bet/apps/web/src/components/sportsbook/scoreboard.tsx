'use client';

import type { EventDetailDto, EventStatistics, Pair, TeamStat } from '@storm-bet/types';
import { PERIOD_LABELS } from '@storm-bet/types';
import { Card, cn } from '@storm-bet/ui';
import { formatDateTime, formatKickoff } from '@/lib/format';
import { EVENT_STATUS_LABELS } from '@/lib/labels';
import { useLiveEvent } from './hooks';
import { DemoDataBadge, LiveBadge } from './live-indicator';
import { MatchField } from './match-field';
import { TeamBadge, teamHue } from './team-badge';
import { SportIcon } from './sport-icon';
import { useT } from '@/i18n/client';

export function Scoreboard({ event }: { event: EventDetailDto }) {
  const t = useT();
  const live = useLiveEvent(event);
  const stats = live.statistics ?? event.statistics;
  const started = live.score !== null;
  const firstHalf =
    stats?.sport === 'football' || stats?.sport === 'basketball' ? stats.firstHalf : undefined;
  const statusLine = [
    t(PERIOD_LABELS[live.liveState?.period ?? ''] ?? live.liveState?.period),
    live.liveState?.clock,
  ]
    .filter(Boolean)
    .join(' · ');
  const h1 = teamHue(event.home.name);
  const h2 = teamHue(event.away.name);
  return (
    <Card
      className="overflow-hidden"
      style={{
        backgroundImage: `radial-gradient(90% 120% at 0% 0%, hsl(${h1} 70% 50% / 0.10), transparent 60%), radial-gradient(90% 120% at 100% 0%, hsl(${h2} 70% 50% / 0.10), transparent 60%)`,
      }}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5 text-xs text-fg-muted">
        <SportIcon sport={event.sport.key} />
        <span>{t(event.sport.name)}</span>
        <span className="text-fg-subtle">/</span>
        <span className="truncate">{event.league.name}</span>
        <span className="ml-auto flex items-center gap-2">
          {event.dataSource.isSimulated ? <DemoDataBadge /> : null}
          {live.isLive ? <LiveBadge /> : <span>{t(EVENT_STATUS_LABELS[live.status])}</span>}
        </span>
      </div>
      {started &&
      live.score &&
      (event.sport.key === 'football' || event.sport.key === 'basketball') ? (
        <MatchField
          sport={event.sport.key}
          home={event.home.name}
          away={event.away.name}
          score={live.score}
          live={live.isLive}
          status={[
            live.isLive ? statusLine : t(EVENT_STATUS_LABELS[live.status]),
            firstHalf ? t('HZ {0}:{1}', [firstHalf.home, firstHalf.away]) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        />
      ) : (
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
              <p className="text-lg font-extrabold tracking-tight text-fg">
                {t(formatKickoff(event.startTime))}
              </p>
            )}
            <p className={cn('mt-1 text-xs', live.isLive ? 'text-live' : 'text-fg-subtle')}>
              {live.isLive
                ? [
                    t(PERIOD_LABELS[live.liveState?.period ?? ''] ?? live.liveState?.period),
                    live.liveState?.clock,
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : started
                  ? t(EVENT_STATUS_LABELS[live.status])
                  : formatDateTime(event.startTime)}
            </p>
            {firstHalf ? (
              <p className="tabular mt-0.5 text-xs text-fg-subtle">
                {t('Halbzeit')} {firstHalf.home}:{firstHalf.away}
              </p>
            ) : null}
          </div>
          <TeamName name={event.away.name} short={event.away.shortName} align="left" />
        </div>
      )}
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
      <TeamBadge name={name} short={short} className="size-12 text-xs sm:size-14 sm:text-sm" />
      <span className="line-clamp-2 text-sm font-bold tracking-tight sm:text-base">{name}</span>
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
  const t = useT();
  const total = value.home + value.away || 1;
  const homeShare = (value.home / total) * 100;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="tabular font-semibold">
          {value.home}
          {percent ? '%' : ''}
        </span>
        <span className="text-fg-muted">{t(label)}</span>
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
  const t = useT();
  if (stats.sport === 'football') {
    const cards =
      stats.yellowCards && stats.redCards
        ? {
            home: stats.yellowCards.home + stats.redCards.home,
            away: stats.yellowCards.away + stats.redCards.away,
          }
        : null;
    const bars: [string, Pair | null | undefined, boolean][] = [
      [t('Ballbesitz'), stats.possession, true],
      [t('Schüsse aufs Tor'), stats.shotsOnTarget, false],
      [t('Ecken'), stats.corners, false],
      [t('Karten (Gelb/Rot)'), cards, false],
    ];
    const available = [
      ...bars.filter((b): b is [string, Pair, boolean] => !!b[1]),
      ...extraBars(stats.teamStats),
    ];
    // A feed that reports only the score gets no statistics panel at all.
    if (available.length === 0 && !stats.goalEvents) return null;
    return (
      <div className="grid gap-5 border-t border-border px-4 py-4 md:grid-cols-2">
        {available.length > 0 ? (
          <div className="space-y-3">
            {available.map(([label, value, percent]) => (
              <StatBar key={label} label={label} value={value} percent={percent} />
            ))}
          </div>
        ) : null}
        {stats.goalEvents ? (
          <div>
            <p className="mb-2 text-xs font-medium text-fg-muted">{t('Tore')}</p>
            {stats.goalEvents.length === 0 ? (
              <p className="text-xs text-fg-subtle">{t('Noch keine Tore.')}</p>
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
        ) : null}
      </div>
    );
  }
  if (stats.sport === 'tennis') {
    if (stats.sets.length === 0) return null;
    return (
      <div className="overflow-x-auto border-t border-border px-4 py-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-fg-subtle">
              <th className="py-1 text-left font-medium">{t('Spieler')}</th>
              {stats.sets.map((_, i) => (
                <th key={i} className="w-10 py-1 text-center font-medium">
                  S{i + 1}
                </th>
              ))}
              <th className="w-14 py-1 text-center font-medium">{t('Punkte')}</th>
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
                      title={t('Aufschlag')}
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
  const extra = extraBars(stats.teamStats);
  if (stats.periods.length === 0 && extra.length === 0) return null;
  return (
    <div className="space-y-4 overflow-x-auto border-t border-border px-4 py-4">
      {stats.periods.length ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-fg-subtle">
              <th className="py-1 text-left font-medium">{t('Team')}</th>
              {stats.periods.map((_, i) => (
                <th key={i} className="w-10 py-1 text-center font-medium">
                  {periodLabel(stats.sport, i)}
                </th>
              ))}
              {stats.sport === 'basketball' ? (
                <th className="w-12 py-1 text-center font-medium">{t('Fouls')}</th>
              ) : null}
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
                {stats.sport === 'basketball' ? (
                  <td className="tabular py-1.5 text-center text-fg-muted">
                    {stats.fouls?.[side] ?? '–'}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {extra.length ? (
        <div className="space-y-3">
          {extra.map(([label, value, percent]) => (
            <StatBar key={label} label={label} value={value} percent={percent} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** German names of common feed stat ids; unknown ids are shown readable as they are. */
const STAT_LABELS: Record<string, string> = {
  shots: 'Schüsse',
  shots_onGoal: 'Schüsse aufs Tor',
  shotsOnGoal: 'Schüsse aufs Tor',
  shots_offGoal: 'Schüsse neben das Tor',
  shots_blocked: 'Geblockte Schüsse',
  fouls: 'Fouls',
  offsides: 'Abseits',
  saves: 'Paraden',
  passes: 'Pässe',
  passes_accurate: 'Angekommene Pässe',
  tackles: 'Tacklings',
  freeKicks: 'Freistöße',
  throwIns: 'Einwürfe',
  goalKicks: 'Abstöße',
  attacks: 'Angriffe',
  dangerousAttacks: 'Gefährliche Angriffe',
  rebounds: 'Rebounds',
  assists: 'Assists',
  steals: 'Steals',
  blocks: 'Blocks',
  turnovers: 'Ballverluste',
  fieldGoalsMade: 'Feldkörbe',
  fieldGoalsAttempted: 'Wurfversuche',
  threePointersMade: 'Dreier',
  threePointersAttempted: 'Dreierversuche',
  freeThrowsMade: 'Freiwürfe',
  freeThrowsAttempted: 'Freiwurfversuche',
  timeouts: 'Auszeiten',
};

function statLabel(key: string): string {
  return (
    STAT_LABELS[key] ??
    key
      .replace(/_/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/^./, (c) => c.toUpperCase())
  );
}

function extraBars(teamStats: TeamStat[] | undefined): [string, Pair, boolean][] {
  return (teamStats ?? []).map((s) => [
    statLabel(s.key),
    { home: s.home, away: s.away },
    /percent|possession|pct/i.test(s.key),
  ]);
}

/** Column heading of the i-th period of a sport. */
function periodLabel(sport: string, i: number): string {
  if (sport === 'hockey') return i < 3 ? `${i + 1}.` : 'OT';
  if (sport === 'baseball') return String(i + 1);
  if (sport === 'handball') return `HZ${i + 1}`;
  return i < 4 ? `Q${i + 1}` : 'OT';
}
