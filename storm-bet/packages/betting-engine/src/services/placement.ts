import { randomUUID } from 'node:crypto';
import type { BettingLimits } from '@storm-bet/config';
import { activeSelfExclusion, checkStakeLimits, LIMIT_LABELS } from '@storm-bet/compliance';
import {
  isUniqueViolation,
  milliToDecimal,
  moneyToNumber,
  pgCode,
  recordAudit,
  withTransaction,
  type PrismaClient,
  type Tx,
} from '@storm-bet/database';
import { acquireLock, type Redis } from '@storm-bet/redis';
import { generateReference, sha256 } from '@storm-bet/security';
import {
  AppError,
  ERROR_MESSAGES,
  type ErrorCode,
  type PlaceBetResponse,
  type SlipSelectionStateDto,
  type ValidateSlipResponse,
} from '@storm-bet/types';
import type { PlaceBetInput, ValidateSlipInput } from '@storm-bet/validation';
import { fromMilli, toMilli } from '../domain/odds';
import {
  bettability,
  evaluateSlip,
  formatMoney,
  type SlipIssue,
  type SlipRequest,
} from '../domain/slip';
import { loadBook, lockAndLoadBook } from './book';
import { BET_INCLUDE, toBetDto } from './mappers';
import { lockWallet, reserveStake, toWalletDto } from './wallet';

export interface PlacementDeps {
  db: PrismaClient;
  redis: Redis;
  limits: BettingLimits;
  requireEmailVerification: boolean;
  now?: () => Date;
}

export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

/** Order in which issues are reported when a slip has several. */
const ISSUE_PRIORITY: ErrorCode[] = [
  'NOT_FOUND',
  'EVENT_CLOSED',
  'MARKET_SUSPENDED',
  'ODDS_CHANGED',
  'VALIDATION_ERROR',
  'BET_LIMIT_EXCEEDED',
  'INSUFFICIENT_BALANCE',
  'FORBIDDEN',
];

function slipError(issues: SlipIssue[]): AppError {
  const sorted = [...issues].sort(
    (a, b) => ISSUE_PRIORITY.indexOf(a.code) - ISSUE_PRIORITY.indexOf(b.code),
  );
  const primary = sorted[0] as SlipIssue;
  return new AppError(primary.code, primary.message, { details: { issues: sorted } });
}

function toRequest(input: ValidateSlipInput | PlaceBetInput): SlipRequest {
  if (input.mode === 'COMBO') {
    return {
      mode: 'COMBO',
      stake: BigInt(input.stake),
      policy: input.oddsChangePolicy,
      legs: input.selections.map((s) => ({
        selectionId: s.selectionId,
        requestedOddsMilli: toMilli(s.odds),
      })),
    };
  }
  return {
    mode: 'SINGLES',
    policy: input.oddsChangePolicy,
    legs: input.selections.map((s) => ({
      selectionId: s.selectionId,
      requestedOddsMilli: toMilli(s.odds),
      stake: BigInt(s.stake),
    })),
  };
}

/** Canonical fingerprint of a slip, to refuse reuse of an idempotency key for a different one. */
function fingerprint(request: SlipRequest): string {
  const legs = [...request.legs]
    .sort((a, b) => a.selectionId.localeCompare(b.selectionId))
    .map((l) => `${l.selectionId}@${l.requestedOddsMilli}x${l.stake ?? ''}`);
  return sha256(`${request.mode}|${request.stake ?? ''}|${request.policy}|${legs.join(',')}`);
}

const RETRYABLE_SQLSTATES = new Set(['40P01', '40001']);

/**
 * Places bets. The sequence mirrors the specification:
 *   authenticate → load wallet → validate slip, events, markets, selections,
 *   odds → check limits → reserve funds atomically → create bet, odds
 *   snapshot, ledger entry and audit record → respond.
 * Steps 2–13 run in one PostgreSQL transaction holding share locks on every
 * row the bet depends on and an exclusive lock on the wallet.
 */
export class BetPlacementService {
  private readonly now: () => Date;

