import {
  decimalToNumber,
  moneyToNumber,
  oddsToMilli,
  recordAudit,
  SYSTEM_ACTOR,
  withTransaction,
  type AuditActor,
  type PrismaClient,
} from '@storm-bet/database';
import { acquireLock, publishRealtime, type Redis } from '@storm-bet/redis';
import { AppError, type SelectionResult } from '@storm-bet/types';
import { parseStatistics } from '@storm-bet/validation';
import { decideBet, resolveSelection, SettlementDataError } from '../domain/settlement-rules';
import { settleStake, type SettlementTransactionType } from './wallet';

export interface SettlementLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface SettlementDeps {
  db: PrismaClient;
  redis: Redis;
  logger?: SettlementLogger;
  now?: () => Date;
}

export interface EventSettlementReport {
  eventId: string;
  skipped: string | null;
  resultedSelections: number;
  unresolvedMarkets: number;
  settledBets: number;
  completed: boolean;
}

const TRANSACTION_FOR: Record<'WON' | 'LOST' | 'VOID', SettlementTransactionType> = {
  WON: 'BET_WON',
  LOST: 'BET_LOST',
  VOID: 'BET_VOID',
};

const DESCRIPTION_FOR: Record<'WON' | 'LOST' | 'VOID', string> = {
  WON: 'Gewinn ausgezahlt',
  LOST: 'Wette verloren',
  VOID: 'Wette storniert – Einsatz zurück',
};

const noopLogger: SettlementLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Settles bets from official results. Idempotent at every level:
 * - an event is resulted under a Redis lock, and only PENDING rows change;
 * - a bet moves out of PENDING through a row-locked conditional update;
 * - the ledger accepts one settlement entry per bet (unique key + trigger).
 * Running it twice, or in two workers at once, can never pay a bet twice.
 */
export class SettlementService {
  private readonly logger: SettlementLogger;
  private readonly now: () => Date;

  constructor(private readonly deps: SettlementDeps) {
    this.logger = deps.logger ?? noopLogger;
    this.now = deps.now ?? (() => new Date());
  }

  /** Finds finished or cancelled events that are not yet settled and settles them. */
  async settleDueEvents(limit = 25): Promise<EventSettlementReport[]> {
    const due = await this.deps.db.event.findMany({
      where: {
        settledAt: null,
        OR: [{ status: 'FINISHED', resultConfirmedAt: { not: null } }, { status: 'CANCELLED' }],
      },
      select: { id: true },
      orderBy: { startTime: 'asc' },
      take: limit,
    });
    const reports: EventSettlementReport[] = [];
    for (const { id } of due) {
      try {
        reports.push(await this.settleEvent(id));
      } catch (error) {
        this.logger.error({ eventId: id, err: String(error) }, 'event settlement failed');
      }
    }
    // Safety net: bets whose legs are all decided but that are still open
    // (e.g. a crash between resulting and settling).
    await this.sweepDecidableBets();
    return reports;
  }

  async settleEvent(
    eventId: string,
    actor: AuditActor = SYSTEM_ACTOR,
  ): Promise<EventSettlementReport> {
    const report: EventSettlementReport = {
      eventId,
      skipped: null,
      resultedSelections: 0,
      unresolvedMarkets: 0,
      settledBets: 0,
      completed: false,
    };
    const lock = await acquireLock(this.deps.redis, `settle:event:${eventId}`, { ttlMs: 120_000 });
    if (!lock) return { ...report, skipped: 'locked' };
    try {
      const event = await this.deps.db.event.findUnique({
        where: { id: eventId },
        include: { markets: { include: { selections: true } } },
      });
      if (!event) throw new AppError('NOT_FOUND', 'Event nicht gefunden.');
      if (event.settledAt) return { ...report, skipped: 'already settled', completed: true };
      if (event.status === 'FINISHED' && !event.resultConfirmedAt) {
        return { ...report, skipped: 'result not confirmed' };
      }
      if (event.status !== 'FINISHED' && event.status !== 'CANCELLED') {
        return { ...report, skipped: `event is ${event.status}` };
      }
      const stats = parseStatistics(event.statistics);

      const results = new Map<SelectionResult, string[]>();
      const settledMarkets: string[] = [];
      for (const market of event.markets) {
        if (market.status === 'SETTLED') continue;
        try {
          const decided = market.selections.map((s) => ({
            id: s.id,
            result: resolveSelection(
              {
                marketType: market.type,
                line: decimalToNumber(market.line),
                outcome: s.outcome,
                playerId: s.playerId,
              },
              event.status,
              stats,
            ),
          }));
          for (const d of decided) results.set(d.result, [...(results.get(d.result) ?? []), d.id]);
          settledMarkets.push(market.id);
        } catch (error) {
          if (!(error instanceof SettlementDataError)) throw error;
          report.unresolvedMarkets += 1;
          this.logger.warn(
            { eventId, marketId: market.id, reason: error.message },
            'market needs a manual result',
          );
        }
      }

      await withTransaction(this.deps.db, async (tx) => {
        for (const [result, ids] of results) {
          const updated = await tx.selection.updateMany({
            where: { id: { in: ids }, result: 'PENDING' },
            data: { result, status: 'CLOSED' },
          });
          report.resultedSelections += updated.count;
          await tx.betSelection.updateMany({
            where: { selectionId: { in: ids }, result: 'PENDING' },
            data: { result },
          });
        }
        if (settledMarkets.length) {
          await tx.market.updateMany({
            where: { id: { in: settledMarkets }, status: { not: 'SETTLED' } },
            data: { status: 'SETTLED', settledAt: this.now() },
          });
        }
        await recordAudit(tx, actor, {
          action: 'event.resulted',
          targetType: 'event',
          targetId: eventId,
          metadata: {
            status: event.status,
            score: event.homeScore == null ? null : `${event.homeScore}:${event.awayScore}`,
            markets: settledMarkets.length,
            unresolvedMarkets: report.unresolvedMarkets,
          },
        });
      });

      const bets = await this.deps.db.bet.findMany({
        where: { status: 'PENDING', selections: { some: { eventId } } },
        select: { id: true },
      });
      for (const bet of bets) {
        try {
          if (await this.settleBet(bet.id, actor)) report.settledBets += 1;
        } catch (error) {
          this.logger.error({ betId: bet.id, err: String(error) }, 'bet settlement failed');
        }
      }

      if (report.unresolvedMarkets === 0) {
        await this.deps.db.event.update({
          where: { id: eventId },
          data: { settledAt: this.now() },
        });
        report.completed = true;
      }
      await publishRealtime(this.deps.redis, [
        {
          type: 'market',
          eventId,
          markets: settledMarkets.map((id) => ({ id, status: 'SETTLED' as const })),
        },
      ]).catch(() => undefined);
      this.logger.info({ ...report }, 'event settled');
      return report;
    } finally {
      await lock.release().catch(() => undefined);
    }
  }

