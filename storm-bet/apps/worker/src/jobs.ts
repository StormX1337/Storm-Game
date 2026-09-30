import type { CashoutService, SettlementService } from '@storm-bet/betting-engine';
import type { CasinoService } from '@storm-bet/casino';
import type { PrismaClient } from '@storm-bet/database';
import type { OddsSyncService } from '@storm-bet/odds-engine';
import { acquireLock, type Redis } from '@storm-bet/redis';
import type { Logger } from 'pino';

export interface JobDeps {
  db: PrismaClient;
  redis: Redis;
  sync: OddsSyncService;
  settlement: SettlementService;
  cashout: CashoutService;
  casino: CasinoService;
  logger: Logger;
}

/**
 * Runs `fn` only if no other worker instance is doing the same job right now.
 * Scaling the worker horizontally therefore never duplicates a sync or a
 * settlement run (which would be harmless, but wasteful).
 */
async function exclusive<T>(
  redis: Redis,
  name: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T | 'skipped'> {
  const lock = await acquireLock(redis, `job:${name}`, { ttlMs });
  if (!lock) return 'skipped';
  try {
    return await fn();
  } finally {
    await lock.release().catch(() => undefined);
  }
}

export type JobName =
  | 'catalog-sync'
  | 'live-sync'
  | 'prematch-sync'
  | 'settle-due'
  | 'auto-cashout'
  | 'early-payout'
  | 'cleanup';

export function createJobHandlers(deps: JobDeps): Record<JobName, () => Promise<unknown>> {
  const { db, redis, sync, settlement, cashout, casino, logger } = deps;
  return {
    'catalog-sync': () =>
      exclusive(redis, 'catalog-sync', 120_000, async () => {
        const report = await sync.syncCatalog();
        logger.info({ report }, 'catalog synced');
        return report;
      }),
    'live-sync': () =>
      exclusive(redis, 'live-sync', 30_000, async () => {
        const report = await sync.syncLive();
        if (report.updatedEvents || report.updatedSelections)
          logger.debug({ report }, 'live synced');
        return report;
      }),
    'prematch-sync': () =>
      exclusive(redis, 'prematch-sync', 60_000, async () => {
        const report = await sync.syncPrematch(6);
        logger.debug({ report }, 'pre-match odds synced');
        return report;
      }),
    'settle-due': () =>
      exclusive(redis, 'settle-due', 120_000, async () => {
        const reports = await settlement.settleDueEvents();
        if (reports.length)
          logger.info(
            { events: reports.length, bets: reports.reduce((s, r) => s + r.settledBets, 0) },
            'settlement run',
          );
        return reports;
      }),
    'early-payout': () =>
      exclusive(redis, 'early-payout', 60_000, async () => {
        const count = await settlement.applyEarlyPayouts();
        if (count) logger.info({ count }, 'early payouts');
        return count;
      }),
    'auto-cashout': () =>
      exclusive(redis, 'auto-cashout', 60_000, async () => {
        const count = await cashout.runAutoCashouts();
        if (count) logger.info({ count }, 'auto-cashouts paid');
        return count;
      }),
    cleanup: () =>
      exclusive(redis, 'cleanup', 300_000, async () => {
        const cutoff = new Date(Date.now() - 30 * 24 * 3_600_000);
        const sessions = await db.session.deleteMany({
          where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] },
        });
        const tokens = await db.authToken.deleteMany({
          where: { expiresAt: { lt: new Date(Date.now() - 24 * 3_600_000) } },
        });
        // Idle casino sessions close; an unfinished blackjack hand is stood.
        const casinoSessions = await casino.expireIdleSessions(30 * 60_000);
        logger.info({ sessions: sessions.count, tokens: tokens.count, casinoSessions }, 'cleanup');
        return { sessions: sessions.count, tokens: tokens.count, casinoSessions };
      }),
  };
}
