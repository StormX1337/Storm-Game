import { BetPlacementService, CashoutService, SettlementService } from '@storm-bet/betting-engine';
import {
  apiEnvSchema,
  bettingLimitsFrom,
  demoWalletPolicyFrom,
  parseEnv,
  QUEUES,
} from '@storm-bet/config';
import { createPrismaClient } from '@storm-bet/database';
import { createRedis, createSubscriber, JsonCache, RealtimeHub } from '@storm-bet/redis';
import { Queue } from 'bullmq';
import pino from 'pino';
import { buildApp } from './app';
import { CasinoService, MockCasinoProvider } from '@storm-bet/casino';
import type { AppContext } from './context';
import { LogMailer, SmtpMailer } from './lib/mailer';

async function main(): Promise<void> {
  const env = parseEnv(apiEnvSchema);
  const logger = pino({ level: env.LOG_LEVEL, base: { service: 'api' } });

  const db = createPrismaClient();
  const redis = createRedis(env.REDIS_URL);
  const hub = new RealtimeHub(createSubscriber(env.REDIS_URL));
  await hub.start();
  const limits = bettingLimitsFrom(env);
  const now = () => new Date();
  const queues = Object.values(QUEUES).map(
    (name) =>
      new Queue(name, {
        connection: createRedis(env.REDIS_URL, { maxRetriesPerRequest: null }),
        prefix: 'sb:bull',
      }),
  );

  const ctx: AppContext = {
    env,
    db,
    redis,
    hub,
    cache: new JsonCache(redis),
    mailer: env.SMTP_URL ? new SmtpMailer(env.SMTP_URL, env.MAIL_FROM) : new LogMailer(logger),
    limits,
    demoWallet: demoWalletPolicyFrom(env),
    placement: new BetPlacementService({
      db,
      redis,
      limits,
      requireEmailVerification: env.AUTH_REQUIRE_EMAIL_VERIFICATION,
      now,
    }),
    cashout: new CashoutService({ db, redis, marginPct: env.CASHOUT_MARGIN_PCT, now }),
    settlement: new SettlementService({ db, redis, logger, now }),
    casino: new CasinoService({ db, redis, providers: [new MockCasinoProvider()], now }),
    queues,
    now,
  };

  const { app, tracker } = await buildApp(ctx);
  await tracker.start();
  await app.listen({ host: env.API_HOST, port: env.API_PORT });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    try {
      tracker.stop();
      await app.close();
      await hub.stop();
      await Promise.all(queues.map((q) => q.close()));
      await redis.quit();
      await db.$disconnect();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  // Configuration errors are the common case here; they read best as-is.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