  constructor(private readonly deps: PlacementDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Quote and pre-check a slip without placing it. Never locks rows. */
  async validate(userId: string | null, input: ValidateSlipInput): Promise<ValidateSlipResponse> {
    const request = toRequest(input);
    const now = this.now();
    const book = await loadBook(
      this.deps.db,
      request.legs.map((l) => l.selectionId),
    );
    const evaluation = evaluateSlip(request, book, {
      now,
      limits: this.deps.limits,
      requireStake: false,
    });
    const issues = [...evaluation.issues];

    if (userId && evaluation.totalStake > 0n) {
      const wallet = await this.deps.db.wallet.findUnique({ where: { userId } });
      if (wallet && wallet.balance - wallet.reserved < evaluation.totalStake) {
        issues.push({ code: 'INSUFFICIENT_BALANCE', message: ERROR_MESSAGES.INSUFFICIENT_BALANCE });
      }
      const violation = await checkStakeLimits(
        this.deps.db,
        userId,
        evaluation.bets.map((b) => b.stake),
        now,
      );
      if (violation) issues.push(this.limitIssue(violation.type, violation.limit, violation.used));
    }

    const selections: SlipSelectionStateDto[] = request.legs.flatMap((leg) => {
      const b = book.get(leg.selectionId);
      if (!b) return [];
      return [
        {
          selectionId: b.selectionId,
          eventId: b.eventId,
          eventName: b.eventName,
          marketName: b.marketName,
          selectionName: b.selectionName,
          requestedOdds: fromMilli(leg.requestedOddsMilli),
          currentOdds: fromMilli(b.oddsMilli),
          oddsVersion: b.oddsVersion,
          status: b.selectionStatus,
          marketStatus: b.marketTradingSuspended ? 'SUSPENDED' : b.marketStatus,
          eventStatus: b.eventTradingSuspended ? 'SUSPENDED' : b.eventStatus,
          bettable: bettability(b, now) === null,
        },
      ];
    });

    return {
      valid: issues.length === 0,
      quote: {
        mode: request.mode,
        betType: evaluation.betType,
        totalOdds: fromMilli(evaluation.totalOddsMilli),
        totalStake: moneyToNumber(evaluation.totalStake),
        potentialReturn: moneyToNumber(evaluation.potentialReturn),
        selectionCount: request.legs.length,
      },
      selections,
      issues: issues.map((i) => ({ ...i })),
    };
  }

  async place(
    userId: string,
    input: PlaceBetInput,
    meta: RequestMeta = {},
  ): Promise<PlaceBetResponse> {
    const request = toRequest(input);
    const requestHash = fingerprint(request);

    const replay = await this.replay(userId, input.idempotencyKey, requestHash);
    if (replay) return replay;

    // One placement per player at a time. The wallet row lock enforces the
    // same inside PostgreSQL; this keeps concurrent requests from queueing
    // on database locks and gives a clean answer instead.
    const lock = await acquireLock(this.deps.redis, `bet:user:${userId}`, {
      ttlMs: 20_000,
      waitMs: 5_000,
    });
    if (!lock)
      throw new AppError(
        'CONFLICT',
        'Eine andere Wette wird gerade verarbeitet. Bitte versuche es erneut.',
      );
    try {
      for (let attempt = 1; ; attempt += 1) {
        try {
          const slipId = await withTransaction(this.deps.db, (tx) =>
            this.placeInTransaction(tx, userId, input.idempotencyKey, requestHash, request, meta),
          );
          return await this.response(slipId, userId, false);
        } catch (error) {
          if (isUniqueViolation(error)) {
            const again = await this.replay(userId, input.idempotencyKey, requestHash);
            if (again) return again;
          }
          const code = pgCode(error);
          if (attempt < 3 && ((code && RETRYABLE_SQLSTATES.has(code)) || isUniqueViolation(error)))
            continue;
          throw error;
        }
      }
    } finally {
      await lock.release().catch(() => undefined);
    }
  }

  private async placeInTransaction(
    tx: Tx,
    userId: string,
    idempotencyKey: string,
    requestHash: string,
    request: SlipRequest,
    meta: RequestMeta,
  ): Promise<string> {
    const now = this.now();

    // 1. Authenticated user — re-read, never trusted from the session alone.
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, status: true, emailVerifiedAt: true },
    });
    if (!user || user.status !== 'ACTIVE') {
      throw new AppError('FORBIDDEN', 'Dein Konto ist für Wetten gesperrt.');
    }
    if (this.deps.requireEmailVerification && !user.emailVerifiedAt) {
      throw new AppError('FORBIDDEN', 'Bitte bestätige zuerst deine E-Mail-Adresse.');
    }

    // 2. Wallet — exclusive lock for the rest of the transaction.
    let wallet = await lockWallet(tx, userId);

    const exclusion = await activeSelfExclusion(tx, userId, now);
    if (exclusion) {
      throw new AppError(
        'FORBIDDEN',
        exclusion.endsAt
          ? `Selbstsperre aktiv bis ${exclusion.endsAt.toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}.`
          : 'Selbstsperre aktiv.',
      );
    }

    // 3–7. Slip, events, markets, selections and odds — against locked rows.
    const book = await lockAndLoadBook(
      tx,
      request.legs.map((l) => l.selectionId),
    );
    const evaluation = evaluateSlip(request, book, {
      now,
      limits: this.deps.limits,
      requireStake: true,
    });
    if (evaluation.issues.length) throw slipError(evaluation.issues);

    // 8. Limits (per bet and rolling windows) and funds.
    const violation = await checkStakeLimits(
      tx,
      userId,
      evaluation.bets.map((b) => b.stake),
      now,
    );
    if (violation) {
      const i = this.limitIssue(violation.type, violation.limit, violation.used);
      throw new AppError(i.code, i.message, { details: { issues: [i] } });
    }
    if (wallet.balance - wallet.reserved < evaluation.totalStake) {
      throw new AppError('INSUFFICIENT_BALANCE', undefined, {
        details: {
          available: moneyToNumber(wallet.balance - wallet.reserved),
          required: moneyToNumber(evaluation.totalStake),
        },
      });
    }

    const slip = await tx.betSlip.create({
      data: {
        userId,
        idempotencyKey,
        requestHash,
        mode: request.mode,
        totalStake: evaluation.totalStake,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent?.slice(0, 400) ?? null,
      },
    });

    for (const planned of evaluation.bets) {
      const betId = randomUUID();
      const reference = generateReference('SB');
      // 10. Bet
      await tx.bet.create({
        data: {
          id: betId,
          reference,
          userId,
          slipId: slip.id,
          type: planned.type,
          stake: planned.stake,
          totalOdds: milliToDecimal(Number(planned.totalOddsMilli)),
          potentialReturn: planned.potentialReturn,
          oddsChangePolicy: request.policy,
          placedAt: now,
        },
      });
      // 9 + 12. Reserve the stake atomically and book it in the ledger.
      wallet = await reserveStake(
        tx,
        wallet,
        planned.stake,
        betId,
        `Einsatz reserviert · ${reference}`,
        {
          reference,
          type: planned.type,
        },
      );
      // 11. Legs with their odds snapshots.
      const legs = planned.legs.map((leg) => ({ leg, id: randomUUID() }));
      await tx.betSelection.createMany({
        data: legs.map(({ leg, id }) => ({
          id,
          betId,
          selectionId: leg.book.selectionId,
          marketId: leg.book.marketId,
          eventId: leg.book.eventId,
          odds: milliToDecimal(leg.oddsMilli),
          eventName: leg.book.eventName,
          marketName: leg.book.marketName,
          selectionName: leg.book.selectionName,
        })),
      });
      await tx.oddsSnapshot.createMany({
        data: legs.map(({ leg, id }) => ({
          betSelectionId: id,
          selectionId: leg.book.selectionId,
          odds: milliToDecimal(leg.oddsMilli),
          oddsVersion: leg.book.oddsVersion,
          eventStatus: leg.book.eventStatus,
          marketStatus: leg.book.marketStatus,
          homeScore: leg.book.homeScore,
          awayScore: leg.book.awayScore,
          source: leg.book.provider,
          capturedAt: now,
        })),
      });
      // 13. Audit trail.
      await recordAudit(
        tx,
        { id: userId, role: user.role, ip: meta.ip, userAgent: meta.userAgent },
        {
          action: 'bet.placed',
          targetType: 'bet',
          targetId: betId,
          metadata: {
            reference,
            slipId: slip.id,
            type: planned.type,
            stake: moneyToNumber(planned.stake),
            totalOdds: fromMilli(planned.totalOddsMilli),
            potentialReturn: moneyToNumber(planned.potentialReturn),
            legs: planned.legs.map((l) => ({
              selectionId: l.book.selectionId,
              odds: fromMilli(l.oddsMilli),
            })),
          },
        },
      );
    }
    return slip.id;
  }

  private limitIssue(type: keyof typeof LIMIT_LABELS, limit: bigint, used: bigint): SlipIssue {
    const remaining = limit - used > 0n ? limit - used : 0n;
    return {
      code: 'BET_LIMIT_EXCEEDED',
      message: `Dein Limit „${LIMIT_LABELS[type]}“ (${formatMoney(limit)} DEMO) wäre überschritten. Verbleibend: ${formatMoney(remaining)} DEMO.`,
    };
  }

  private async replay(
    userId: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<PlaceBetResponse | null> {
    const slip = await this.deps.db.betSlip.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey } },
      select: { id: true, requestHash: true },
    });
    if (!slip) return null;
    if (slip.requestHash !== requestHash) {
      throw new AppError(
        'CONFLICT',
        'Dieser Wettschein wurde bereits mit anderem Inhalt gesendet.',
      );
    }
    return this.response(slip.id, userId, true);
  }

  private async response(
    slipId: string,
    userId: string,
    replayed: boolean,
  ): Promise<PlaceBetResponse> {
    const [bets, wallet] = await Promise.all([
      this.deps.db.bet.findMany({
        where: { slipId, userId },
        include: BET_INCLUDE,
        orderBy: { createdAt: 'asc' },
      }),
      this.deps.db.wallet.findUniqueOrThrow({ where: { userId } }),
    ]);
    return { slipId, replayed, bets: bets.map(toBetDto), wallet: toWalletDto(wallet) };
  }
}
