import { randomUUID } from 'node:crypto';
import { Prisma } from '@storm-bet/database';
import { createRedis } from '@storm-bet/redis';
import { AppError } from '@storm-bet/types';
import { afterAll, describe, expect, it } from 'vitest';
import { BetPlacementService, CashoutService, SettlementService } from '../src';
import { createEvent, createUser, db, finishEvent, limits, wallet } from './fixtures';

const redis = createRedis(process.env.REDIS_URL!);
const placement = new BetPlacementService({ db, redis, limits, requireEmailVerification: false });
const settlement = new SettlementService({ db, redis });

afterAll(async () => {
  await db.$disconnect();
  await redis.quit();
});

const single = (
  selectionId: string,
  odds: number,
  stake: number,
  policy: 'REJECT' | 'ACCEPT_HIGHER' = 'REJECT',
) => ({
  idempotencyKey: randomUUID(),
  mode: 'COMBO' as const,
  stake,
  oddsChangePolicy: policy,
  selections: [{ selectionId, odds }],
});

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, `expected ${code}`).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  return error as AppError;
}

describe('bet placement', () => {
  it('places a double with the documented example and books the reservation', async () => {
    const user = await createUser(100_000n);
    const a = await createEvent({ odds: [1.65, 3.5, 5] });
    const b = await createEvent({ odds: [1.8, 3.5, 4] });
    const result = await placement.place(user.id, {
      idempotencyKey: randomUUID(),
      mode: 'COMBO',
      stake: 1_000,
      oddsChangePolicy: 'REJECT',
      selections: [
        { selectionId: a.home.id, odds: 1.65 },
        { selectionId: b.home.id, odds: 1.8 },
      ],
    });
    expect(result.bets).toHaveLength(1);
    const bet = result.bets[0]!;
    expect(bet.type).toBe('DOUBLE');
    expect(bet.totalOdds).toBe(2.97);
    expect(bet.potentialReturn).toBe(2_970);
    expect(bet.selections.every((s) => s.snapshot?.odds === s.odds)).toBe(true);
    expect(result.wallet).toEqual({
      currency: 'DEMO',
      balance: 100_000,
      reserved: 1_000,
      available: 99_000,
    });

    const ledger = await db.transaction.findMany({ where: { betId: bet.id } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ type: 'BET_PLACED', amount: 0n, reservedDelta: 1_000n });
    const audit = await db.auditLog.findFirst({
      where: { action: 'bet.placed', targetId: bet.id },
    });
    expect(audit?.actorId).toBe(user.id);
  });

  it('places singles as separate bets from one slip', async () => {
    const user = await createUser();
    const a = await createEvent();
    const b = await createEvent();
    const result = await placement.place(user.id, {
      idempotencyKey: randomUUID(),
      mode: 'SINGLES',
      oddsChangePolicy: 'REJECT',
      selections: [
        { selectionId: a.home.id, odds: 1.65, stake: 500 },
        { selectionId: b.away.id, odds: 5, stake: 200 },
      ],
    });
    expect(result.bets.map((x) => x.type)).toEqual(['SINGLE', 'SINGLE']);
    expect(result.wallet.reserved).toBe(700);
  });

  it('Bet darf nicht doppelt platziert werden — concurrent retries with one key create one bet', async () => {
    const user = await createUser(10_000n);
    const { home } = await createEvent();
    const request = single(home.id, 1.65, 1_000);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => placement.place(user.id, request)),
    );
    const fulfilled = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    expect(fulfilled.length).toBe(6);
    expect(new Set(fulfilled.map((r) => r.bets[0]!.id)).size).toBe(1);
    expect(fulfilled.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await db.bet.count({ where: { userId: user.id } })).toBe(1);
    expect((await wallet(user.id)).reserved).toBe(1_000n);
  });

  it('refuses to reuse an idempotency key for a different slip', async () => {
    const user = await createUser();
    const { home, away } = await createEvent();
    const request = single(home.id, 1.65, 1_000);
    await placement.place(user.id, request);
    await expectCode(
      placement.place(user.id, { ...request, selections: [{ selectionId: away.id, odds: 5 }] }),
      'CONFLICT',
    );
  });

  it('rejects changed odds and reports the current price', async () => {
    const user = await createUser();
    const { home } = await createEvent();
    await db.selection.update({
      where: { id: home.id },
      data: { odds: new Prisma.Decimal('1.600'), oddsVersion: { increment: 1 } },
    });
    const error = await expectCode(
      placement.place(user.id, single(home.id, 1.65, 1_000)),
      'ODDS_CHANGED',
    );
    expect(error.message).toBe('Quote wurde aktualisiert.');
    expect(error.details).toMatchObject({ issues: [{ currentOdds: 1.6, requestedOdds: 1.65 }] });
    expect(await db.bet.count({ where: { userId: user.id } })).toBe(0);
  });

  it('Quote wird während des Place-Vorgangs geändert — the bet never uses a stale price', async () => {
    const user = await createUser();
    const { home } = await createEvent();

    // A concurrent odds update holds the selection row while the bet is placed.
    let commitOddsChange!: () => void;
    const released = new Promise<void>((resolve) => (commitOddsChange = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const oddsChange = db.$transaction(
      async (tx) => {
        await tx.$executeRaw`UPDATE "selections" SET "odds" = 1.55, "odds_version" = "odds_version" + 1 WHERE "id" = ${home.id}::uuid`;
        locked();
        await released;
      },
      { timeout: 20_000 },
    );
    await lockTaken;

    const placing = placement.place(user.id, single(home.id, 1.65, 1_000));
    // Give the placement time to block on the row lock, then commit the change.
    await new Promise((r) => setTimeout(r, 300));
    commitOddsChange();
    await oddsChange;

    await expectCode(placing, 'ODDS_CHANGED');
    expect(await db.bet.count({ where: { userId: user.id } })).toBe(0);
    expect((await wallet(user.id)).reserved).toBe(0n);
  });

  it('with ACCEPT_HIGHER takes a lengthened price, but never a shortened one', async () => {
    const user = await createUser();
    const { home, away } = await createEvent();
    await db.selection.update({
      where: { id: home.id },
      data: { odds: new Prisma.Decimal('1.700') },
    });
    const placed = await placement.place(user.id, single(home.id, 1.65, 1_000, 'ACCEPT_HIGHER'));
    expect(placed.bets[0]!.totalOdds).toBe(1.7);
    expect(placed.bets[0]!.selections[0]!.snapshot!.odds).toBe(1.7);

    await db.selection.update({
      where: { id: away.id },
      data: { odds: new Prisma.Decimal('4.900') },
    });
    await expectCode(
      placement.place(user.id, single(away.id, 5, 1_000, 'ACCEPT_HIGHER')),
      'ODDS_CHANGED',
    );
  });

  it('rejects suspended markets and closed events', async () => {
    const user = await createUser();
    const a = await createEvent();
    await db.market.update({ where: { id: a.market.id }, data: { status: 'SUSPENDED' } });
    await expectCode(placement.place(user.id, single(a.home.id, 1.65, 1_000)), 'MARKET_SUSPENDED');

    const b = await createEvent();
    await db.event.update({ where: { id: b.event.id }, data: { status: 'FINISHED' } });
    await expectCode(placement.place(user.id, single(b.home.id, 1.65, 1_000)), 'EVENT_CLOSED');
  });

  it('Wallet darf niemals negativ werden — concurrent bets cannot overspend', async () => {
    const user = await createUser(5_000n);
    const { home } = await createEvent();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => placement.place(user.id, single(home.id, 1.65, 1_000))),
    );
    const placed = results.filter((r) => r.status === 'fulfilled').length;
    expect(placed).toBe(5);
    for (const r of results) {
      if (r.status === 'rejected') {
        expect(['INSUFFICIENT_BALANCE', 'CONFLICT']).toContain((r.reason as AppError).code);
      }
    }
    const w = await wallet(user.id);
    expect(w.balance - w.reserved).toBe(0n);
    expect(w.reserved).toBe(5_000n);
  });

  it('the database itself refuses a negative wallet', async () => {
    const user = await createUser(1_000n);
    await expect(
      db.$executeRaw`UPDATE "wallets" SET "reserved" = "balance" + 1 WHERE "user_id" = ${user.id}::uuid`,
    ).rejects.toThrow(/wallets_reserved_within_balance/);
    await expect(
      db.$executeRaw`UPDATE "wallets" SET "balance" = -1 WHERE "user_id" = ${user.id}::uuid`,
    ).rejects.toThrow();
  });

  it('enforces responsible-gaming limits and self-exclusion', async () => {
    const user = await createUser();
    const { home } = await createEvent();
    await db.userLimit.create({ data: { userId: user.id, type: 'STAKE_DAILY', amount: 1_500n } });
    await placement.place(user.id, single(home.id, 1.65, 1_000));
    await expectCode(placement.place(user.id, single(home.id, 1.65, 1_000)), 'BET_LIMIT_EXCEEDED');

    await db.selfExclusion.create({
      data: { userId: user.id, endsAt: new Date(Date.now() + 86_400_000) },
    });
    await expectCode(placement.place(user.id, single(home.id, 1.65, 100)), 'FORBIDDEN');
  });

  it('blocks locked accounts', async () => {
    const user = await createUser(10_000n, { status: 'LOCKED' });
    const { home } = await createEvent();
    await expectCode(placement.place(user.id, single(home.id, 1.65, 100)), 'FORBIDDEN');
  });
});

