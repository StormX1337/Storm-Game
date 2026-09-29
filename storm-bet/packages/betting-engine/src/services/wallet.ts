import type { DemoWalletPolicy } from '@storm-bet/config';
import { moneyToNumber, type DbOrTx, type Prisma, type Tx } from '@storm-bet/database';
import { AppError, type TransactionType, type WalletDto } from '@storm-bet/types';

export interface WalletRow {
  id: string;
  userId: string;
  balance: bigint;
  reserved: bigint;
}

export function toWalletDto(row: { balance: bigint; reserved: bigint }): WalletDto {
  return {
    currency: 'DEMO',
    balance: moneyToNumber(row.balance),
    reserved: moneyToNumber(row.reserved),
    available: moneyToNumber(row.balance - row.reserved),
  };
}

interface RawWallet {
  id: string;
  user_id: string;
  balance: bigint;
  reserved: bigint;
}

const fromRaw = (r: RawWallet): WalletRow => ({
  id: r.id,
  userId: r.user_id,
  balance: r.balance,
  reserved: r.reserved,
});

/**
 * Locks the user's wallet row for the rest of the transaction. Every balance
 * change goes through a locked row and a conditional UPDATE, and the table's
 * CHECK constraints (balance ≥ 0, 0 ≤ reserved ≤ balance) are the last line.
 */
export async function lockWallet(tx: Tx, userId: string): Promise<WalletRow> {
  const rows = await tx.$queryRaw<RawWallet[]>`
    SELECT "id", "user_id", "balance", "reserved" FROM "wallets" WHERE "user_id" = ${userId}::uuid FOR UPDATE`;
  const row = rows[0];
  if (!row) throw new AppError('NOT_FOUND', 'Für dieses Konto existiert kein Wallet.');
  return fromRaw(row);
}

interface LedgerEntry {
  wallet: WalletRow;
  type: TransactionType;
  amount: bigint;
  reservedDelta: bigint;
  betId: string | null;
  casinoRoundId?: string | null;
  description: string;
  metadata?: Record<string, unknown>;
}

async function appendLedger(tx: Tx, entry: LedgerEntry): Promise<void> {
  await tx.transaction.create({
    data: {
      walletId: entry.wallet.id,
      userId: entry.wallet.userId,
      type: entry.type,
      amount: entry.amount,
      reservedDelta: entry.reservedDelta,
      balanceAfter: entry.wallet.balance,
      reservedAfter: entry.wallet.reserved,
      betId: entry.betId,
      casinoRoundId: entry.casinoRoundId ?? null,
      description: entry.description,
      metadata: (entry.metadata ?? {}) as Prisma.InputJsonValue,
    },
  });
}

/** Moves a stake from available to reserved. Fails without side effects if it does not fit. */
export async function reserveStake(
  tx: Tx,
  wallet: WalletRow,
  stake: bigint,
  betId: string,
  description: string,
  metadata?: Record<string, unknown>,
): Promise<WalletRow> {
  if (stake <= 0n) throw new AppError('VALIDATION_ERROR', 'Einsatz muss positiv sein.');
  const rows = await tx.$queryRaw<RawWallet[]>`
    UPDATE "wallets"
    SET "reserved" = "reserved" + ${stake}, "version" = "version" + 1, "updated_at" = now()
    WHERE "id" = ${wallet.id}::uuid AND "balance" - "reserved" >= ${stake}
    RETURNING "id", "user_id", "balance", "reserved"`;
  const row = rows[0];
  if (!row) {
    throw new AppError('INSUFFICIENT_BALANCE', undefined, {
      details: {
        available: moneyToNumber(wallet.balance - wallet.reserved),
        required: moneyToNumber(stake),
      },
    });
  }
  const updated = fromRaw(row);
  await appendLedger(tx, {
    wallet: updated,
    type: 'BET_PLACED',
    amount: 0n,
    reservedDelta: stake,
    betId,
    description,
    metadata,
  });
  return updated;
}

export type SettlementTransactionType = 'BET_WON' | 'BET_LOST' | 'BET_VOID' | 'BET_REFUND';

/**
 * Releases a reserved stake and books the result: the stake leaves the
 * balance and the payout (stake included, 0 for a loss) enters it.
 */
export async function settleStake(
  tx: Tx,
  userId: string,
  stake: bigint,
  payout: bigint,
  type: SettlementTransactionType,
  betId: string,
  description: string,
  metadata?: Record<string, unknown>,
): Promise<WalletRow> {
  const wallet = await lockWallet(tx, userId);
  const rows = await tx.$queryRaw<RawWallet[]>`
    UPDATE "wallets"
    SET "balance" = "balance" - ${stake} + ${payout},
        "reserved" = "reserved" - ${stake},
        "version" = "version" + 1,
        "updated_at" = now()
    WHERE "id" = ${wallet.id}::uuid AND "reserved" >= ${stake} AND "balance" - ${stake} + ${payout} >= 0
    RETURNING "id", "user_id", "balance", "reserved"`;
  const row = rows[0];
  if (!row) {
    // Reserved funds always cover open stakes; reaching this means the ledger
    // is inconsistent, and settling anyway would make it worse.
    throw new Error(`wallet ${wallet.id} cannot release stake ${stake} for bet ${betId}`);
  }
  const updated = fromRaw(row);
  await appendLedger(tx, {
    wallet: updated,
    type,
    amount: payout - stake,
    reservedDelta: -stake,
    betId,
    description,
    metadata,
  });
  return updated;
}

