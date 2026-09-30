import { randomUUID } from 'node:crypto';
import {
  creditCasino,
  debitCasino,
  lockWallet,
  toWalletDto,
  type WalletRow,
} from '@storm-bet/betting-engine';
import { activeSelfExclusion, checkStakeLimits, LIMIT_LABELS } from '@storm-bet/compliance';
import {
  isUniqueViolation,
  moneyToNumber,
  recordAudit,
  withTransaction,
  type AuditActor,
  type Prisma,
  type PrismaClient,
  type Tx,
} from '@storm-bet/database';
import { acquireLock, type Redis } from '@storm-bet/redis';
import { sha256 } from '@storm-bet/security';
import {
  AppError,
  type BaccaratSide,
  type CasinoPlayResponse,
  type CasinoRoundDto,
  type CasinoRoundResult,
  type CasinoSessionDto,
  type RouletteBet,
  type PlinkoRisk,
} from '@storm-bet/types';
import { playBaccarat } from './games/baccarat';
import {
  actBlackjack,
  dealBlackjack,
  type BlackjackAction,
  type BlackjackState,
} from './games/blackjack';
import { playCrash } from './games/crash';
import { actMines, startMines, type MinesState } from './games/mines';
import { dropPlinko } from './games/plinko';
import { rouletteBetValid, spinRoulette } from './games/roulette';
import { spinSlot } from './games/slots';
import type { CasinoProvider } from './provider';
import { cryptoRng, type Rng } from './rng';

export interface CasinoPlayInput {
  sessionId: string;
  idempotencyKey: string;
  action:
    | 'spin'
    | 'deal'
    | 'hit'
    | 'stand'
    | 'double'
    | 'play'
    | 'drop'
    | 'start'
    | 'reveal'
    | 'cashout';
  /** Slots and blackjack deal. */
  stake?: number;
  /** Roulette. */
  bets?: RouletteBet[];
  /** Baccarat. */
  sides?: { side: BaccaratSide; stake: number }[];
  /** Blackjack and Mines follow-up actions: the round and the step the player acted on. */
  roundId?: string;
  step?: number;
  /** Crash: cash-out multiplier set before the round. */
  target?: number;
  /** Plinko risk level. */
  risk?: PlinkoRisk;
  /** Mines: mines on the field (start) and the tile to reveal. */
  mines?: number;
  tile?: number;
}

export interface CasinoDeps {
  db: PrismaClient;
  redis: Redis;
  providers: CasinoProvider[];
  rng?: Rng;
  now?: () => Date;
}

type RoundRow = Prisma.CasinoRoundGetPayload<{ include: { game: { select: { name: true } } } }>;

const MAX_BETS = 20;
const MIN_PART = 10n; // smallest single bet on roulette/baccarat: 0.10

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value ?? null);
}

export function toRoundDto(round: RoundRow): CasinoRoundDto {
  return {
    id: round.id,
    gameId: round.gameId,
    gameName: round.game.name,
    status: round.status,
    stake: moneyToNumber(round.stake),
    payout: moneyToNumber(round.payout),
    step: round.step,
    result: round.result as unknown as CasinoRoundResult,
    createdAt: round.createdAt.toISOString(),
    settledAt: round.settledAt?.toISOString() ?? null,
  };
}

const balanceOf = (w: WalletRow) => {
  const dto = toWalletDto(w);
  return { balance: dto.balance, available: dto.available };
};

/**
 * Sessions and rounds of the play-money casino. Every round is decided here,
 * on the server, with a cryptographic RNG, and booked in one database
 * transaction together with its ledger entries. The client only ever sends
 * what it wants to bet; it never learns an outcome before it is final.
 */
export class CasinoService {
  private readonly rng: Rng;
  private readonly now: () => Date;
  private readonly providers: Map<string, CasinoProvider>;

  constructor(private readonly deps: CasinoDeps) {
    this.rng = deps.rng ?? cryptoRng;
    this.now = deps.now ?? (() => new Date());
    this.providers = new Map(deps.providers.map((p) => [p.key, p]));
  }

  // ─── sessions ─────────────────────────────────────────────────────────────