describe('settlement', () => {
  it('pays a winning bet once and releases a losing stake', async () => {
    const winner = await createUser(10_000n);
    const loser = await createUser(10_000n);
    const { event, home, away } = await createEvent({ odds: [2, 3.4, 3.8] });
    const won = await placement.place(winner.id, single(home.id, 2, 1_000));
    await placement.place(loser.id, single(away.id, 3.8, 1_000));

    await finishEvent(event.id, 2, 0);
    const report = await settlement.settleEvent(event.id);
    expect(report.completed).toBe(true);
    expect(report.settledBets).toBe(2);

    expect(await wallet(winner.id)).toMatchObject({ balance: 11_000n, reserved: 0n });
    expect(await wallet(loser.id)).toMatchObject({ balance: 9_000n, reserved: 0n });
    const bet = await db.bet.findUniqueOrThrow({ where: { id: won.bets[0]!.id } });
    expect(bet).toMatchObject({ status: 'WON', payout: 2_000n });
  });

  it('Settlement darf nicht doppelt auszahlen — concurrent and repeated runs pay once', async () => {
    const user = await createUser(10_000n);
    const { event, home } = await createEvent({ odds: [2, 3.4, 3.8] });
    const placed = await placement.place(user.id, single(home.id, 2, 1_000));
    const betId = placed.bets[0]!.id;
    await finishEvent(event.id, 1, 0);

    await Promise.all([
      settlement.settleEvent(event.id),
      settlement.settleEvent(event.id),
      settlement.settleBet(betId),
      settlement.settleBet(betId),
    ]);
    await settlement.settleEvent(event.id);
    await settlement.settleDueEvents();

    const payouts = await db.transaction.findMany({
      where: { betId, type: { in: ['BET_WON', 'BET_LOST', 'BET_VOID', 'BET_REFUND'] } },
    });
    expect(payouts).toHaveLength(1);
    expect(await wallet(user.id)).toMatchObject({ balance: 11_000n, reserved: 0n });

    // Even a hand-written second payout is refused by the ledger itself.
    const w = await wallet(user.id);
    await expect(
      db.transaction.create({
        data: {
          walletId: w.id,
          userId: user.id,
          type: 'BET_VOID',
          amount: 1_000n,
          reservedDelta: 0n,
          balanceAfter: 12_000n,
          reservedAfter: 0n,
          betId,
          description: 'duplicate',
        },
      }),
    ).rejects.toThrow();
    // And the settled bet can no longer be modified.
    await expect(db.bet.update({ where: { id: betId }, data: { status: 'LOST' } })).rejects.toThrow(
      /settled/,
    );
  });

  it('settles accumulators leg by leg and voids cancelled events', async () => {
    const user = await createUser(10_000n);
    const a = await createEvent({ odds: [2, 3, 4] });
    const b = await createEvent({ odds: [1.5, 3, 4] });
    const placed = await placement.place(user.id, {
      idempotencyKey: randomUUID(),
      mode: 'COMBO',
      stake: 1_000,
      oddsChangePolicy: 'REJECT',
      selections: [
        { selectionId: a.home.id, odds: 2 },
        { selectionId: b.home.id, odds: 1.5 },
      ],
    });
    const betId = placed.bets[0]!.id;

    await finishEvent(a.event.id, 1, 0);
    await settlement.settleEvent(a.event.id);
    expect((await db.bet.findUniqueOrThrow({ where: { id: betId } })).status).toBe('PENDING');

    await db.event.update({ where: { id: b.event.id }, data: { status: 'CANCELLED' } });
    await settlement.settleEvent(b.event.id);
    const bet = await db.bet.findUniqueOrThrow({ where: { id: betId } });
    // Void leg counts at 1.00: 10.00 × 2.00 = 20.00
    expect(bet).toMatchObject({ status: 'WON', payout: 2_000n });
  });

  it('refunds an open bet with an audit trail and never touches a settled one', async () => {
    const user = await createUser(10_000n);
    const { event, home } = await createEvent();
    const placed = await placement.place(user.id, single(home.id, 1.65, 1_000));
    const betId = placed.bets[0]!.id;
    const actor = { id: null, role: 'ADMIN' as const };
    await settlement.refundBet(betId, actor, 'Test-Storno');
    expect(await wallet(user.id)).toMatchObject({ balance: 10_000n, reserved: 0n });
    expect(await db.auditLog.count({ where: { action: 'bet.refunded', targetId: betId } })).toBe(1);
    await expectCode(settlement.refundBet(betId, actor, 'nochmal'), 'CONFLICT');

    await finishEvent(event.id, 0, 3);
    await settlement.settleEvent(event.id);
    expect((await db.bet.findUniqueOrThrow({ where: { id: betId } })).status).toBe('REFUNDED');
  });

  it('keeps the audit log append-only', async () => {
    const log = await db.auditLog.findFirstOrThrow();
    await expect(db.auditLog.delete({ where: { id: log.id } })).rejects.toThrow(/append-only/);
    await expect(
      db.auditLog.update({ where: { id: log.id }, data: { action: 'x' } }),
    ).rejects.toThrow(/append-only/);
  });
});