/** Credits play money. The only way funds enter the system. */
export async function creditDemo(
  tx: Tx,
  userId: string,
  amount: bigint,
  description: string,
  metadata?: Record<string, unknown>,
): Promise<WalletRow> {
  if (amount <= 0n) throw new AppError('VALIDATION_ERROR', 'Betrag muss positiv sein.');
  const wallet = await lockWallet(tx, userId);
  const rows = await tx.$queryRaw<RawWallet[]>`
    UPDATE "wallets"
    SET "balance" = "balance" + ${amount}, "version" = "version" + 1, "updated_at" = now()
    WHERE "id" = ${wallet.id}::uuid
    RETURNING "id", "user_id", "balance", "reserved"`;
  const updated = fromRaw(rows[0] as RawWallet);
  await appendLedger(tx, {
    wallet: updated,
    type: 'DEPOSIT_DEMO',
    amount,
    reservedDelta: 0n,
    betId: null,
    description,
    metadata,
  });
  return updated;
}

/** Creates the wallet of a new account and books the demo starting credit. */
export async function openWallet(
  tx: Tx,
  userId: string,
  startingBalance: bigint,
): Promise<WalletRow> {
  await tx.wallet.create({ data: { userId, currency: 'DEMO' } });
  if (startingBalance > 0n) {
    return creditDemo(tx, userId, startingBalance, 'Demo-Startguthaben', { reason: 'signup' });
  }
  return lockWallet(tx, userId);
}

export interface TopUpResult {
  wallet: WalletRow;
  credited: bigint;
}

/**
 * Tops up a nearly empty demo wallet. Limited by a threshold and a cooldown
 * so play money stays play money rather than an infinite tap.
 */
export async function topUpDemoWallet(
  tx: Tx,
  userId: string,
  policy: DemoWalletPolicy,
  now: Date,
): Promise<TopUpResult> {
  const wallet = await lockWallet(tx, userId);
  const meta = await tx.wallet.findUniqueOrThrow({
    where: { id: wallet.id },
    select: { lastTopUpAt: true },
  });
  const available = wallet.balance - wallet.reserved;
  if (available >= BigInt(policy.topUpThreshold)) {
    throw new AppError(
      'CONFLICT',
      `Eine Aufladung ist erst möglich, wenn weniger als ${(policy.topUpThreshold / 100).toFixed(2)} DEMO verfügbar sind.`,
    );
  }
  const nextAllowed = meta.lastTopUpAt
    ? meta.lastTopUpAt.getTime() + policy.topUpCooldownHours * 3_600_000
    : 0;
  if (nextAllowed > now.getTime()) {
    throw new AppError(
      'RATE_LIMITED',
      'Du kannst dein Demo-Guthaben nur einmal pro Tag aufladen.',
      {
        retryAfter: Math.ceil((nextAllowed - now.getTime()) / 1000),
      },
    );
  }
  const credited = BigInt(policy.topUpAmount);
  const updated = await creditDemo(tx, userId, credited, 'Demo-Guthaben aufgeladen', {
    reason: 'top-up',
  });
  await tx.wallet.update({ where: { id: wallet.id }, data: { lastTopUpAt: now } });
  return { wallet: updated, credited };
}

export async function getWallet(db: DbOrTx, userId: string): Promise<WalletDto> {
  const wallet = await db.wallet.findUnique({
    where: { userId },
    select: { balance: true, reserved: true },
  });
  if (!wallet) throw new AppError('NOT_FOUND', 'Für dieses Konto existiert kein Wallet.');
  return toWalletDto(wallet);
}

/**
 * Casino stake: leaves the balance immediately (a round is decided at once or
 * holds the stake itself). Fails without side effects if it does not fit.
 * The caller holds the wallet lock (lockWallet) in the same transaction.
 */
export async function debitCasino(
  tx: Tx,
  wallet: WalletRow,
  amount: bigint,
  casinoRoundId: string,
  description: string,
): Promise<WalletRow> {
  if (amount <= 0n) throw new AppError('VALIDATION_ERROR', 'Einsatz muss positiv sein.');
  const rows = await tx.$queryRaw<RawWallet[]>`
    UPDATE "wallets"
    SET "balance" = "balance" - ${amount}, "version" = "version" + 1, "updated_at" = now()
    WHERE "id" = ${wallet.id}::uuid AND "balance" - "reserved" >= ${amount}
    RETURNING "id", "user_id", "balance", "reserved"`;
  if (!rows[0]) {
    throw new AppError('INSUFFICIENT_BALANCE', undefined, {
      details: {
        available: moneyToNumber(wallet.balance - wallet.reserved),
        required: moneyToNumber(amount),
      },
    });
  }
  const updated = fromRaw(rows[0]);
  await appendLedger(tx, {
    wallet: updated,
    type: 'CASINO_BET',
    amount: -amount,
    reservedDelta: 0n,
    betId: null,
    casinoRoundId,
    description,
  });
  return updated;
}

/** Casino win or refund. The database allows one per round, matching its status. */
export async function creditCasino(
  tx: Tx,
  wallet: WalletRow,
  type: 'CASINO_WIN' | 'CASINO_REFUND',
  amount: bigint,
  casinoRoundId: string,
  description: string,
): Promise<WalletRow> {
  if (amount <= 0n) return wallet;
  const rows = await tx.$queryRaw<RawWallet[]>`
    UPDATE "wallets"
    SET "balance" = "balance" + ${amount}, "version" = "version" + 1, "updated_at" = now()
    WHERE "id" = ${wallet.id}::uuid
    RETURNING "id", "user_id", "balance", "reserved"`;
  const updated = fromRaw(rows[0] as RawWallet);
  await appendLedger(tx, {
    wallet: updated,
    type,
    amount,
    reservedDelta: 0n,
    betId: null,
    casinoRoundId,
    description,
  });
  return updated;
}
