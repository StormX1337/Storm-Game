import type {
  CasinoGameStatus,
  CasinoGameType,
  CasinoRoundStatus,
  CasinoSessionStatus,
} from './enums';

/** Casino DTOs. Every amount is play money in minor units (100 = 1.00 DEMO). */

export interface CasinoTheme {
  /** Two gradient stops and an accent, as CSS colours. */
  from: string;
  to: string;
  accent: string;
  /** Motif drawn on the cover. */
  motif:
    | 'bolt'
    | 'gem'
    | 'crown'
    | 'star'
    | 'wave'
    | 'moon'
    | 'wheel'
    | 'cards'
    | 'chip'
    | 'rocket'
    | 'bomb'
    | 'pegs'
    | 'dice'
    | 'balls'
    | 'arrows'
    | 'spades';
}

export interface CasinoCategoryDto {
  key: string;
  name: string;
  gameCount: number;
}

export interface CasinoGameDto {
  id: string;
  slug: string;
  name: string;
  type: CasinoGameType;
  categories: string[];
  description: string;
  provider: { key: string; name: string; isSimulated: boolean };
  status: CasinoGameStatus;
  isFeatured: boolean;
  isNew: boolean;
  minStake: number;
  maxStake: number;
  rtp: number;
  theme: CasinoTheme;
  isFavorite: boolean;
}

export interface CasinoLobbyDto {
  categories: CasinoCategoryDto[];
  games: CasinoGameDto[];
  /** Game ids by rounds played in the last 7 days (most played first). */
  popular: string[];
}

export interface CasinoSessionDto {
  id: string;
  gameId: string;
  status: CasinoSessionStatus;
  createdAt: string;
  /** How the game is launched: in-page for the built-in games. */
  launch: { kind: 'internal' } | { kind: 'iframe'; url: string };
  /** An unfinished blackjack hand of this session, to continue. */
  openRound: CasinoRoundDto | null;
}

/** Row index per reel for each of the 10 slot paylines (0 = top row). */
export const SLOT_PAYLINES: readonly (readonly number[])[] = [
  [1, 1, 1, 1, 1],
  [0, 0, 0, 0, 0],
  [2, 2, 2, 2, 2],
  [0, 1, 2, 1, 0],
  [2, 1, 0, 1, 2],
  [0, 0, 1, 2, 2],
  [2, 2, 1, 0, 0],
  [1, 0, 0, 0, 1],
  [1, 2, 2, 2, 1],
  [1, 0, 1, 2, 1],
];

export type SlotSymbol = 'bolt' | 'crown' | 'gem' | 'star' | 'clover' | 'cherry' | 'lemon';

export interface SlotResult {
  game: 'SLOT';
  /** reels[reel][row], 5 reels × 3 rows. */
  reels: SlotSymbol[][];
  wins: { line: number; symbol: SlotSymbol; count: number; multiplier: number }[];
}

export type RouletteBetType =
  | 'straight'
  | 'red'
  | 'black'
  | 'odd'
  | 'even'
  | 'low'
  | 'high'
  | 'dozen'
  | 'column';

export interface RouletteBet {
  type: RouletteBetType;
  /** Number for straight (0–36), 1–3 for dozen/column. */
  value?: number;
  stake: number;
}

export interface RouletteResult {
  game: 'ROULETTE';
  number: number;
  color: 'red' | 'black' | 'green';
  bets: (RouletteBet & { payout: number })[];
}

export interface Card {
  rank: 'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K';
  suit: 'S' | 'H' | 'D' | 'C';
}

export interface BlackjackResult {
  game: 'BLACKJACK';
  player: Card[];
  /** The dealer's hole card stays hidden (null) until the hand is over. */
  dealer: (Card | null)[];
  playerTotal: number;
  dealerTotal: number | null;
  doubled: boolean;
  /** Present once the hand is over. */
  outcome: 'blackjack' | 'win' | 'push' | 'lose' | 'bust' | null;
  actions: ('hit' | 'stand' | 'double')[];
}

export type BaccaratSide = 'player' | 'banker' | 'tie';

