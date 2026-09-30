import { SportKey } from './enums';

/**
 * Market catalogue. A market type fixes which outcomes exist, which result
 * metric settles it and whether it carries a line (2.5, -1.5 …). Settlement,
 * the mock pricing models and the UI all read this one table, so a market can
 * never be priced one way and settled another.
 */
export const MarketType = {
  MATCH_RESULT: 'MATCH_RESULT',
  DOUBLE_CHANCE: 'DOUBLE_CHANCE',
  DRAW_NO_BET: 'DRAW_NO_BET',
  TOTAL_GOALS: 'TOTAL_GOALS',
  ASIAN_HANDICAP: 'ASIAN_HANDICAP',
  BOTH_TEAMS_TO_SCORE: 'BOTH_TEAMS_TO_SCORE',
  TOTAL_CORNERS: 'TOTAL_CORNERS',
  TOTAL_CARDS: 'TOTAL_CARDS',
  PLAYER_TO_SCORE: 'PLAYER_TO_SCORE',
  MATCH_WINNER: 'MATCH_WINNER',
  FIRST_SET_WINNER: 'FIRST_SET_WINNER',
  SET_BETTING: 'SET_BETTING',
  TOTAL_GAMES: 'TOTAL_GAMES',
  GAME_HANDICAP: 'GAME_HANDICAP',
  TOTAL_POINTS: 'TOTAL_POINTS',
  POINT_SPREAD: 'POINT_SPREAD',
  HALF_TIME_RESULT: 'HALF_TIME_RESULT',
  FIRST_HALF_HANDICAP: 'FIRST_HALF_HANDICAP',
  FIRST_HALF_TOTAL_GOALS: 'FIRST_HALF_TOTAL_GOALS',
  SECOND_HALF_RESULT: 'SECOND_HALF_RESULT',
  SECOND_HALF_TOTAL_GOALS: 'SECOND_HALF_TOTAL_GOALS',
  FIRST_HALF_WINNER: 'FIRST_HALF_WINNER',
  FIRST_HALF_SPREAD: 'FIRST_HALF_SPREAD',
  FIRST_HALF_TOTAL_POINTS: 'FIRST_HALF_TOTAL_POINTS',
  PLAYER_POINTS: 'PLAYER_POINTS',
  PLAYER_REBOUNDS: 'PLAYER_REBOUNDS',
  PLAYER_ASSISTS: 'PLAYER_ASSISTS',
} as const;
export type MarketType = (typeof MarketType)[keyof typeof MarketType];
export const MARKET_TYPES = Object.values(MarketType) as [MarketType, ...MarketType[]];

export const Outcome = {
  HOME: 'HOME',
  DRAW: 'DRAW',
  AWAY: 'AWAY',
  HOME_OR_DRAW: 'HOME_OR_DRAW',
  HOME_OR_AWAY: 'HOME_OR_AWAY',
  DRAW_OR_AWAY: 'DRAW_OR_AWAY',
  OVER: 'OVER',
  UNDER: 'UNDER',
  YES: 'YES',
  NO: 'NO',
  SETS_2_0: 'SETS_2_0',
  SETS_2_1: 'SETS_2_1',
  SETS_1_2: 'SETS_1_2',
  SETS_0_2: 'SETS_0_2',
  /** Player markets: one selection per player, identified by playerId. */
  PLAYER: 'PLAYER',
} as const;
export type Outcome = (typeof Outcome)[keyof typeof Outcome];
export const OUTCOMES = Object.values(Outcome) as [Outcome, ...Outcome[]];

/**
 * Result figure a market is decided on. `score` is the sport's own scoreline:
 * goals in football, sets in tennis, points in basketball.
 */
export type ResultMetric = 'score' | 'corners' | 'cards' | 'games';

/**
 * Part of the game a market is decided on. Football halves are regular time
 * (the second half never includes extra time); a basketball first half is
 * quarters one and two.
 */
export type MarketPeriod = 'FULL' | 'H1' | 'H2';

/** Per-player figure a player over/under market is decided on. */
export type PlayerStat = 'goals' | 'points' | 'rebounds' | 'assists';

