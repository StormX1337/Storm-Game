import type { DbOrTx } from '@storm-bet/database';
import type { LimitType } from '@storm-bet/types';

/** Raising or removing a limit only takes effect after this cooling-off period. */
export const LIMIT_COOLING_OFF_HOURS = 24;

export const LIMIT_WINDOWS_MS: Record<Exclude<LimitType, 'STAKE_PER_BET'>, number> = {
  STAKE_DAILY: 24 * 3_600_000,
  STAKE_WEEKLY: 7 * 24 * 3_600_000,
  STAKE_MONTHLY: 30 * 24 * 3_600_000,
};

export const LIMIT_LABELS: Record<LimitType, string> = {
  STAKE_PER_BET: 'Einsatz pro Wette',
  STAKE_DAILY: 'Einsatz pro 24 Stunden',
  STAKE_WEEKLY: 'Einsatz pro 7 Tage',
  STAKE_MONTHLY: 'Einsatz pro 30 Tage',
};

export interface LimitRow {
  type: LimitType;
  amount: bigint;
  effectiveFrom: Date;
  pendingAmount: bigint | null;
  pendingEffectiveAt: Date | null;
}

/** "No limit" is represented by removing the row; a pending removal is pendingAmount = -1. */
export const REMOVAL_MARKER = -1n;

export interface LimitChangePlan {
  /** Values to write. `delete` removes the limit row entirely. */
  action: 'create' | 'update' | 'delete' | 'none';
  amount?: bigint;
  pendingAmount?: bigint | null;
  pendingEffectiveAt?: Date | null;
  appliesImmediately: boolean;
}

/**
 * Decides how a requested limit change applies. Tightening is immediate;
 * loosening (a higher amount or removal) waits out the cooling-off period, so
 * a limit cannot be undone in the heat of the moment.
 */
export function planLimitChange(
  current: LimitRow | null,
  requested: bigint | null,
  now: Date,
  options: { byStaff?: boolean } = {},
): LimitChangePlan {
  const coolingOff = new Date(now.getTime() + LIMIT_COOLING_OFF_HOURS * 3_600_000);
  if (!current) {
    if (requested === null) return { action: 'none', appliesImmediately: true };
    return { action: 'create', amount: requested, appliesImmediately: true };
  }
  // Staff act on documented requests (e.g. support tickets) and bypass the wait.
  if (options.byStaff) {
    if (requested === null) return { action: 'delete', appliesImmediately: true };
    return {
      action: 'update',
      amount: requested,
      pendingAmount: null,
      pendingEffectiveAt: null,
      appliesImmediately: true,
    };
  }
  if (requested !== null && requested <= current.amount) {
    return {
      action: 'update',
      amount: requested,
      pendingAmount: null,
      pendingEffectiveAt: null,
      appliesImmediately: true,
    };
  }
  return {
    action: 'update',
    amount: current.amount,
    pendingAmount: requested ?? REMOVAL_MARKER,
    pendingEffectiveAt: coolingOff,
    appliesImmediately: false,
  };
}

/**
 * Loads the user's limits, applying any pending loosening whose cooling-off
 * period has passed. Returns the effective amounts.
 */
export async function loadEffectiveLimits(
  db: DbOrTx,
  userId: string,
  now: Date,
): Promise<Map<LimitType, LimitRow>> {
  const rows = await db.userLimit.findMany({ where: { userId } });
  const out = new Map<LimitType, LimitRow>();
  for (const row of rows) {
    if (row.pendingEffectiveAt && row.pendingEffectiveAt <= now && row.pendingAmount !== null) {
      if (row.pendingAmount === REMOVAL_MARKER) {
        await db.userLimit.delete({ where: { id: row.id } });
        continue;
      }
      const updated = await db.userLimit.update({
        where: { id: row.id },
        data: {
          amount: row.pendingAmount,
          effectiveFrom: row.pendingEffectiveAt,
          pendingAmount: null,
          pendingEffectiveAt: null,
        },
      });
      out.set(updated.type, updated);
      continue;
    }
    out.set(row.type, row);
  }
  return out;
}

/** Sum of stakes placed in the rolling window ending now. */
/** Stakes of bets and casino rounds: a stake limit covers the whole account. */
export async function stakedSince(db: DbOrTx, userId: string, since: Date): Promise<bigint> {
  const [bets, casino] = await Promise.all([
    db.bet.aggregate({ where: { userId, placedAt: { gt: since } }, _sum: { stake: true } }),
    db.casinoRound.aggregate({
      where: { userId, createdAt: { gt: since } },
      _sum: { stake: true },
    }),
  ]);
  return (bets._sum.stake ?? 0n) + (casino._sum.stake ?? 0n);
}

export interface LimitViolation {
  type: LimitType;
  limit: bigint;
  used: bigint;
  requested: bigint;
}

/**
 * Checks a slip against every effective limit. `stakes` are the individual
 * bets the slip would create.
 */
export async function checkStakeLimits(
  db: DbOrTx,
  userId: string,
  stakes: bigint[],
  now: Date,
): Promise<LimitViolation | null> {
  const limits = await loadEffectiveLimits(db, userId, now);
  const total = stakes.reduce((a, b) => a + b, 0n);
  const perBet = limits.get('STAKE_PER_BET');
  if (perBet) {
    const largest = stakes.reduce((a, b) => (b > a ? b : a), 0n);
    if (largest > perBet.amount) {
      return { type: 'STAKE_PER_BET', limit: perBet.amount, used: 0n, requested: largest };
    }
  }
  for (const [type, windowMs] of Object.entries(LIMIT_WINDOWS_MS) as [
    Exclude<LimitType, 'STAKE_PER_BET'>,
    number,
  ][]) {
    const limit = limits.get(type);
    if (!limit) continue;
    const used = await stakedSince(db, userId, new Date(now.getTime() - windowMs));
    if (used + total > limit.amount) return { type, limit: limit.amount, used, requested: total };
  }
  return null;
}

export interface ActiveExclusion {
  endsAt: Date | null;
}

export async function activeSelfExclusion(
  db: DbOrTx,
  userId: string,
  now: Date,
): Promise<ActiveExclusion | null> {
  const row = await db.selfExclusion.findFirst({
    where: { userId, startsAt: { lte: now }, OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
    orderBy: [{ endsAt: { sort: 'desc', nulls: 'first' } }],
    select: { endsAt: true },
  });
  return row;
}

export const SELF_EXCLUSION_DURATIONS_MS = {
  '24h': 24 * 3_600_000,
  '7d': 7 * 24 * 3_600_000,
  '30d': 30 * 24 * 3_600_000,
  '180d': 180 * 24 * 3_600_000,
  permanent: null,
} as const;