export interface BaccaratResult {
  game: 'BACCARAT';
  player: Card[];
  banker: Card[];
  playerTotal: number;
  bankerTotal: number;
  winner: BaccaratSide;
  bets: { side: BaccaratSide; stake: number; payout: number }[];
}

export interface CrashResult {
  game: 'CRASH';
  /** The cash-out multiplier the player set before the round. */
  target: number;
  crashPoint: number;
  won: boolean;
}

export type PlinkoRisk = 'low' | 'medium' | 'high';

export interface PlinkoResult {
  game: 'PLINKO';
  risk: PlinkoRisk;
  /** The ball's way down, one step per row. */
  path: ('L' | 'R')[];
  bucket: number;
  multiplier: number;
}

export interface MinesResult {
  game: 'MINES';
  mines: number;
  revealed: number[];
  /** Cash-out multiplier now. */
  multiplier: number;
  /** After one more safe tile (null when none is left). */
  nextMultiplier: number | null;
  /** Present once the round is over. */
  outcome: 'cashout' | 'mine' | null;
  /** The mine that was hit. */
  hit: number | null;
  /** All mines, shown once the round is over. */
  minePositions: number[] | null;
}

export interface DiceResult {
  game: 'DICE';
  /** 0.00–99.99 */
  roll: number;
  /** Win chance in percent. */
  chance: number;
  direction: 'under' | 'over';
  /** "under": wins below it; "over": wins at or above it. */
  threshold: number;
  multiplier: number;
  won: boolean;
}

export interface KenoResult {
  game: 'KENO';
  picks: number[];
  /** The ten numbers drawn, in drawing order. */
  drawn: number[];
  hits: number[];
  multiplier: number;
}

export interface WheelResult {
  game: 'WHEEL';
  segment: number;
  multiplier: number;
}

export type HiloGuess = 'higher' | 'lower';

export interface HiloResult {
  game: 'HILO';
  current: Card;
  history: { card: Card; guess: HiloGuess | null; won: boolean | null }[];
  multiplier: number;
  /** Chance and cash-out multiplier after a won guess (null: the guess cannot lose). */
  higher: { chance: number; multiplier: number | null };
  lower: { chance: number; multiplier: number | null };
  outcome: 'cashout' | 'lost' | null;
}

export type VideoPokerHand =
  | 'royal_flush'
  | 'straight_flush'
  | 'four_of_a_kind'
  | 'full_house'
  | 'flush'
  | 'straight'
  | 'three_of_a_kind'
  | 'two_pair'
  | 'jacks_or_better'
  | 'nothing';

export interface VideoPokerResult {
  game: 'VIDEO_POKER';
  hand: Card[];
  /** Positions kept at the draw (null before it). */
  held: number[] | null;
  handName: VideoPokerHand;
  /** Return per unit, once the hand is final. */
  multiplier: number | null;
  final: boolean;
}

export type CasinoRoundResult =
  | SlotResult
  | RouletteResult
  | BlackjackResult
  | BaccaratResult
  | CrashResult
  | PlinkoResult
  | MinesResult
  | DiceResult
  | KenoResult
  | WheelResult
  | HiloResult
  | VideoPokerResult;

export interface CasinoRoundDto {
  id: string;
  gameId: string;
  gameName: string;
  status: CasinoRoundStatus;
  stake: number;
  payout: number;
  /** Next action number for multi-step games (blackjack). */
  step: number;
  result: CasinoRoundResult;
  createdAt: string;
  settledAt: string | null;
}

export interface CasinoPlayResponse {
  round: CasinoRoundDto;
  balance: { balance: number; available: number };
  replayed: boolean;
}

export interface AdminCasinoGameDto extends Omit<CasinoGameDto, 'isFavorite'> {
  sortOrder: number;
  roundsLast7d: number;
}

export interface AdminCasinoSessionDto {
  id: string;
  user: { id: string; email: string };
  game: { id: string; name: string };
  status: CasinoSessionStatus;
  createdAt: string;
  lastActivityAt: string;
  closedAt: string | null;
  closedReason: string | null;
  rounds: number;
}

export interface AdminCasinoRoundDto extends CasinoRoundDto {
  user: { id: string; email: string };
  sessionId: string;
}