export type SettlementKind =
  | 'THREE_WAY'
  | 'DOUBLE_CHANCE'
  | 'DRAW_NO_BET'
  | 'TWO_WAY'
  | 'TOTAL'
  | 'HANDICAP'
  | 'BOTH_SCORE'
  | 'PLAYER_SCORES'
  | 'FIRST_SET'
  | 'SET_SCORE'
  /** One market per player and line; OVER/UNDER on that player's figure. */
  | 'PLAYER_TOTAL';

export interface MarketDefinition {
  type: MarketType;
  label: string;
  sports: readonly SportKey[];
  metric: ResultMetric;
  period: MarketPeriod;
  /** For PLAYER_TOTAL: the player figure it settles on. */
  playerStat?: PlayerStat;
  kind: SettlementKind;
  hasLine: boolean;
  outcomes: readonly Outcome[];
  /** Lower numbers render first. */
  sortOrder: number;
}

const FOOTBALL = [SportKey.FOOTBALL] as const;
const TENNIS = [SportKey.TENNIS] as const;
const BASKETBALL = [SportKey.BASKETBALL] as const;

const half = (
  type: MarketType,
  label: string,
  sports: readonly SportKey[],
  period: 'H1' | 'H2',
  kind: 'THREE_WAY' | 'TWO_WAY' | 'TOTAL' | 'HANDICAP',
  sortOrder: number,
): MarketDefinition => ({
  type,
  label,
  sports,
  metric: 'score',
  period,
  kind,
  hasLine: kind === 'TOTAL' || kind === 'HANDICAP',
  outcomes:
    kind === 'THREE_WAY'
      ? ['HOME', 'DRAW', 'AWAY']
      : kind === 'TOTAL'
        ? ['OVER', 'UNDER']
        : ['HOME', 'AWAY'],
  sortOrder,
});

const playerTotal = (
  type: MarketType,
  label: string,
  playerStat: PlayerStat,
  sortOrder: number,
): MarketDefinition => ({
  type,
  label,
  sports: BASKETBALL,
  metric: 'score',
  period: 'FULL',
  playerStat,
  kind: 'PLAYER_TOTAL',
  hasLine: true,
  outcomes: ['OVER', 'UNDER'],
  sortOrder,
});