describe('Bet Builder', () => {
  /** A match with 1X2 and over/under 2.5 — enough for the model. */
  async function match() {
    const created = await createEvent({ odds: [1.7, 3.9, 4.8] });
    const totals = await db.market.create({
      data: {
        eventId: created.event.id,
        key: 'TOTAL_GOALS:2.5',
        type: 'TOTAL_GOALS',
        name: 'Tore Über/Unter 2.5',
        line: new Prisma.Decimal(2.5),
        selections: {
          create: (['OVER', 'UNDER'] as const).map((outcome, i) => ({
            key: outcome,
            name: outcome,
            outcome,
            odds: new Prisma.Decimal(i === 0 ? 1.8 : 2.0),
            sortOrder: i,
          })),
        },
      },
      include: { selections: { orderBy: { sortOrder: 'asc' } } },
    });
    return { ...created, over: totals.selections[0]!, under: totals.selections[1]! };
  }

  const builder = (selections: string[], stake: number, odds: number) => ({
    idempotencyKey: randomUUID(),
    mode: 'BUILDER' as const,
    stake,
    odds,
    oddsChangePolicy: 'REJECT' as const,
    selections: selections.map((selectionId) => ({ selectionId })),
  });

  it('quotes, places and settles legs of one match at one price', async () => {
    const user = await createUser(100_000n);
    const m = await match();
    const quote = await placement.validate(user.id, {
      mode: 'BUILDER',
      stake: 1_000,
      oddsChangePolicy: 'REJECT',
      selections: [{ selectionId: m.home.id }, { selectionId: m.over.id }],
    });
    expect(quote.issues).toEqual([]);
    expect(quote.quote.betType).toBe('BET_BUILDER');
    const odds = quote.quote.totalOdds;
    // Correlated legs: shorter than the legs multiplied, still a real price.
    expect(odds).toBeGreaterThan(1.8);
    expect(odds).toBeLessThanOrEqual(3.06);

    const placed = await placement.place(user.id, builder([m.home.id, m.over.id], 1_000, odds));
    const bet = placed.bets[0]!;
    expect(bet).toMatchObject({ type: 'BET_BUILDER', totalOdds: odds, stake: 1_000 });
    expect(bet.selections).toHaveLength(2);

    await finishEvent(m.event.id, 3, 1);
    await settlement.settleEvent(m.event.id);
    const settled = await db.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(settled.status).toBe('WON');
    expect(settled.payout).toBe(BigInt(Math.round(odds * 1_000)));
  });

  it('rejects a moved price and legs from different matches', async () => {
    const user = await createUser(100_000n);
    const m = await match();
    const other = await createEvent();
    await expectCode(
      placement.place(user.id, builder([m.home.id, m.over.id], 1_000, 9.99)),
      'ODDS_CHANGED',
    );
    const error = await expectCode(
      placement.place(user.id, builder([m.home.id, other.home.id], 1_000, 3)),
      'VALIDATION_ERROR',
    );
    expect(error.message).toContain('demselben Spiel');
    expect((await wallet(user.id)).reserved).toBe(0n);
  });

  it('voids the whole bet when one leg is void', async () => {
    const user = await createUser(100_000n);
    const m = await match();
    const dnb = await db.market.create({
      data: {
        eventId: m.event.id,
        key: 'DRAW_NO_BET',
        type: 'DRAW_NO_BET',
        name: 'Unentschieden, keine Wette',
        selections: {
          create: (['HOME', 'AWAY'] as const).map((outcome, i) => ({
            key: outcome,
            name: outcome,
            outcome,
            odds: new Prisma.Decimal(i === 0 ? 1.3 : 3.4),
            sortOrder: i,
          })),
        },
      },
      include: { selections: { orderBy: { sortOrder: 'asc' } } },
    });
    const quote = await placement.validate(user.id, {
      mode: 'BUILDER',
      stake: 500,
      oddsChangePolicy: 'REJECT',
      selections: [{ selectionId: dnb.selections[0]!.id }, { selectionId: m.over.id }],
    });
    const placed = await placement.place(
      user.id,
      builder([dnb.selections[0]!.id, m.over.id], 500, quote.quote.totalOdds),
    );
    await finishEvent(m.event.id, 2, 2);
    await settlement.settleEvent(m.event.id);
    const bet = await db.bet.findUniqueOrThrow({ where: { id: placed.bets[0]!.id } });
    expect(bet).toMatchObject({ status: 'VOID', payout: 500n });
    expect((await wallet(user.id)).balance).toBe(100_000n);
  });
});

