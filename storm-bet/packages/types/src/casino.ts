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
  motif: 'bolt' | 'gem' | 'crown' | 'star' | 'wave' | 'moon' | 'wheel' | 'cards' | 'chip';
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

export type CasinoRoundResult = SlotResult | RouletteResult | BlackjackResult | BaccaratResult;

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