  async openSession(userId: string, gameId: string): Promise<CasinoSessionDto> {
    const { db } = this.deps;
    const game = await this.playableGame(db, gameId);
    await this.checkAccount(db, userId);
    const provider = this.providerFor(game.provider.key);

    let session = await db.casinoSession.findFirst({
      where: { userId, gameId, status: 'OPEN' },
      orderBy: { createdAt: 'desc' },
    });
    if (session) {
      session = await db.casinoSession.update({
        where: { id: session.id },
        data: { lastActivityAt: this.now() },
      });
    } else {
      session = await db.casinoSession.create({ data: { userId, gameId } });
    }
    const launch = await provider.createDemoSession({
      sessionId: session.id,
      userId,
      gameExternalId: game.externalId,
    });
    const open = await db.casinoRound.findFirst({
      where: { sessionId: session.id, status: 'OPEN' },
      include: { game: { select: { name: true } } },
    });
    return {
      id: session.id,
      gameId,
      status: session.status,
      createdAt: session.createdAt.toISOString(),
      launch,
      openRound: open ? toRoundDto(open) : null,
    };
  }

  /**
   * Ends a session. An unfinished blackjack hand is completed by standing —
   * the player keeps whatever the hand is worth.
   */
  async closeSession(
    sessionId: string,
    by: { userId: string } | { actor: AuditActor },
    reason: string,
  ): Promise<void> {
    const session = await this.deps.db.casinoSession.findUnique({
      where: { id: sessionId },
      include: { game: { include: { provider: true } } },
    });
    if (!session || ('userId' in by && session.userId !== by.userId))
      throw new AppError('NOT_FOUND', 'Sitzung nicht gefunden.');
    if (session.status === 'CLOSED') return;

    const open = await this.deps.db.casinoRound.findMany({
      where: { sessionId, status: 'OPEN' },
      select: { id: true, game: { select: { type: true } } },
    });
    // An unfinished hand is stood, an open mines field is cashed out.
    for (const { id, game } of open) {
      await withTransaction(this.deps.db, (tx) =>
        game.type === 'MINES'
          ? this.applyMines(tx, session.userId, id, { type: 'cashout' })
          : this.applyBlackjack(tx, session.userId, id, 'stand'),
      );
    }
    await withTransaction(this.deps.db, async (tx) => {
      const closed = await tx.casinoSession.updateMany({
        where: { id: sessionId, status: 'OPEN' },
        data: { status: 'CLOSED', closedAt: this.now(), closedReason: reason.slice(0, 200) },
      });
      if (closed.count && 'actor' in by) {
        await recordAudit(tx, by.actor, {
          action: 'casino.session.closed',
          targetType: 'casino_session',
          targetId: sessionId,
          metadata: { reason, autoStood: open.length },
        });
      }
    });
    await this.providers.get(session.game.provider.key)?.closeSession(sessionId);
  }

  /** Closes sessions without activity for `idleMs` (worker). */
  async expireIdleSessions(idleMs: number): Promise<number> {
    const stale = await this.deps.db.casinoSession.findMany({
      where: { status: 'OPEN', lastActivityAt: { lt: new Date(this.now().getTime() - idleMs) } },
      select: { id: true },
      take: 200,
    });
    for (const s of stale) {
      await this.closeSession(s.id, { actor: { id: null, role: null } }, 'Zeitüberschreitung');
    }
    return stale.length;
  }

  // ─── rounds ───────────────────────────────────────────────────────────────

  async play(userId: string, gameId: string, input: CasinoPlayInput): Promise<CasinoPlayResponse> {
    const lock = await acquireLock(this.deps.redis, `casino:${userId}`, {
      ttlMs: 10_000,
      waitMs: 2_000,
    }).catch(() => undefined); // Redis down: the row locks below still serialise
    if (lock === null) throw new AppError('CONFLICT', 'Eine andere Runde wird noch verarbeitet.');
    try {
      return await this.playLocked(userId, gameId, input);
    } catch (error) {
      // Two requests with one idempotency key: the loser returns the winner's round.
      if (isUniqueViolation(error)) {
        const replay = await this.replay(
          this.deps.db,
          userId,
          input,
          this.requestHash(gameId, input),
        );
        if (replay) return replay;
      }
      throw error;
    } finally {
      await lock?.release().catch(() => undefined);
    }
  }

  private requestHash(gameId: string, input: CasinoPlayInput): string {
    const { idempotencyKey: _key, ...rest } = input;
    return sha256(stableJson({ gameId, ...rest }));
  }

