import { createServer } from 'node:http';
import { BoostService, CashoutService, SettlementService } from '@storm-bet/betting-engine';
import { CasinoService, MockCasinoProvider, syncCasinoCatalog } from '@storm-bet/casino';
import { parseEnv, QUEUES, REDIS_KEYS, workerEnvSchema } from '@storm-bet/config';
import { createPrismaClient } from '@storm-bet/database';
import { OddsSyncService, retireInactiveProviderEvents } from '@storm-bet/odds-engine';
import { createRedis } from '@storm-bet/redis';
import { Queue, Worker } from 'bullmq';
import { createJobHandlers, type JobName } from './jobs';
import { createLogger } from './logger';
import { createProvider } from './provider';

const BULL_PREFIX = 'sb:bull';

async function main(): Promise<void> {
  const env = parseEnv(workerEnvSchema);
  const logger = createLogger(
    env.LOG_LEVEL,
    'worker',
    env.NODE_ENV === 'development' && process.stdout.isTTY,
  );
  const db = createPrismaClient();
  const redis = createRedis(env.REDIS_URL);
  const bullConnection = () => createRedis(env.REDIS_URL, { maxRetriesPerRequest: null });

  const provider = createProvider(env, redis);
  const sync = new OddsSyncService(db, redis, provider, {
    // Real fixtures are days apart; the simulator fills every hour.
    horizonHours: env.ODDS_PROVIDER === 'mock' ? 36 : 7 * 24,
    lookbackHours: 6,
    logger,
  });
  const settlement = new SettlementService({ db, redis, logger });
  const boosts = new BoostService({ db });
  const cashout = new CashoutService({ db, redis, marginPct: env.CASHOUT_MARGIN_PCT });
  const retired = await retireInactiveProviderEvents(db, provider.key);
  if (retired.events)
    logger.warn(retired, 'open events of the previous odds feed cancelled; their bets are voided');
  const casinoProvider = new MockCasinoProvider();
  const casino = new CasinoService({ db, redis, providers: [casinoProvider] });
  const casinoCatalog = await syncCasinoCatalog(db, casinoProvider);
  logger.info(casinoCatalog, 'casino catalogue synced');
  const handlers = createJobHandlers({
    db,
    redis,
    sync,
    settlement,
    cashout,
    boosts,
    casino,
    logger,
  });

  const schedule: { queue: string; job: JobName; every: number }[] = [
    { queue: QUEUES.oddsSync, job: 'catalog-sync', every: env.CATALOG_SYNC_INTERVAL_MS },
    { queue: QUEUES.oddsSync, job: 'live-sync', every: env.LIVE_SYNC_INTERVAL_MS },
    { queue: QUEUES.oddsSync, job: 'prematch-sync', every: env.PREMATCH_ODDS_INTERVAL_MS },
    { queue: QUEUES.settlement, job: 'settle-due', every: env.SETTLEMENT_INTERVAL_MS },
    // Auto-cashout follows the live prices.
    { queue: QUEUES.settlement, job: 'auto-cashout', every: env.LIVE_SYNC_INTERVAL_MS },
    { queue: QUEUES.settlement, job: 'early-payout', every: env.LIVE_SYNC_INTERVAL_MS },
    { queue: QUEUES.maintenance, job: 'boosts', every: 10 * 60_000 },
    { queue: QUEUES.maintenance, job: 'cleanup', every: 3_600_000 },
  ];

  const queues = new Map<string, Queue>();
  for (const name of Object.values(QUEUES)) {
    queues.set(name, new Queue(name, { connection: bullConnection(), prefix: BULL_PREFIX }));
  }
  for (const entry of schedule) {
    await queues.get(entry.queue)!.upsertJobScheduler(
      entry.job,
      { every: entry.every },
      {
        name: entry.job,
        opts: { removeOnComplete: { count: 50 }, removeOnFail: { count: 200 } },
      },
    );
  }

  let lastSuccess = Date.now();
  const workers = [...queues.keys()].map(
    (name) =>
      new Worker(
        name,
        async (job) => {
          const handler = handlers[job.name as JobName];
          if (!handler) throw new Error(`unknown job ${job.name}`);
          const result = await handler();
          lastSuccess = Date.now();
          return result === 'skipped' ? { skipped: true } : { ok: true };
        },
        // Odds jobs run one at a time: a live tick must not race a catalogue import.
        { connection: bullConnection(), prefix: BULL_PREFIX, concurrency: 1 },
      ),
  );
  for (const worker of workers) {
    worker.on('failed', (job, err) =>
      logger.error({ job: job?.name, err: err.message }, 'job failed'),
    );
  }

  // First catalogue import right away, so a fresh install has data within seconds.
  handlers['catalog-sync']().catch((err: unknown) =>
    logger.error({ err: String(err) }, 'initial sync failed'),
  );

  const beat = async () => {
    await redis
      .set(REDIS_KEYS.workerHeartbeat, new Date().toISOString(), 'EX', 120)
      .catch(() => undefined);
  };
  await beat();
  const heartbeat = setInterval(() => void beat(), 10_000);

  const health = createServer((req, res) => {
    const healthy = Date.now() - lastSuccess < 5 * 60_000;
    res.writeHead(req.url === '/health' && healthy ? 200 : req.url === '/health' ? 503 : 404, {
      'content-type': 'application/json',
    });
    res.end(
      JSON.stringify({
        status: healthy ? 'ok' : 'stale',
        lastSuccessAt: new Date(lastSuccess).toISOString(),
      }),
    );
  });
  health.listen(env.WORKER_HEALTH_PORT, '0.0.0.0');
  logger.info(
    {
      provider: provider.key,
      simulated: provider.isSimulated,
      ...(env.ODDS_PROVIDER === 'mock'
        ? { timeScale: env.MOCK_TIME_SCALE }
        : env.ODDS_PROVIDER === 'sportsgameodds'
          ? { leagues: env.SGO_LEAGUES }
          : { sports: env.ODDS_API_SPORTS }),
    },
    'worker started',
  );

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 20_000);
    force.unref();
    clearInterval(heartbeat);
    health.close();
    await Promise.allSettled(workers.map((w) => w.close()));
    await Promise.allSettled([...queues.values()].map((q) => q.close()));
    await redis.quit().catch(() => undefined);
    await db.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