describe('cashout', () => {
  const cashout = new CashoutService({ db, redis, marginPct: 5 });

  it('pays the value at current prices once, books it and ends the bet', async () => {
    const user = await createUser(100_000n);
    const m = await createEvent({ odds: [2.0, 3.4, 3.8] });
    const placed = await placement.place(user.id, single(m.home.id, 2.0, 1_000));
    const betId = placed.bets[0]!.id;
    // The home side shortened: the bet is worth more now.
    await db.selection.update({
      where: { id: m.home.id },
      data: { odds: new Prisma.Decimal(1.6) },
    });

    const [quote] = await cashout.quotes(user.id, [betId]);
    // 10,00 × 2.00 / 1.60 × 0.95 = 11,87
    expect(quote).toMatchObject({ betId, available: true, amount: 1_187, reason: null });

    await expectCode(cashout.cashOut(user.id, betId, 1_300n), 'ODDS_CHANGED');
    const result = await cashout.cashOut(user.id, betId, 1_187n);
    expect(result.bet).toMatchObject({ status: 'CASHED_OUT', payout: 1_187 });
    expect(result.wallet).toMatchObject({ balance: 100_187, reserved: 0 });
    // A repeat answers with the result and pays nothing twice.
    expect((await cashout.cashOut(user.id, betId, 1_187n)).wallet.balance).toBe(100_187);
    const ledger = await db.transaction.findMany({ where: { betId, type: 'CASH_OUT' } });
    expect(ledger).toHaveLength(1);
    expect(await db.auditLog.count({ where: { action: 'bet.cashed_out', targetId: betId } })).toBe(
      1,
    );

    // The later result changes nothing.
    await finishEvent(m.event.id, 0, 1);
    await settlement.settleEvent(m.event.id);
    expect((await db.bet.findUniqueOrThrow({ where: { id: betId } })).status).toBe('CASHED_OUT');
    expect((await wallet(user.id)).balance).toBe(100_187n);
  });

  it('closes part of the stake, then settles only the rest', async () => {
    const user = await createUser(100_000n);
    const m = await createEvent({ odds: [2.0, 3.4, 3.8] });
    const betId = (await placement.place(user.id, single(m.home.id, 2.0, 1_000))).bets[0]!.id;
    await db.selection.update({
      where: { id: m.home.id },
      data: { odds: new Prisma.Decimal(1.6) },
    });
    // 40 % of the stake at a full value of 11,87 → 4,74.
    const partial = await cashout.cashOut(user.id, betId, 474n, { part: 400n });
    expect(partial.bet).toMatchObject({
      status: 'PENDING',
      remainingStake: 600,
      partialCashouts: [{ stake: 400, amount: 474 }],
    });
    expect(partial.wallet).toMatchObject({ balance: 100_074, reserved: 600 });
    await expectCode(cashout.cashOut(user.id, betId, 1n, { part: 600n }), 'VALIDATION_ERROR');

    await finishEvent(m.event.id, 1, 0);
    await settlement.settleEvent(m.event.id);
    const bet = await db.bet.findUniqueOrThrow({ where: { id: betId } });
    expect(bet).toMatchObject({ status: 'WON', payout: 1_200n });
    expect(await wallet(user.id)).toMatchObject({ balance: 100_674n, reserved: 0n });
  });

  it('auto-cashout pays once the value reaches the target', async () => {
    const user = await createUser(100_000n);
    const m = await createEvent({ odds: [2.0, 3.4, 3.8] });
    const betId = (await placement.place(user.id, single(m.home.id, 2.0, 1_000))).bets[0]!.id;
    await cashout.setAutoCashout(user.id, betId, 1_150n);
    await cashout.runAutoCashouts();
    expect((await db.bet.findUniqueOrThrow({ where: { id: betId } })).status).toBe('PENDING');
    await db.selection.update({
      where: { id: m.home.id },
      data: { odds: new Prisma.Decimal(1.6) },
    });
    await cashout.runAutoCashouts();
    const bet = await db.bet.findUniqueOrThrow({ where: { id: betId } });
    expect(bet).toMatchObject({ status: 'CASHED_OUT', payout: 1_187n, autoCashoutAmount: null });
  });

  it('offers nothing for suspended markets, other players or lost legs', async () => {
    const user = await createUser(100_000n);
    const other = await createUser(100_000n);
    const m = await createEvent();
    const betId = (await placement.place(user.id, single(m.home.id, 1.65, 1_000))).bets[0]!.id;
    expect(await cashout.quotes(other.id, [betId])).toEqual([]);
    await expectCode(cashout.cashOut(other.id, betId, 100n), 'NOT_FOUND');
    await db.market.update({ where: { id: m.market.id }, data: { status: 'SUSPENDED' } });
    const [quote] = await cashout.quotes(user.id, [betId]);
    expect(quote).toMatchObject({ available: false, amount: null });
    await expectCode(cashout.cashOut(user.id, betId, 100n), 'MARKET_SUSPENDED');
    expect((await wallet(user.id)).reserved).toBe(1_000n);
  });
});

