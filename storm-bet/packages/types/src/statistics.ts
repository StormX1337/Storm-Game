/** Home/away pair used by every per-team figure. */
export interface Pair {
  home: number;
  away: number;
}

export type Side = 'HOME' | 'AWAY';

export interface GoalEvent {
  minute: number;
  side: Side;
  /** Internal player id once synced; the provider's own id never leaves the sync layer. */
  playerId: string | null;
  playerName: string | null;
}

/** One player's official figures, as far as the feed reports them. */
export interface PlayerStatLine {
  /** Internal player id once synced; the provider's own id never leaves the sync layer. */
  playerId: string;
  name: string | null;
  /** Keys are PlayerStat values (goals, points, rebounds, assists). */
  stats: Partial<Record<'goals' | 'points' | 'rebounds' | 'assists', number>>;
}

/**
 * Detailed figures are optional: a feed that only reports the score leaves
 * them out rather than claiming zero. Markets that need a missing figure are
 * never priced from that feed and cannot be settled automatically.
 */
export interface FootballStatistics {
  sport: 'football';
  goals: Pair;
  corners?: Pair;
  yellowCards?: Pair;
  redCards?: Pair;
  shotsOnTarget?: Pair;
  /** Percentages, summing to 100. */
  possession?: Pair;
  goalEvents?: GoalEvent[];
  /** Score of the first half. */
  firstHalf?: Pair;
  /** Goals of the second half (regular time only). */
  secondHalf?: Pair;
  /**
   * Players with an official stat line. A player missing from a recorded list
   * did not play; an absent list means player figures were not recorded.
   */
  players?: PlayerStatLine[];
}

export interface TennisStatistics {
  sport: 'tennis';
  /** Games per set, completed sets first, the set in progress last. */
  sets: Pair[];
  setsWon: Pair;
  /** Points in the game in progress ("0", "15", "30", "40", "AD"). */
  currentGame: { home: string; away: string } | null;
  server: Side | null;
  aces?: Pair;
}

export interface BasketballStatistics {
  sport: 'basketball';
  points: Pair;
  /** Points per quarter (overtime periods appended); empty when the feed only reports totals. */
  periods: Pair[];
  fouls?: Pair;
  /** Score after two quarters, when the feed reports it without quarter scores. */
  firstHalf?: Pair;
  /** See FootballStatistics.players. */
  players?: PlayerStatLine[];
}

export type EventStatistics = FootballStatistics | TennisStatistics | BasketballStatistics;

export interface LiveState {
  /** PRE, 1H, HT, 2H, FT · Q1–Q4, OT · S1–S3 */
  period: string;
  /** Display clock: "67'" or "07:32". Null before kick-off and after the final whistle. */
  clock: string | null;
}

export const PERIOD_LABELS: Record<string, string> = {
  PRE: 'Vor dem Spiel',
  '1H': '1. Halbzeit',
  HT: 'Halbzeit',
  '2H': '2. Halbzeit',
  FT: 'Beendet',
  LIVE: 'Läuft',
  Q1: '1. Viertel',
  Q2: '2. Viertel',
  Q3: '3. Viertel',
  Q4: '4. Viertel',
  OT: 'Verlängerung',
  S1: '1. Satz',
  S2: '2. Satz',
  S3: '3. Satz',
};
