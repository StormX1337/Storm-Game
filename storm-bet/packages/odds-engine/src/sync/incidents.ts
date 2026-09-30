import type {
  EventStatistics,
  EventStatus,
  IncidentKind,
  LiveState,
  Pair,
  Side,
} from '@storm-bet/types';

/** What the live ticker records for one change the feed reported. */
export interface DetectedIncident {
  /** Unique per event: a repeated or concurrent sync adds nothing twice. */
  key: string;
  kind: IncidentKind;
  side: Side | null;
  clock: string | null;
  period: string | null;
  playerName: string | null;
  score: Pair | null;
}

export interface IncidentSnapshot {
  status: EventStatus;
  score: Pair | null;
  liveState: LiveState | null;
  statistics: EventStatistics | null;
}

const SIDES: Side[] = ['HOME', 'AWAY'];
const side = (s: Side) => (s === 'HOME' ? 'home' : 'away');

/** Sports whose scores are goals worth a ticker line each. */
const GOAL_SPORTS = new Set(['football', 'hockey', 'handball']);

function counts(stats: EventStatistics | null) {
  if (stats?.sport !== 'football') return null;
  return {
    YELLOW_CARD: stats.yellowCards,
    RED_CARD: stats.redCards,
    CORNER: stats.corners,
  } as const;
}

/**
 * Ticker entries for the change from `prev` to `next`. Counts are compared
 * only against a known baseline — the previous snapshot of a running game, or
 * zero at kick-off — so a game first seen mid-way never floods the ticker
 * with past events at the wrong time.
 */
export function detectIncidents(
  sport: string,
  prev: IncidentSnapshot,
  next: IncidentSnapshot,
): DetectedIncident[] {
  const out: DetectedIncident[] = [];
  const clock = next.liveState?.clock ?? null;
  const period = next.liveState?.period ?? null;
  const add = (i: Omit<DetectedIncident, 'clock' | 'period'> & { clock?: string | null }) =>
    out.push({ clock, period, ...i });

  const started = prev.status === 'SCHEDULED' && next.status === 'LIVE';
  if (started)
    add({ key: 'kick-off', kind: 'KICK_OFF', side: null, playerName: null, score: null });

  const prevPeriod = prev.liveState?.period ?? null;
  if (period && prevPeriod && period !== prevPeriod && next.status !== 'FINISHED') {
    if (period === 'HT') {
      add({
        key: 'period:HT',
        kind: 'HALF_TIME',
        side: null,
        playerName: null,
        score: next.score,
        clock: null,
      });
    } else if (period !== 'FT' && period !== 'PRE') {
      add({
        key: `period:${period}`,
        kind: 'PERIOD_START',
        side: null,
        playerName: null,
        score: next.score,
        clock: null,
      });
    }
  }
  if (next.status === 'FINISHED' && prev.status !== 'FINISHED') {
    add({
      key: 'full-time',
      kind: 'FULL_TIME',
      side: null,
      playerName: null,
      score: next.score,
      clock: null,
    });
  }

  // A baseline: the running game's last snapshot, or 0:0 at kick-off.
  const live = prev.status === 'LIVE' || prev.status === 'SUSPENDED';
  if (!live && !started) return out;

  if (GOAL_SPORTS.has(sport) && next.score) {
    const before = prev.score ?? (started ? { home: 0, away: 0 } : null);
    if (before) {
      for (const s of SIDES) {
        const from = before[side(s)];
        const to = next.score[side(s)];
        for (let n = from + 1; n <= to; n += 1) {
          const scorer = goalScorer(prev.statistics, next.statistics, s, n, to - from);
          add({
            key: `goal:${s}:${n}`,
            kind: 'GOAL',
            side: s,
            playerName: scorer.name,
            score: next.score,
            clock: scorer.clock ?? clock,
          });
        }
        if (to < from) {
          add({
            key: `cancel:${s}:${from}`,
            kind: 'GOAL_CANCELLED',
            side: s,
            playerName: null,
            score: next.score,
          });
        }
      }
    }
  }

  const before = counts(prev.statistics);
  const after = counts(next.statistics);
  if (after) {
    for (const kind of ['RED_CARD', 'YELLOW_CARD', 'CORNER'] as const) {
      const to = after[kind];
      const from = before?.[kind] ?? (started ? { home: 0, away: 0 } : undefined);
      if (!to || !from) continue;
      for (const s of SIDES) {
        for (let n = from[side(s)] + 1; n <= to[side(s)]; n += 1) {
          add({
            key: `${kind.toLowerCase()}:${s}:${n}`,
            kind,
            side: s,
            playerName: null,
            score: null,
          });
        }
      }
    }
  }
  return out;
}

/**
 * The scorer of a side's n-th goal, when the feed tells: from its goal list
 * (with the minute), or — for a single new goal — the one player whose goal
 * count went up.
 */
function goalScorer(
  prev: EventStatistics | null,
  next: EventStatistics | null,
  s: Side,
  n: number,
  newGoals: number,
): { name: string | null; clock: string | null } {
  if (next?.sport !== 'football') return { name: null, clock: null };
  const listed = next.goalEvents?.filter((g) => g.side === s)[n - 1];
  if (listed) return { name: listed.playerName, clock: `${listed.minute}'` };
  if (newGoals !== 1 || !next.players || prev?.sport !== 'football') {
    return { name: null, clock: null };
  }
  const before = new Map((prev.players ?? []).map((p) => [p.playerId, p.stats.goals ?? 0]));
  const up = next.players.filter((p) => (p.stats.goals ?? 0) > (before.get(p.playerId) ?? 0));
  return { name: up.length === 1 ? (up[0]!.name ?? null) : null, clock: null };
}