describe('due settlement', () => {
  it('retries an incompletely settled event later instead of blocking newer ones', async () => {
    // Newest first: a start far ahead puts it at the front of the queue.
    const m = await createEvent({ startInMs: 10 * 365 * 24 * 3_600_000 });
    // A market the recorded result cannot decide: no card figures are recorded.
    await db.market.create({
      data: {
        eventId: m.event.id,
        key: 'TOTAL_CARDS:4.5',
        type: 'TOTAL_CARDS',
        name: 'Karten Über/Unter 4.5',
        line: new Prisma.Decimal(4.5),
        selections: {
          create: (['OVER', 'UNDER'] as const).map((outcome, i) => ({
            key: outcome,
            name: outcome,
            outcome,
            odds: new Prisma.Decimal(1.9),
            sortOrder: i,
          })),
        },
      },
    });
    await finishEvent(m.event.id, 1, 0);
    await db.event.update({
      where: { id: m.event.id },
      data: { statistics: { sport: 'football', goals: { home: 1, away: 0 } } },
    });
    const report = (await settlement.settleDueEvents()).find((r) => r.eventId === m.event.id);
    expect(report?.completed).toBe(false);
    const again = await settlement.settleDueEvents();
    expect(again.some((r) => r.eventId === m.event.id)).toBe(false);
  });
});