  private async replay(
    db: Tx | PrismaClient,
    userId: string,
    input: CasinoPlayInput,
    hash: string,
  ): Promise<CasinoPlayResponse | null> {
    const existing = await db.casinoRound.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey: input.idempotencyKey } },
      include: { game: { select: { name: true } } },
    });
    if (!existing) return null;
    if (existing.requestHash !== hash)
      throw new AppError(
        'CONFLICT',
        'Dieser Schlüssel wurde bereits für eine andere Runde verwendet.',
      );
    const wallet = await db.wallet.findUniqueOrThrow({ where: { userId } });
    return {
      round: toRoundDto(existing),
      balance: balanceOf({ ...wallet, userId }),
      replayed: true,
    };
  }

  private async playLocked(
    userId: string,
    gameId: string,
    input: CasinoPlayInput,
  ): Promise<CasinoPlayResponse> {
    const { db } = this.deps;
    const game = await this.playableGame(db, gameId);
    const provider = this.providerFor(game.provider.key);
    if (!provider.serverRounds)
      throw new AppError('FORBIDDEN', 'Dieses Spiel wird beim Anbieter gespielt.');

    if (game.type === 'BLACKJACK' && input.action !== 'deal') {
      if (!input.roundId || input.step === undefined)
        throw new AppError('VALIDATION_ERROR', 'Hand und Schritt fehlen.');
      const action = input.action as BlackjackAction;
      if (!['hit', 'stand', 'double'].includes(action))
        throw new AppError('VALIDATION_ERROR', 'Unbekannte Aktion.');
      return withTransaction(db, (tx) =>
        this.applyBlackjack(tx, userId, input.roundId!, action, { gameId, step: input.step! }),
      );
    }

    if (game.type === 'MINES' && input.action !== 'start') {
      if (!input.roundId || input.step === undefined)
        throw new AppError('VALIDATION_ERROR', 'Runde und Schritt fehlen.');
      const action =
        input.action === 'cashout'
          ? ({ type: 'cashout' } as const)
          : input.action === 'reveal' && input.tile !== undefined
            ? ({ type: 'reveal', tile: input.tile } as const)
            : null;
      if (!action) throw new AppError('VALIDATION_ERROR', 'Unbekannte Aktion.');
      return withTransaction(db, (tx) =>
        this.applyMines(tx, userId, input.roundId!, action, { gameId, step: input.step! }),
      );
    }

    const expected = {
      SLOT: 'spin',
      ROULETTE: 'spin',
      BACCARAT: 'deal',
      BLACKJACK: 'deal',
      CRASH: 'play',
      PLINKO: 'drop',
      MINES: 'start',
    }[game.type];
    if (input.action !== expected) throw new AppError('VALIDATION_ERROR', 'Unbekannte Aktion.');
    const stake = this.stakeOf(game.type, input);
    if (stake < game.minStake || stake > game.maxStake) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Einsatz muss zwischen ${(Number(game.minStake) / 100).toFixed(2)} und ${(Number(game.maxStake) / 100).toFixed(2)} DEMO liegen.`,
      );
    }
    const hash = this.requestHash(gameId, input);

    return withTransaction(db, async (tx) => {
      const replayed = await this.replay(tx, userId, input, hash);
      if (replayed) return replayed;

      const session = await tx.casinoSession.findFirst({
        where: { id: input.sessionId, userId, gameId, status: 'OPEN' },
      });
      if (!session)
        throw new AppError('CONFLICT', 'Die Spielsitzung ist beendet. Bitte starte das Spiel neu.');
      await this.checkAccount(tx, userId);
      const violation = await checkStakeLimits(tx, userId, [stake], this.now());
      if (violation) {
        throw new AppError('BET_LIMIT_EXCEEDED', `${LIMIT_LABELS[violation.type]} erreicht.`);
      }
      let wallet = await lockWallet(tx, userId);
      if (wallet.balance - wallet.reserved < stake) {
        throw new AppError('INSUFFICIENT_BALANCE', undefined, {
          details: {
            available: moneyToNumber(wallet.balance - wallet.reserved),
            required: moneyToNumber(stake),
          },
        });
      }
      if (game.type === 'BLACKJACK' || game.type === 'MINES') {
        const open = await tx.casinoRound.count({
          where: { sessionId: session.id, status: 'OPEN' },
        });
        if (open) throw new AppError('CONFLICT', 'Beende zuerst die laufende Hand.');
      }

      // The outcome is decided now, on the server.
      let result: CasinoRoundResult;
      let payout: bigint | null;
      let state: unknown = {};
      if (game.type === 'SLOT') ({ result, payout } = spinSlot(this.rng, stake));
      else if (game.type === 'ROULETTE') ({ result, payout } = spinRoulette(this.rng, input.bets!));
      else if (game.type === 'BACCARAT')
        ({ result, payout } = playBaccarat(this.rng, input.sides!));
      else if (game.type === 'CRASH') {
        if (input.target === undefined)
          throw new AppError('VALIDATION_ERROR', 'Auszahlungsziel fehlt.');
        ({ result, payout } = playCrash(this.rng, stake, Math.round(input.target * 100)));
      } else if (game.type === 'PLINKO') {
        if (!input.risk) throw new AppError('VALIDATION_ERROR', 'Risikostufe fehlt.');
        ({ result, payout } = dropPlinko(this.rng, stake, input.risk));
      } else if (game.type === 'MINES') {
        if (input.mines === undefined)
          throw new AppError('VALIDATION_ERROR', 'Anzahl der Minen fehlt.');
        const start = startMines(this.rng, input.mines);
        result = start.result;
        payout = null;
        state = start.state;
      } else {
        const step = dealBlackjack(this.rng, stake);
        ({ result, payout } = step);
        state = step.state;
      }
      const now = this.now();
      const round = await tx.casinoRound.create({
        data: {
          id: randomUUID(),
          userId,
          gameId,
          sessionId: session.id,
          idempotencyKey: input.idempotencyKey,
          requestHash: hash,
          stake,
          payout: payout ?? 0n,
          status: payout === null ? 'OPEN' : 'SETTLED',
          result: result as unknown as Prisma.InputJsonValue,
          state: (payout === null ? state : {}) as Prisma.InputJsonValue,
          settledAt: payout === null ? null : now,
        },
        include: { game: { select: { name: true } } },
      });
      wallet = await debitCasino(tx, wallet, stake, round.id, `Casino: ${game.name}`);
      if (payout)
        wallet = await creditCasino(
          tx,
          wallet,
          'CASINO_WIN',
          payout,
          round.id,
          `Casino-Gewinn: ${game.name}`,
        );
      await tx.casinoSession.update({ where: { id: session.id }, data: { lastActivityAt: now } });
      return { round: toRoundDto(round), balance: balanceOf(wallet), replayed: false };
    });
  }

  /**
   * One blackjack action on a locked hand. The step number makes it
   * idempotent: repeating the action already applied at that step returns the
   * current hand; anything else on an outdated step is a conflict.
   */
  private async applyBlackjack(
    tx: Tx,
    userId: string,
    roundId: string,
    action: BlackjackAction,
    expect?: { gameId: string; step: number },
  ): Promise<CasinoPlayResponse> {
    await tx.$queryRaw`SELECT "id" FROM "casino_rounds" WHERE "id" = ${roundId}::uuid FOR UPDATE`;
    const round = await tx.casinoRound.findUnique({
      where: { id: roundId },
      include: { game: { select: { name: true, type: true } } },
    });
    if (!round || round.userId !== userId || (expect && round.gameId !== expect.gameId))
      throw new AppError('NOT_FOUND', 'Hand nicht gefunden.');
    const state = round.state as unknown as BlackjackState;
    if (expect && (round.status !== 'OPEN' || round.step !== expect.step)) {
      if (
        state.actions?.[expect.step] === action ||
        (round.status !== 'OPEN' && round.step === expect.step + 1)
      ) {
        const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId } });
        return {
          round: toRoundDto(round),
          balance: balanceOf({ ...wallet, userId }),
          replayed: true,
        };
      }
      throw new AppError('CONFLICT', 'Die Hand hat sich geändert. Bitte neu laden.');
    }
    if (round.status !== 'OPEN') throw new AppError('CONFLICT', 'Die Hand ist beendet.');
    if (action === 'double' && state.player.length !== 2)
      throw new AppError(
        'VALIDATION_ERROR',
        'Verdoppeln ist nur mit den ersten zwei Karten möglich.',
      );

    let wallet = await lockWallet(tx, userId);
    let stake = round.stake;
    if (action === 'double') {
      const violation = await checkStakeLimits(tx, userId, [round.stake], this.now());
      if (violation)
        throw new AppError('BET_LIMIT_EXCEEDED', `${LIMIT_LABELS[violation.type]} erreicht.`);
      wallet = await debitCasino(
        tx,
        wallet,
        round.stake,
        round.id,
        `Casino: ${round.game.name} (verdoppelt)`,
      );
      stake = round.stake * 2n;
    }
    const step = actBlackjack(state, action, stake);
    const done = step.payout !== null;
    const now = this.now();
    const updated = await tx.casinoRound.update({
      where: { id: round.id },
      data: {
        stake,
        step: round.step + 1,
        status: done ? 'SETTLED' : 'OPEN',
        payout: step.payout ?? 0n,
        result: step.result as unknown as Prisma.InputJsonValue,
        state: (done ? {} : step.state) as unknown as Prisma.InputJsonValue,
        settledAt: done ? now : null,
      },
      include: { game: { select: { name: true } } },
    });
    if (done && step.payout)
      wallet = await creditCasino(
        tx,
        wallet,
        'CASINO_WIN',
        step.payout,
        round.id,
        `Casino-Gewinn: ${round.game.name}`,
      );
    await tx.casinoSession.update({
      where: { id: round.sessionId },
      data: { lastActivityAt: now },
    });
    return { round: toRoundDto(updated), balance: balanceOf(wallet), replayed: false };
  }

  /**
   * One Mines action (reveal a tile or cash out) on a locked field, made
   * idempotent by the step number like a blackjack action.
   */
  private async applyMines(
    tx: Tx,
    userId: string,
    roundId: string,
    action: { type: 'reveal'; tile: number } | { type: 'cashout' },
    expect?: { gameId: string; step: number },
  ): Promise<CasinoPlayResponse> {
    await tx.$queryRaw`SELECT "id" FROM "casino_rounds" WHERE "id" = ${roundId}::uuid FOR UPDATE`;
    const round = await tx.casinoRound.findUnique({
      where: { id: roundId },
      include: { game: { select: { name: true, type: true } } },
    });
    if (!round || round.userId !== userId || (expect && round.gameId !== expect.gameId))
      throw new AppError('NOT_FOUND', 'Runde nicht gefunden.');
    const key = action.type === 'reveal' ? `reveal:${action.tile}` : 'cashout';
    if (expect && (round.status !== 'OPEN' || round.step !== expect.step)) {
      const applied = (round.result as unknown as { actions?: string[] }).actions;
      if (
        applied?.[expect.step] === key ||
        (round.status !== 'OPEN' && round.step === expect.step + 1)
      ) {
        const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId } });
        return {
          round: toRoundDto(round),
          balance: balanceOf({ ...wallet, userId }),
          replayed: true,
        };
      }
      throw new AppError('CONFLICT', 'Das Feld hat sich geändert. Bitte neu laden.');
    }
    if (round.status !== 'OPEN') throw new AppError('CONFLICT', 'Die Runde ist beendet.');
    let step;
    try {
      step = actMines(round.state as unknown as MinesState, action, round.stake);
    } catch {
      throw new AppError('VALIDATION_ERROR', 'Dieses Feld ist nicht verfügbar.');
    }
    const done = step.payout !== null;
    const now = this.now();
    const updated = await tx.casinoRound.update({
      where: { id: round.id },
      data: {
        step: round.step + 1,
        status: done ? 'SETTLED' : 'OPEN',
        payout: step.payout ?? 0n,
        // The visible result keeps the action list for idempotent retries.
        result: { ...step.result, actions: step.state.actions } as unknown as Prisma.InputJsonValue,
        state: (done ? {} : step.state) as unknown as Prisma.InputJsonValue,
        settledAt: done ? now : null,
      },
      include: { game: { select: { name: true } } },
    });
    let wallet = await lockWallet(tx, userId);
    if (done && step.payout)
      wallet = await creditCasino(
        tx,
        wallet,
        'CASINO_WIN',
        step.payout,
        round.id,
        `Casino-Gewinn: ${round.game.name}`,
      );
    await tx.casinoSession.update({
      where: { id: round.sessionId },
      data: { lastActivityAt: now },
    });
    return { round: toRoundDto(updated), balance: balanceOf(wallet), replayed: false };
  }

  /** Staff: returns the stake of an unfinished round. Settled rounds are final. */
  async refundRound(roundId: string, actor: AuditActor, reason: string): Promise<CasinoRoundDto> {
    return withTransaction(this.deps.db, async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "casino_rounds" WHERE "id" = ${roundId}::uuid FOR UPDATE`;
      const round = await tx.casinoRound.findUnique({ where: { id: roundId } });
      if (!round) throw new AppError('NOT_FOUND', 'Runde nicht gefunden.');
      if (round.status !== 'OPEN')
        throw new AppError('CONFLICT', 'Nur offene Runden können erstattet werden.');
      const updated = await tx.casinoRound.update({
        where: { id: roundId },
        data: { status: 'REFUNDED', payout: round.stake, state: {}, settledAt: this.now() },
        include: { game: { select: { name: true } } },
      });
      const wallet = await lockWallet(tx, round.userId);
      await creditCasino(
        tx,
        wallet,
        'CASINO_REFUND',
        round.stake,
        roundId,
        `Casino-Erstattung: ${updated.game.name}`,
      );
      await recordAudit(tx, actor, {
        action: 'casino.round.refunded',
        targetType: 'casino_round',
        targetId: roundId,
        metadata: { reason, userId: round.userId, stake: round.stake.toString() },
      });
      return toRoundDto(updated);
    });
  }

  // ─── checks ───────────────────────────────────────────────────────────────

  private providerFor(key: string): CasinoProvider {
    const provider = this.providers.get(key);
    if (!provider) throw new AppError('SERVICE_UNAVAILABLE', 'Spieleanbieter nicht verfügbar.');
    return provider;
  }

  private async playableGame(db: Tx | PrismaClient, gameId: string) {
    const game = await db.casinoGame.findUnique({
      where: { id: gameId },
      include: { provider: true },
    });
    if (!game || game.status === 'DISABLED')
      throw new AppError('NOT_FOUND', 'Spiel nicht gefunden.');
    if (game.status !== 'ACTIVE' || !game.provider.isActive)
      throw new AppError('SERVICE_UNAVAILABLE', 'Dieses Spiel ist gerade in Wartung.');
    return game;
  }

  private async checkAccount(db: Tx | PrismaClient, userId: string): Promise<void> {
    const user = await db.user.findUnique({ where: { id: userId }, select: { status: true } });
    if (!user || user.status !== 'ACTIVE')
      throw new AppError('FORBIDDEN', 'Dein Konto ist für Spiele gesperrt.');
    const exclusion = await activeSelfExclusion(db, userId, this.now());
    if (exclusion) {
      throw new AppError(
        'FORBIDDEN',
        exclusion.endsAt
          ? `Selbstsperre aktiv bis ${exclusion.endsAt.toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}.`
          : 'Selbstsperre aktiv.',
      );
    }
  }

  private stakeOf(type: string, input: CasinoPlayInput): bigint {
    if (['SLOT', 'BLACKJACK', 'CRASH', 'PLINKO', 'MINES'].includes(type)) {
      if (!Number.isSafeInteger(input.stake) || input.stake! <= 0)
        throw new AppError('VALIDATION_ERROR', 'Ungültiger Einsatz.');
      return BigInt(input.stake!);
    }
    const parts =
      type === 'ROULETTE'
        ? (input.bets ?? []).map((b) => {
            if (!rouletteBetValid(b))
              throw new AppError('VALIDATION_ERROR', 'Ungültige Roulette-Wette.');
            return b.stake;
          })
        : (input.sides ?? []).map((s) => s.stake);
    if (type === 'BACCARAT' && new Set(input.sides?.map((s) => s.side)).size !== parts.length)
      throw new AppError('VALIDATION_ERROR', 'Jede Seite nur einmal setzen.');
    if (parts.length === 0 || parts.length > MAX_BETS)
      throw new AppError('VALIDATION_ERROR', `1 bis ${MAX_BETS} Einsätze pro Runde.`);
    let total = 0n;
    for (const p of parts) {
      if (!Number.isSafeInteger(p) || BigInt(p) < MIN_PART)
        throw new AppError('VALIDATION_ERROR', 'Jeder Einsatz muss mindestens 0.10 DEMO betragen.');
      total += BigInt(p);
    }
    return total;
  }
}
