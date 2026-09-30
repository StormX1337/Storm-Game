/**
 * Domain enums shared by every layer. They mirror the Prisma enums one to one
 * (a test in @storm-bet/database fails if they drift), but live here so the
 * browser bundle never has to import the Prisma client to know a status name.
 */

function values<T extends Record<string, string>>(obj: T): [T[keyof T], ...T[keyof T][]] {
  return Object.values(obj) as [T[keyof T], ...T[keyof T][]];
}

export const UserRole = {
  USER: 'USER',
  SUPPORT: 'SUPPORT',
  TRADER: 'TRADER',
  ADMIN: 'ADMIN',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];
export const USER_ROLES = values(UserRole);

export const UserStatus = {
  ACTIVE: 'ACTIVE',
  LOCKED: 'LOCKED',
  CLOSED: 'CLOSED',
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];
export const USER_STATUSES = values(UserStatus);

export const EventStatus = {
  SCHEDULED: 'SCHEDULED',
  LIVE: 'LIVE',
  SUSPENDED: 'SUSPENDED',
  FINISHED: 'FINISHED',
  CANCELLED: 'CANCELLED',
  POSTPONED: 'POSTPONED',
} as const;
export type EventStatus = (typeof EventStatus)[keyof typeof EventStatus];
export const EVENT_STATUSES = values(EventStatus);

export const MarketStatus = {
  OPEN: 'OPEN',
  SUSPENDED: 'SUSPENDED',
  CLOSED: 'CLOSED',
  SETTLED: 'SETTLED',
} as const;
export type MarketStatus = (typeof MarketStatus)[keyof typeof MarketStatus];
export const MARKET_STATUSES = values(MarketStatus);

export const SelectionStatus = {
  OPEN: 'OPEN',
  SUSPENDED: 'SUSPENDED',
  CLOSED: 'CLOSED',
} as const;
export type SelectionStatus = (typeof SelectionStatus)[keyof typeof SelectionStatus];
export const SELECTION_STATUSES = values(SelectionStatus);

export const SelectionResult = {
  PENDING: 'PENDING',
  WON: 'WON',
  LOST: 'LOST',
  VOID: 'VOID',
} as const;
export type SelectionResult = (typeof SelectionResult)[keyof typeof SelectionResult];
export const SELECTION_RESULTS = values(SelectionResult);

export const BetStatus = {
  PENDING: 'PENDING',
  WON: 'WON',
  LOST: 'LOST',
  VOID: 'VOID',
  REFUNDED: 'REFUNDED',
  /** Closed early by the player at the offered cashout value. */
  CASHED_OUT: 'CASHED_OUT',
} as const;
export type BetStatus = (typeof BetStatus)[keyof typeof BetStatus];
export const BET_STATUSES = values(BetStatus);

export const BetType = {
  SINGLE: 'SINGLE',
  DOUBLE: 'DOUBLE',
  TRIPLE: 'TRIPLE',
  ACCUMULATOR: 'ACCUMULATOR',
  /** Several selections on one match at one model price. */
  BET_BUILDER: 'BET_BUILDER',
} as const;
export type BetType = (typeof BetType)[keyof typeof BetType];
export const BET_TYPES = values(BetType);

/**
 * How the slip was submitted: one bet per selection, one combined bet across
 * matches, or a Bet Builder (several selections on one match).
 */
export const SlipMode = {
  SINGLES: 'SINGLES',
  COMBO: 'COMBO',
  BUILDER: 'BUILDER',
} as const;
export type SlipMode = (typeof SlipMode)[keyof typeof SlipMode];
export const SLIP_MODES = values(SlipMode);

/**
 * What the player agreed to when odds move between display and placement.
 * There is deliberately no "accept any change": a shortened price is never
 * taken on the player's behalf.
 */
export const OddsChangePolicy = {
  REJECT: 'REJECT',
  ACCEPT_HIGHER: 'ACCEPT_HIGHER',
} as const;
export type OddsChangePolicy = (typeof OddsChangePolicy)[keyof typeof OddsChangePolicy];
export const ODDS_CHANGE_POLICIES = values(OddsChangePolicy);

export const TransactionType = {
  DEPOSIT_DEMO: 'DEPOSIT_DEMO',
  BET_PLACED: 'BET_PLACED',
  BET_WON: 'BET_WON',
  BET_LOST: 'BET_LOST',
  BET_VOID: 'BET_VOID',
  BET_REFUND: 'BET_REFUND',
  CASH_OUT: 'CASH_OUT',
  CASINO_BET: 'CASINO_BET',
  CASINO_WIN: 'CASINO_WIN',
  CASINO_REFUND: 'CASINO_REFUND',
} as const;
export type TransactionType = (typeof TransactionType)[keyof typeof TransactionType];
export const TRANSACTION_TYPES = values(TransactionType);

export const LimitType = {
  STAKE_PER_BET: 'STAKE_PER_BET',
  STAKE_DAILY: 'STAKE_DAILY',
  STAKE_WEEKLY: 'STAKE_WEEKLY',
  STAKE_MONTHLY: 'STAKE_MONTHLY',
} as const;
export type LimitType = (typeof LimitType)[keyof typeof LimitType];
export const LIMIT_TYPES = values(LimitType);

export const AuthTokenType = {
  EMAIL_VERIFICATION: 'EMAIL_VERIFICATION',
  PASSWORD_RESET: 'PASSWORD_RESET',
} as const;
export type AuthTokenType = (typeof AuthTokenType)[keyof typeof AuthTokenType];

export const KycStatus = {
  NOT_REQUIRED: 'NOT_REQUIRED',
  NOT_STARTED: 'NOT_STARTED',
  PENDING: 'PENDING',
  VERIFIED: 'VERIFIED',
  REJECTED: 'REJECTED',
} as const;
export type KycStatus = (typeof KycStatus)[keyof typeof KycStatus];
export const KYC_STATUSES = values(KycStatus);

export const SportKey = {
  FOOTBALL: 'football',
  TENNIS: 'tennis',
  BASKETBALL: 'basketball',
} as const;
export type SportKey = (typeof SportKey)[keyof typeof SportKey];
export const SPORT_KEYS = values(SportKey);

export const CasinoGameType = {
  SLOT: 'SLOT',
  ROULETTE: 'ROULETTE',
  BLACKJACK: 'BLACKJACK',
  BACCARAT: 'BACCARAT',
} as const;
export type CasinoGameType = (typeof CasinoGameType)[keyof typeof CasinoGameType];
export const CASINO_GAME_TYPES = values(CasinoGameType);

export const CasinoGameStatus = {
  ACTIVE: 'ACTIVE',
  MAINTENANCE: 'MAINTENANCE',
  DISABLED: 'DISABLED',
} as const;
export type CasinoGameStatus = (typeof CasinoGameStatus)[keyof typeof CasinoGameStatus];
export const CASINO_GAME_STATUSES = values(CasinoGameStatus);

export const CasinoSessionStatus = { OPEN: 'OPEN', CLOSED: 'CLOSED' } as const;
export type CasinoSessionStatus = (typeof CasinoSessionStatus)[keyof typeof CasinoSessionStatus];
export const CASINO_SESSION_STATUSES = values(CasinoSessionStatus);

export const CasinoRoundStatus = {
  OPEN: 'OPEN',
  SETTLED: 'SETTLED',
  REFUNDED: 'REFUNDED',
} as const;
export type CasinoRoundStatus = (typeof CasinoRoundStatus)[keyof typeof CasinoRoundStatus];
export const CASINO_ROUND_STATUSES = values(CasinoRoundStatus);