describe('early payout', () => {
  it('wins a pre-match 1X2 pick at a two-goal lead, whatever the final score', async () => {
    const user = await createUser(100_000n);
    const m = await createEvent({ odds: [2.0, 3.4, 3.8] });
    const early = (await placement.place(user.id, single(m.home.id, 2.0, 1_000))).bets[0]!.id;
    // Kick-off; a pick taken in play at 1:0 does not qualify.
    await db.event.update({
      where: { id: m.event.id },
      data: { status: 'LIVE', homeScore: 1, awayScore: 0 },
    });
    const late = (await placement.place(user.id, single(m.home.id, 2.0, 500))).bets[0]!.id;
    await db.event.update({ where: { id: m.event.id }, data: { homeScore: 2 } });
    expect(await settlement.applyEarlyPayouts()).toBeGreaterThanOrEqual(1);
    expect(await db.bet.findUniqueOrThrow({ where: { id: early } })).toMatchObject({
      status: 'WON',
      payout: 2_000n,
    });
    expect((await db.bet.findUniqueOrThrow({ where: { id: late } })).status).toBe('PENDING');
    const leg = await db.betSelection.findFirstOrThrow({ where: { betId: early } });
    expect(leg).toMatchObject({ result: 'WON', earlyPayout: true });

    // The away side comes back to win: the early win stands, the late pick loses.
    await finishEvent(m.event.id, 2, 3);
    await settlement.settleEvent(m.event.id);
    expect((await db.bet.findUniqueOrThrow({ where: { id: early } })).status).toBe('WON');
    expect((await db.bet.findUniqueOrThrow({ where: { id: late } })).status).toBe('LOST');
  });
});