  /**
   * Settles one bet if its legs decide it. Returns the new status, or null if
   * the bet is not (or no longer) open, or not yet decidable.
   */
  async settleBet(
    betId: string,
    actor: AuditActor = SYSTEM_ACTOR,
  ): Promise<'WON' | 'LOST' | 'VOID' | null> {
    return withTransaction(this.deps.db, async (tx) => {
      const locked = await tx.$queryRaw<
        { id: string; status: string; stake: bigint; user_id: string; reference: string }[]
      >`
        SELECT "id", "status"::text AS "status", "stake", "user_id", "reference"
        FROM "bets" WHERE "id" = ${betId}::uuid FOR UPDATE`;
      const bet = locked[0];
      if (!bet || bet.status !== 'PENDING') return null;

      const legs = await tx.betSelection.findMany({
        where: { betId },
        select: { odds: true, result: true },
      });
      const outcome = decideBet(
        bet.stake,
        legs.map((l) => ({ odds: oddsToMilli(l.odds), result: l.result })),
      );
      if (!outcome.decided) return null;

      const now = this.now();
      const changed = await tx.bet.updateMany({
        where: { id: betId, status: 'PENDING' },
        data: { status: outcome.status, payout: outcome.payout, settledAt: now },
      });
      if (changed.count !== 1) return null;

      await settleStake(
        tx,
        bet.user_id,
        bet.stake,
        outcome.payout,
        TRANSACTION_FOR[outcome.status],
        betId,
        `${DESCRIPTION_FOR[outcome.status]} · ${bet.reference}`,
        { reference: bet.reference },
      );
      await recordAudit(tx, actor, {
        action: 'bet.settled',
        targetType: 'bet',
        targetId: betId,
        metadata: {
          reference: bet.reference,
          status: outcome.status,
          stake: moneyToNumber(bet.stake),
          payout: moneyToNumber(outcome.payout),
          settledOdds:
            outcome.settledOddsMilli == null ? null : Number(outcome.settledOddsMilli) / 1000,
        },
      });
      return outcome.status;
    });
  }

  /** Staff cancellation of an open bet: the stake goes back, the record stays. */
  async refundBet(betId: string, actor: AuditActor, reason: string): Promise<void> {
    await withTransaction(this.deps.db, async (tx) => {
      const locked = await tx.$queryRaw<
        { status: string; stake: bigint; user_id: string; reference: string }[]
      >`
        SELECT "status"::text AS "status", "stake", "user_id", "reference"
        FROM "bets" WHERE "id" = ${betId}::uuid FOR UPDATE`;
      const bet = locked[0];
      if (!bet) throw new AppError('NOT_FOUND', 'Wette nicht gefunden.');
      if (bet.status !== 'PENDING') {
        throw new AppError(
          'CONFLICT',
          'Nur offene Wetten können storniert werden. Abgerechnete Wetten sind unveränderlich.',
        );
      }
      await tx.bet.update({
        where: { id: betId },
        data: {
          status: 'REFUNDED',
          payout: bet.stake,
          settledAt: this.now(),
          settlementNote: reason,
        },
      });
      await settleStake(
        tx,
        bet.user_id,
        bet.stake,
        bet.stake,
        'BET_REFUND',
        betId,
        `Wette storniert (Erstattung) · ${bet.reference}`,
        {
          reference: bet.reference,
          reason,
        },
      );
      await recordAudit(tx, actor, {
        action: 'bet.refunded',
        targetType: 'bet',
        targetId: betId,
        metadata: { reference: bet.reference, stake: moneyToNumber(bet.stake), reason },
      });
    });
  }

  private async sweepDecidableBets(): Promise<void> {
    const candidates = await this.deps.db.bet.findMany({
      where: {
        status: 'PENDING',
        OR: [
          { selections: { some: { result: 'LOST' } } },
          { selections: { every: { result: { not: 'PENDING' } } } },
        ],
      },
      select: { id: true },
      take: 200,
    });
    for (const { id } of candidates) {
      try {
        await this.settleBet(id);
      } catch (error) {
        this.logger.error({ betId: id, err: String(error) }, 'sweep settlement failed');
      }
    }
  }
}
