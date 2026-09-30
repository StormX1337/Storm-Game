import { decimalToNumber, moneyToNumber, oddsToMilli, type Prisma } from '@storm-bet/database';
import type { BetDto, SportKey, TransactionDto } from '@storm-bet/types';

/** Everything a BetDto needs, in one query (no N+1 over legs). */
export const BET_INCLUDE = {
  selections: {
    orderBy: { createdAt: 'asc' },
    include: {
      snapshot: true,
      selection: { select: { outcome: true } },
      market: { select: { type: true, line: true } },
      event: {
        select: {
          startTime: true,
          status: true,
          homeScore: true,
          awayScore: true,
          sport: { select: { key: true } },
          homeTeam: { select: { name: true } },
          awayTeam: { select: { name: true } },
        },
      },
    },
  },
  cashouts: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.BetInclude;

export type BetWithLegs = Prisma.BetGetPayload<{ include: typeof BET_INCLUDE }>;

const odds = (value: Prisma.Decimal) => oddsToMilli(value) / 1000;

export function toBetDto(bet: BetWithLegs): BetDto {
  return {
    id: bet.id,
    reference: bet.reference,
    slipId: bet.slipId,
    type: bet.type,
    status: bet.status,
    stake: moneyToNumber(bet.stake),
    totalOdds: odds(bet.totalOdds),
    potentialReturn: moneyToNumber(bet.potentialReturn),
    payout: bet.payout == null ? null : moneyToNumber(bet.payout),
    oddsChangePolicy: bet.oddsChangePolicy,
    placedAt: bet.placedAt.toISOString(),
    settledAt: bet.settledAt?.toISOString() ?? null,
    settlementNote: bet.settlementNote,
    remainingStake: moneyToNumber(bet.stake - bet.cashedOutStake),
    partialCashouts: bet.cashouts.map((c) => ({
      stake: moneyToNumber(c.stake),
      amount: moneyToNumber(c.amount),
      at: c.createdAt.toISOString(),
    })),
    autoCashout: bet.autoCashoutAmount == null ? null : moneyToNumber(bet.autoCashoutAmount),
    selections: bet.selections.map((leg) => ({
      id: leg.id,
      selectionId: leg.selectionId,
      eventId: leg.eventId,
      sportKey: leg.event.sport.key as SportKey,
      eventName: leg.eventName,
      startTime: leg.event.startTime.toISOString(),
      marketType: leg.market.type,
      marketName: leg.marketName,
      line: decimalToNumber(leg.market.line),
      selectionName: leg.selectionName,
      outcome: leg.selection.outcome,
      odds: odds(leg.odds),
      result: leg.result,
      event: {
        home: leg.event.homeTeam.name,
        away: leg.event.awayTeam.name,
        status: leg.event.status,
        score:
          leg.event.homeScore == null || leg.event.awayScore == null
            ? null
            : { home: leg.event.homeScore, away: leg.event.awayScore },
      },
      snapshot: leg.snapshot
        ? {
            odds: odds(leg.snapshot.odds),
            oddsVersion: leg.snapshot.oddsVersion,
            eventStatus: leg.snapshot.eventStatus,
            marketStatus: leg.snapshot.marketStatus,
            score:
              leg.snapshot.homeScore == null
                ? null
                : { home: leg.snapshot.homeScore, away: leg.snapshot.awayScore ?? 0 },
            source: leg.snapshot.source,
            capturedAt: leg.snapshot.capturedAt.toISOString(),
          }
        : null,
    })),
  };
}

export const TRANSACTION_INCLUDE = {
  bet: { select: { reference: true } },
} satisfies Prisma.TransactionInclude;
export type TransactionWithBet = Prisma.TransactionGetPayload<{
  include: typeof TRANSACTION_INCLUDE;
}>;

export function toTransactionDto(tx: TransactionWithBet): TransactionDto {
  return {
    id: tx.id,
    type: tx.type,
    amount: moneyToNumber(tx.amount),
    reservedDelta: moneyToNumber(tx.reservedDelta),
    balanceAfter: moneyToNumber(tx.balanceAfter),
    reservedAfter: moneyToNumber(tx.reservedAfter),
    availableAfter: moneyToNumber(tx.balanceAfter - tx.reservedAfter),
    betId: tx.betId,
    betReference: tx.bet?.reference ?? null,
    description: tx.description,
    createdAt: tx.createdAt.toISOString(),
  };
}