export const MARKET_DEFINITIONS: Record<MarketType, MarketDefinition> = {
  MATCH_RESULT: {
    type: 'MATCH_RESULT',
    label: 'Ergebnis (1X2)',
    sports: FOOTBALL,
    metric: 'score',
    period: 'FULL',
    kind: 'THREE_WAY',
    hasLine: false,
    outcomes: ['HOME', 'DRAW', 'AWAY'],
    sortOrder: 10,
  },
  DOUBLE_CHANCE: {
    type: 'DOUBLE_CHANCE',
    label: 'Doppelte Chance',
    sports: FOOTBALL,
    metric: 'score',
    period: 'FULL',
    kind: 'DOUBLE_CHANCE',
    hasLine: false,
    outcomes: ['HOME_OR_DRAW', 'HOME_OR_AWAY', 'DRAW_OR_AWAY'],
    sortOrder: 20,
  },
  DRAW_NO_BET: {
    type: 'DRAW_NO_BET',
    label: 'Unentschieden, keine Wette',
    sports: FOOTBALL,
    metric: 'score',
    period: 'FULL',
    kind: 'DRAW_NO_BET',
    hasLine: false,
    outcomes: ['HOME', 'AWAY'],
    sortOrder: 30,
  },
  TOTAL_GOALS: {
    type: 'TOTAL_GOALS',
    label: 'Tore Über/Unter',
    sports: FOOTBALL,
    metric: 'score',
    period: 'FULL',
    kind: 'TOTAL',
    hasLine: true,
    outcomes: ['OVER', 'UNDER'],
    sortOrder: 40,
  },
  ASIAN_HANDICAP: {
    type: 'ASIAN_HANDICAP',
    label: 'Asiatisches Handicap',
    sports: FOOTBALL,
    metric: 'score',
    period: 'FULL',
    kind: 'HANDICAP',
    hasLine: true,
    outcomes: ['HOME', 'AWAY'],
    sortOrder: 50,
  },
  BOTH_TEAMS_TO_SCORE: {
    type: 'BOTH_TEAMS_TO_SCORE',
    label: 'Beide Teams treffen',
    sports: FOOTBALL,
    metric: 'score',
    period: 'FULL',
    kind: 'BOTH_SCORE',
    hasLine: false,
    outcomes: ['YES', 'NO'],
    sortOrder: 60,
  },
  TOTAL_CORNERS: {
    type: 'TOTAL_CORNERS',
    label: 'Ecken Über/Unter',
    sports: FOOTBALL,
    metric: 'corners',
    period: 'FULL',
    kind: 'TOTAL',
    hasLine: true,
    outcomes: ['OVER', 'UNDER'],
    sortOrder: 70,
  },
  TOTAL_CARDS: {
    type: 'TOTAL_CARDS',
    label: 'Karten Über/Unter',
    sports: FOOTBALL,
    metric: 'cards',
    period: 'FULL',
    kind: 'TOTAL',
    hasLine: true,
    outcomes: ['OVER', 'UNDER'],
    sortOrder: 80,
  },
  PLAYER_TO_SCORE: {
    type: 'PLAYER_TO_SCORE',
    label: 'Torschütze (jederzeit)',
    sports: FOOTBALL,
    metric: 'score',
    period: 'FULL',
    kind: 'PLAYER_SCORES',
    hasLine: false,
    outcomes: ['PLAYER'],
    sortOrder: 90,
  },
  MATCH_WINNER: {
    type: 'MATCH_WINNER',
    label: 'Sieger',
    sports: [SportKey.TENNIS, SportKey.BASKETBALL],
    metric: 'score',
    period: 'FULL',
    kind: 'TWO_WAY',
    hasLine: false,
    outcomes: ['HOME', 'AWAY'],
    sortOrder: 10,
  },
  FIRST_SET_WINNER: {
    type: 'FIRST_SET_WINNER',
    label: 'Gewinner 1. Satz',
    sports: TENNIS,
    metric: 'score',
    period: 'FULL',
    kind: 'FIRST_SET',
    hasLine: false,
    outcomes: ['HOME', 'AWAY'],
    sortOrder: 20,
  },
  SET_BETTING: {
    type: 'SET_BETTING',
    label: 'Satzergebnis',
    sports: TENNIS,
    metric: 'score',
    period: 'FULL',
    kind: 'SET_SCORE',
    hasLine: false,
    outcomes: ['SETS_2_0', 'SETS_2_1', 'SETS_1_2', 'SETS_0_2'],
    sortOrder: 30,
  },
  TOTAL_GAMES: {
    type: 'TOTAL_GAMES',
    label: 'Spiele Über/Unter',
    sports: TENNIS,
    metric: 'games',
    period: 'FULL',
    kind: 'TOTAL',
    hasLine: true,
    outcomes: ['OVER', 'UNDER'],
    sortOrder: 40,
  },
  GAME_HANDICAP: {
    type: 'GAME_HANDICAP',
    label: 'Spiele-Handicap',
    sports: TENNIS,
    metric: 'games',
    period: 'FULL',
    kind: 'HANDICAP',
    hasLine: true,
    outcomes: ['HOME', 'AWAY'],
    sortOrder: 50,
  },
  TOTAL_POINTS: {
    type: 'TOTAL_POINTS',
    label: 'Punkte Über/Unter',
    sports: BASKETBALL,
    metric: 'score',
    period: 'FULL',
    kind: 'TOTAL',
    hasLine: true,
    outcomes: ['OVER', 'UNDER'],
    sortOrder: 30,
  },
  POINT_SPREAD: {
    type: 'POINT_SPREAD',
    label: 'Handicap (Punkte)',
    sports: BASKETBALL,
    metric: 'score',
    period: 'FULL',
    kind: 'HANDICAP',
    hasLine: true,
    outcomes: ['HOME', 'AWAY'],
    sortOrder: 20,
  },

  HALF_TIME_RESULT: half(
    'HALF_TIME_RESULT',
    '1. Halbzeit – Ergebnis',
    FOOTBALL,
    'H1',
    'THREE_WAY',
    100,
  ),
  FIRST_HALF_HANDICAP: half(
    'FIRST_HALF_HANDICAP',
    '1. Halbzeit – Handicap',
    FOOTBALL,
    'H1',
    'HANDICAP',
    110,
  ),
  FIRST_HALF_TOTAL_GOALS: half(
    'FIRST_HALF_TOTAL_GOALS',
    '1. Halbzeit – Tore Über/Unter',
    FOOTBALL,
    'H1',
    'TOTAL',
    120,
  ),
  SECOND_HALF_RESULT: half(
    'SECOND_HALF_RESULT',
    '2. Halbzeit – Ergebnis',
    FOOTBALL,
    'H2',
    'THREE_WAY',
    130,
  ),
  SECOND_HALF_TOTAL_GOALS: half(
    'SECOND_HALF_TOTAL_GOALS',
    '2. Halbzeit – Tore Über/Unter',
    FOOTBALL,
    'H2',
    'TOTAL',
    140,
  ),
  FIRST_HALF_WINNER: half(
    'FIRST_HALF_WINNER',
    '1. Halbzeit – Sieger',
    BASKETBALL,
    'H1',
    'TWO_WAY',
    100,
  ),
  FIRST_HALF_SPREAD: half(
    'FIRST_HALF_SPREAD',
    '1. Halbzeit – Handicap',
    BASKETBALL,
    'H1',
    'HANDICAP',
    110,
  ),
  FIRST_HALF_TOTAL_POINTS: half(
    'FIRST_HALF_TOTAL_POINTS',
    '1. Halbzeit – Punkte Über/Unter',
    BASKETBALL,
    'H1',
    'TOTAL',
    120,
  ),
  PLAYER_POINTS: playerTotal('PLAYER_POINTS', 'Spieler – Punkte Über/Unter', 'points', 200),
  PLAYER_REBOUNDS: playerTotal('PLAYER_REBOUNDS', 'Spieler – Rebounds Über/Unter', 'rebounds', 210),
  PLAYER_ASSISTS: playerTotal('PLAYER_ASSISTS', 'Spieler – Assists Über/Unter', 'assists', 220),
};

