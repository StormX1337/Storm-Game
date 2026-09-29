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

export interface FootballStatistics {
  sport: 'football';
  goals: Pair;
  corners: Pair;
  yellowCards: Pair;
  redCards: Pair;
  shotsOnTarget: Pair;
  /** Percentages, summing to 100. */
  possession: Pair;
  goalEvents: GoalEvent[];
}

export interface TennisStatistics {
  sport: 'tennis';
  /** Games per set, completed sets first, the set in progress last. */
  sets: Pair[];
  setsWon: Pair;
  /** Points in the game in progress ("0", "15", "30", "40", "AD"). */
  currentGame: { home: string; away: string } | null;
  server: Side | null;
  aces: Pair;
}

export interface BasketballStatistics {
  sport: 'basketball';
  points: Pair;
  /** Points per quarter (overtime periods appended). */
  periods: Pair[];
  fouls: Pair;
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
  Q1: '1. Viertel',
  Q2: '2. Viertel',
  Q3: '3. Viertel',
  Q4: '4. Viertel',
  OT: 'Verlängerung',
  S1: '1. Satz',
  S2: '2. Satz',
  S3: '3. Satz',
};
