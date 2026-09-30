import type {
  BetStatus,
  BetType,
  EventStatus,
  LimitType,
  SportKey,
  TransactionType,
  UserRole,
  UserStatus,
} from '@storm-bet/types';

export const SPORT_LABELS: Record<SportKey, string> = {
  football: 'Fußball',
  tennis: 'Tennis',
  basketball: 'Basketball',
  hockey: 'Eishockey',
  american_football: 'American Football',
  baseball: 'Baseball',
  handball: 'Handball',
  mma: 'MMA',
};

export const BET_STATUS_LABELS: Record<BetStatus, string> = {
  PENDING: 'Offen',
  WON: 'Gewonnen',
  LOST: 'Verloren',
  VOID: 'Storniert',
  REFUNDED: 'Erstattet',
  CASHED_OUT: 'Ausgezahlt',
};

export const BET_TYPE_LABELS: Record<BetType, string> = {
  SINGLE: 'Einzelwette',
  DOUBLE: 'Zweierkombi',
  TRIPLE: 'Dreierkombi',
  ACCUMULATOR: 'Kombiwette',
  BET_BUILDER: 'Bet Builder',
};

export const EVENT_STATUS_LABELS: Record<EventStatus, string> = {
  SCHEDULED: 'Geplant',
  LIVE: 'Live',
  SUSPENDED: 'Gesperrt',
  FINISHED: 'Beendet',
  CANCELLED: 'Abgesagt',
  POSTPONED: 'Verschoben',
};

export const TRANSACTION_LABELS: Record<TransactionType, string> = {
  DEPOSIT_DEMO: 'Demo-Gutschrift',
  BET_PLACED: 'Einsatz reserviert',
  BET_WON: 'Gewinn',
  BET_LOST: 'Verlust',
  BET_VOID: 'Storno',
  BET_REFUND: 'Erstattung',
  CASH_OUT: 'Cashout',
  PARTIAL_CASH_OUT: 'Teil-Cashout',
  CASINO_BET: 'Casino-Einsatz',
  CASINO_WIN: 'Casino-Gewinn',
  CASINO_REFUND: 'Casino-Erstattung',
};

export const ROLE_LABELS: Record<UserRole, string> = {
  USER: 'Spieler',
  SUPPORT: 'Support',
  TRADER: 'Trader',
  ADMIN: 'Administrator',
};

export const USER_STATUS_LABELS: Record<UserStatus, string> = {
  ACTIVE: 'Aktiv',
  LOCKED: 'Gesperrt',
  CLOSED: 'Geschlossen',
};

export const LIMIT_LABELS: Record<LimitType, string> = {
  STAKE_PER_BET: 'Einsatz pro Wette',
  STAKE_DAILY: 'Einsatz pro 24 Stunden',
  STAKE_WEEKLY: 'Einsatz pro 7 Tage',
  STAKE_MONTHLY: 'Einsatz pro 30 Tage',
};

export function betStatusVariant(status: BetStatus) {
  switch (status) {
    case 'WON':
    case 'CASHED_OUT':
      return 'success' as const;
    case 'LOST':
      return 'danger' as const;
    case 'PENDING':
      return 'accent' as const;
    default:
      return 'default' as const;
  }
}
