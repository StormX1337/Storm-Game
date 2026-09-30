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

export interface CashoutOptions {
  /** Partial cashout: the part of the open stake to close. */
  part?: bigint;
  /** Triggered by the player's auto-cashout target, not by a click. */
  auto?: boolean;
  ip?: string | null;
  userAgent?: string | null;
}

const LEG_SELECT = { selectionId: true, odds: true, result: true } as const;

/** Stake still open and the return it can still make. */
function open(bet: { stake: bigint; cashedOutStake: bigint; potentialReturn: bigint }) {
  const stake = bet.stake - bet.cashedOutStake;
  return { stake, potentialReturn: (bet.potentialReturn * stake) / bet.stake };
}

/**
 * Cashout: the player closes an open bet — all of it or part of the stake —
 * early at its value at the book's current prices. The value is computed on
 * the server only; the client's figure is what the player agreed to, and a
 * lower value is never paid without a new confirmation.
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
        cashedOutStake: true,
        potentialReturn: true,
        autoCashoutAmount: true,
        boostId: true,
        selections: { select: LEG_SELECT },
      },
    });
    const book = await loadBook(
      this.deps.db,
      bets.flatMap((b) => b.selections.map((s) => s.selectionId)),
    );
    const now = this.now();
    return bets.map((b) => {
      const rest = open(b);
      const quote: CashoutQuote = cashoutValue(
        { type: b.type, boosted: b.boostId !== null, ...rest },
        b.selections.map((s) => ({
          oddsMilli: oddsToMilli(s.odds),
          result: s.result,
          book: book.get(s.selectionId),
        })),
        now,
        this.deps.marginPct,
      );
      return {
        betId: b.id,
        available: quote.available,
        amount: quote.available ? moneyToNumber(quote.amount) : null,
        reason: quote.available ? null : quote.reason,
        remainingStake: moneyToNumber(rest.stake),
        autoCashout: b.autoCashoutAmount == null ? null : moneyToNumber(b.autoCashoutAmount),
      };
    });
  }

  async cashOut(
    userId: string,
    betId: string,
    accepted: bigint,
    options: CashoutOptions = {},
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
            cashed_out_stake: bigint;
            potential_return: bigint;
            reference: string;
            boost_id: string | null;
          }[]
        >`
          SELECT "status"::text AS "status", "type"::text AS "type", "stake", "cashed_out_stake",
                 "potential_return", "reference", "boost_id"
          FROM "bets" WHERE "id" = ${betId}::uuid AND "user_id" = ${userId}::uuid FOR UPDATE`;
        const bet = rows[0];
        if (!bet) throw new AppError('NOT_FOUND', 'Wette nicht gefunden.');
        // A repeated request after a full cashout answers with the result.
        if (bet.status === 'CASHED_OUT' && !options.part) return;
        if (bet.status !== 'PENDING') {
          throw new AppError('CONFLICT', 'Die Wette ist bereits abgerechnet.');
        }
        const rest = open({
          stake: bet.stake,
          cashedOutStake: bet.cashed_out_stake,
          potentialReturn: bet.potential_return,
        });
        const part = options.part;
        if (part !== undefined && (part <= 0n || part >= rest.stake)) {
          throw new AppError(
            'VALIDATION_ERROR',
            'Ein Teil-Cashout muss kleiner sein als der offene Einsatz.',
          );
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
          { type: bet.type as 'SINGLE', boosted: bet.boost_id !== null, ...rest },
          legs.map((l) => ({
            oddsMilli: oddsToMilli(l.odds),
            result: l.result,
            book: book.get(l.selectionId),
          })),
          now,
          this.deps.marginPct,
        );
        if (!quote.available) throw new AppError('MARKET_SUSPENDED', quote.reason);
        const amount = part === undefined ? quote.amount : (quote.amount * part) / rest.stake;
        if (amount <= 0n) throw new AppError('VALIDATION_ERROR', 'Der Teil ist zu klein.');
        if (amount < accepted) {
          throw new AppError('ODDS_CHANGED', 'Der Cashout-Wert hat sich geändert.', {
            details: { amount: moneyToNumber(amount) },
          });
        }

        if (part === undefined) {
          const changed = await tx.bet.updateMany({
            where: { id: betId, status: 'PENDING' },
            data: {
              status: 'CASHED_OUT',
              payout: amount,
              settledAt: now,
              autoCashoutAmount: null,
              settlementNote: `${options.auto ? 'Auto-Cashout' : 'Cashout'}: ${formatMoney(amount)}`,
            },
          });
          if (changed.count !== 1)
            throw new AppError('CONFLICT', 'Die Wette ist bereits abgerechnet.');
          await settleStake(
            tx,
            userId,
            rest.stake,
            amount,
            'CASH_OUT',
            betId,
            `Cashout · ${bet.reference}`,
            {
              reference: bet.reference,
              auto: options.auto ?? false,
            },
          );
        } else {
          await tx.bet.update({
            where: { id: betId },
            data: { cashedOutStake: { increment: part } },
          });
          await tx.betCashout.create({ data: { betId, stake: part, amount } });
          // Releases the closed part of the reserved stake and pays its value.
          await settleStake(
            tx,
            userId,
            part,
            amount,
            'PARTIAL_CASH_OUT',
            betId,
            `Teil-Cashout · ${bet.reference}`,
            { reference: bet.reference },
          );
        }
        await recordAudit(
          tx,
          { id: userId, role: user.role, ip: options.ip, userAgent: options.userAgent },
          {
            action: part === undefined ? 'bet.cashed_out' : 'bet.partially_cashed_out',
            targetType: 'bet',
            targetId: betId,
            metadata: {
              reference: bet.reference,
              stakeClosed: moneyToNumber(part ?? rest.stake),
              payout: moneyToNumber(amount),
              marginPct: this.deps.marginPct,
              auto: options.auto ?? false,
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

  /** Sets or removes the auto-cashout target of an open bet. */
  async setAutoCashout(userId: string, betId: string, amount: bigint | null): Promise<void> {
    const bet = await this.deps.db.bet.findFirst({
      where: { id: betId, userId },
      select: { status: true, type: true, stake: true, potentialReturn: true },
    });
    if (!bet) throw new AppError('NOT_FOUND', 'Wette nicht gefunden.');
    if (bet.status !== 'PENDING')
      throw new AppError('CONFLICT', 'Die Wette ist bereits abgerechnet.');
    if (bet.type === 'BET_BUILDER')
      throw new AppError('VALIDATION_ERROR', 'Für Bet Builder gibt es keinen Cashout.');
    if (bet.type === 'SYSTEM')
      throw new AppError('VALIDATION_ERROR', 'Für Systemwetten gibt es keinen Cashout.');
    if (amount !== null && amount > bet.potentialReturn) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Der Zielwert darf den möglichen Gewinn (${formatMoney(bet.potentialReturn)}) nicht übersteigen.`,
      );
    }
    await this.deps.db.bet.updateMany({
      where: { id: betId, userId, status: 'PENDING' },
      data: { autoCashoutAmount: amount },
    });
  }

  /**
   * Cashes out every open bet whose value has reached its auto-cashout
   * target, at the value then (never below the target). Returns how many.
   */
  async runAutoCashouts(limit = 200): Promise<number> {
    const due = await this.deps.db.bet.findMany({
      where: { status: 'PENDING', autoCashoutAmount: { not: null } },
      select: { id: true, userId: true, autoCashoutAmount: true },
      take: limit,
    });
    let done = 0;
    for (const bet of due) {
      const [quote] = await this.quotes(bet.userId, [bet.id]);
      const target = bet.autoCashoutAmount!;
      if (!quote?.available || quote.amount === null || BigInt(quote.amount) < target) continue;
      try {
        await this.cashOut(bet.userId, bet.id, target, { auto: true });
        done += 1;
      } catch {
        // Moved below the target or suspended meanwhile: the next run looks again.
      }
    }
    return done;
  }
}
