import {
  moneyToNumber,
  oddsToMilli,
  recordAudit,
  withTransaction,
  type PrismaClient,
} from '@storm-bet/database';
import { acquireLock, type Redis } from '@storm-bet/redis';
import { AppError, type CashoutQuoteDto, type CashoutResponse } from '@storm-bet/types';
import { cashoutValue, type CashoutQuote } from '../domain/cashout';
import { formatMoney } from '../domain/slip';
import { loadBook, lockAndLoadBook } from './book';
import { BET_INCLUDE, toBetDto } from './mappers';
import { settleStake, toWalletDto } from './wallet';

export interface CashoutDeps {
  db: PrismaClient;
  redis: Redis;
  /** Published deduction from the value at current prices (percent). */
  marginPct: number;
  now?: () => Date;
}

const LEG_SELECT = { selectionId: true, odds: true, result: true } as const;

const toDto = (betId: string, quote: CashoutQuote): CashoutQuoteDto =>
  quote.available
    ? { betId, available: true, amount: moneyToNumber(quote.amount), reason: null }
    : { betId, available: false, amount: null, reason: quote.reason };

/**
 * Cashout: the player closes an open bet early at its value at the book's
 * current prices. The value is computed on the server only; the client's
 * figure is what the player agreed to, and a lower value is never paid
 * without a new confirmation.
 */
export class CashoutService {
  private readonly now: () => Date;

  constructor(private readonly deps: CashoutDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Current offers for the player's open bets among `betIds`. Never locks. */
  async quotes(userId: string, betIds: string[]): Promise<CashoutQuoteDto[]> {
    const bets = await this.deps.db.bet.findMany({
      where: { id: { in: betIds }, userId, status: 'PENDING' },
      select: {
        id: true,
        type: true,
        stake: true,
        potentialReturn: true,
        selections: { select: LEG_SELECT },
      },
    });
    const book = await loadBook(
      this.deps.db,
      bets.flatMap((b) => b.selections.map((s) => s.selectionId)),
    );
    const now = this.now();
    return bets.map((b) =>
      toDto(
        b.id,
        cashoutValue(
          b,
          b.selections.map((s) => ({
            oddsMilli: oddsToMilli(s.odds),
            result: s.result,
            book: book.get(s.selectionId),
          })),
          now,
          this.deps.marginPct,
        ),
      ),
    );
  }

  async cashOut(
    userId: string,
    betId: string,
    accepted: bigint,
    meta: { ip?: string | null; userAgent?: string | null } = {},
  ): Promise<CashoutResponse> {
    const lock = await acquireLock(this.deps.redis, `bet:user:${userId}`, {
      ttlMs: 20_000,
      waitMs: 5_000,
    });
    if (!lock)
      throw new AppError(
        'CONFLICT',
        'Eine andere Wette wird gerade verarbeitet. Bitte erneut versuchen.',
      );
    try {
      await withTransaction(this.deps.db, async (tx) => {
        const rows = await tx.$queryRaw<
          {
            status: string;
            type: string;
            stake: bigint;
            potential_return: bigint;
            reference: string;
          }[]
        >`
          SELECT "status"::text AS "status", "type"::text AS "type", "stake",
                 "potential_return", "reference"
          FROM "bets" WHERE "id" = ${betId}::uuid AND "user_id" = ${userId}::uuid FOR UPDATE`;
        const bet = rows[0];
        if (!bet) throw new AppError('NOT_FOUND', 'Wette nicht gefunden.');
        // A repeated request after a successful cashout answers with the result.
        if (bet.status === 'CASHED_OUT') return;
        if (bet.status !== 'PENDING') {
          throw new AppError('CONFLICT', 'Die Wette ist bereits abgerechnet.');
        }
        const user = await tx.user.findUniqueOrThrow({
          where: { id: userId },
          select: { role: true },
        });
        const legs = await tx.betSelection.findMany({ where: { betId }, select: LEG_SELECT });
        // Share locks: no price or status can move while the value is paid.
        const book = await lockAndLoadBook(
          tx,
          legs.map((l) => l.selectionId),
        );
        const now = this.now();
        const quote = cashoutValue(
          {
            type: bet.type as 'SINGLE',
            stake: bet.stake,
            potentialReturn: bet.potential_return,
          },
          legs.map((l) => ({
            oddsMilli: oddsToMilli(l.odds),
            result: l.result,
            book: book.get(l.selectionId),
          })),
          now,
          this.deps.marginPct,
        );
        if (!quote.available) throw new AppError('MARKET_SUSPENDED', quote.reason);
        if (quote.amount < accepted) {
          throw new AppError('ODDS_CHANGED', 'Der Cashout-Wert hat sich geändert.', {
            details: { amount: moneyToNumber(quote.amount) },
          });
        }
        const changed = await tx.bet.updateMany({
          where: { id: betId, status: 'PENDING' },
          data: {
            status: 'CASHED_OUT',
            payout: quote.amount,
            settledAt: now,
            settlementNote: `Cashout: ${formatMoney(quote.amount)} DEMO`,
          },
        });
        if (changed.count !== 1)
          throw new AppError('CONFLICT', 'Die Wette ist bereits abgerechnet.');
        await settleStake(
          tx,
          userId,
          bet.stake,
          quote.amount,
          'CASH_OUT',
          betId,
          `Cashout · ${bet.reference}`,
          { reference: bet.reference },
        );
        await recordAudit(
          tx,
          { id: userId, role: user.role, ip: meta.ip, userAgent: meta.userAgent },
          {
            action: 'bet.cashed_out',
            targetType: 'bet',
            targetId: betId,
            metadata: {
              reference: bet.reference,
              stake: moneyToNumber(bet.stake),
              payout: moneyToNumber(quote.amount),
              marginPct: this.deps.marginPct,
              legs: legs.map((l) => ({
                selectionId: l.selectionId,
                odds: Number(l.odds),
                result: l.result,
                currentOdds: (book.get(l.selectionId)?.oddsMilli ?? 0) / 1000,
              })),
            },
          },
        );
      });
    } finally {
      await lock.release().catch(() => undefined);
    }
    const [bet, wallet] = await Promise.all([
      this.deps.db.bet.findFirstOrThrow({ where: { id: betId, userId }, include: BET_INCLUDE }),
      this.deps.db.wallet.findUniqueOrThrow({ where: { userId } }),
    ]);
    return { bet: toBetDto(bet), wallet: toWalletDto(wallet) };
  }
}