export function getMarketDefinition(type: MarketType): MarketDefinition {
  return MARKET_DEFINITIONS[type];
}

/**
 * Stable key of a market within its event. A type can appear more than once
 * with different lines (Over/Under 1.5, 2.5, 3.5), so the line is part of it.
 */
export function marketKey(type: MarketType, line: number | null | undefined): string {
  return line == null ? type : `${type}:${line}`;
}

/** `2.5` for totals, `+1.5` / `-1.5` / `0` for handicaps. */
export function formatLine(line: number, signed = false): string {
  const text = Number.isInteger(line) ? line.toFixed(1) : String(line);
  if (!signed || line === 0) return line === 0 ? '0' : text;
  return line > 0 ? `+${text}` : text;
}

/**
 * Handicap and total lines must be whole or half numbers. Quarter lines split
 * the stake into two bets, which this engine does not model — they are
 * rejected at the edge instead of being settled wrongly.
 */
export function isSupportedLine(line: number): boolean {
  return Number.isFinite(line) && Math.abs(line) <= 500 && Number.isInteger(line * 2);
}

export const OUTCOME_LABELS: Record<Outcome, string> = {
  HOME: '1',
  DRAW: 'X',
  AWAY: '2',
  HOME_OR_DRAW: '1X',
  HOME_OR_AWAY: '12',
  DRAW_OR_AWAY: 'X2',
  OVER: 'Über',
  UNDER: 'Unter',
  YES: 'Ja',
  NO: 'Nein',
  SETS_2_0: '2:0',
  SETS_2_1: '2:1',
  SETS_1_2: '1:2',
  SETS_0_2: '0:2',
  PLAYER: 'Spieler',
};

/** Football markets that can be combined in a Bet Builder before kick-off. */
export const BUILDER_MARKETS: readonly MarketType[] = [
  'MATCH_RESULT',
  'DOUBLE_CHANCE',
  'DRAW_NO_BET',
  'TOTAL_GOALS',
  'ASIAN_HANDICAP',
  'BOTH_TEAMS_TO_SCORE',
  'HALF_TIME_RESULT',
  'FIRST_HALF_HANDICAP',
  'FIRST_HALF_TOTAL_GOALS',
  'SECOND_HALF_RESULT',
  'SECOND_HALF_TOTAL_GOALS',
  'PLAYER_TO_SCORE',
  'TOTAL_CORNERS',
  'TOTAL_CARDS',
];

/** In play only full-time score markets can be combined. */
export const LIVE_BUILDER_MARKETS: readonly MarketType[] = [
  'MATCH_RESULT',
  'DOUBLE_CHANCE',
  'DRAW_NO_BET',
  'TOTAL_GOALS',
  'ASIAN_HANDICAP',
  'BOTH_TEAMS_TO_SCORE',
];
