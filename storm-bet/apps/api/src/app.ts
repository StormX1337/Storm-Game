import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { AppContext } from './context';
import { authPlugin } from './plugins/auth';
import { csrfPlugin } from './plugins/csrf';
import { registerErrorHandling } from './plugins/errors';
import { enforceRateLimit, RATE_LIMITS } from './plugins/rate-limit';
import { accountRoutes } from './routes/account';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { betRoutes } from './routes/bets';
import { feedRoutes } from './routes/feed';
import { socialRoutes } from './routes/social';
import { casinoRoutes } from './routes/casino';
import { catalogRoutes } from './routes/catalog';
import { InsightsService } from './services/insights';
import { TwoFactorService } from './services/two-factor';
import { contactRoutes } from './routes/contact';
import { healthRoutes } from './routes/health';
import { LiveEventTracker, streamRoutes } from './routes/stream';
import { walletRoutes } from './routes/wallet';
import { AccountService } from './services/account';
import { AdminService } from './services/admin';
import { AuthService } from './services/auth';
import { CasinoCatalogService } from './services/casino';
import { CatalogService } from './services/catalog';
import { LeaderboardService } from './services/leaderboard';
import { SessionService } from './services/sessions';

function trustProxySetting(value: string): FastifyServerOptions['trustProxy'] {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

export interface BuiltApp {
  app: FastifyInstance;
  tracker: LiveEventTracker;
}

export async function buildApp(
  ctx: AppContext,
  options: { logger?: FastifyServerOptions['logger'] } = {},
): Promise<BuiltApp> {
  const app = Fastify({
    logger: options.logger ?? {
      level: ctx.env.LOG_LEVEL,
      redact: {
        paths: [
          'req.headers.cookie',
          'req.headers.authorization',
          'req.headers["x-csrf-token"]',
          'res.headers["set-cookie"]',
        ],
        censor: '[redacted]',
      },
    },
    trustProxy: trustProxySetting(ctx.env.TRUST_PROXY),
    bodyLimit: 100_000,
    // Request ids are ours; a client-supplied id is never trusted into the logs.
    genReqId: () => randomUUID(),
    requestIdLogLabel: 'requestId',
    routerOptions: { ignoreTrailingSlash: true },
  });

  const sessions = new SessionService(
    ctx.db,
    ctx.redis,
    {
      ttlHours: ctx.env.SESSION_TTL_HOURS,
      idleMinutes: ctx.env.SESSION_IDLE_MINUTES,
      staffIdleMinutes: ctx.env.ADMIN_SESSION_IDLE_MINUTES,
    },
    ctx.now,
  );
  const twoFactor = new TwoFactorService(ctx.db, {
    authSecret: ctx.env.AUTH_SECRET,
    issuer: 'STORM BET',
    now: ctx.now,
  });
  const auth = new AuthService(
    ctx.db,
    ctx.redis,
    sessions,
    ctx.mailer,
    {
      appUrl: ctx.env.APP_URL,
      startingBalance: BigInt(ctx.demoWallet.startingBalance),
      now: ctx.now,
    },
    twoFactor,
  );
  const catalog = new CatalogService(ctx.db, ctx.cache, ctx.now);
  const insights = new InsightsService(ctx.db, ctx.cache, {
    apiKey: ctx.env.STANDINGS_API_KEY,
    apiUrl: ctx.env.STANDINGS_API_URL,
  });
  const accounts = new AccountService(ctx.db, ctx.now);
  const admin = new AdminService(
    ctx.db,
    ctx.redis,
    ctx.cache,
    sessions,
    accounts,
    ctx.settlement,
    ctx.queues,
    ctx.now,
    ctx.env.ODDS_PROVIDER,
  );
  const casinoCatalog = new CasinoCatalogService(ctx.db, ctx.cache, ctx.now);
  const leaderboard = new LeaderboardService(ctx.db, ctx.cache, ctx.now);
  const tracker = new LiveEventTracker(ctx.db);

  await app.register(cookie);
  await app.register(helmet, {
    // The API only ever returns JSON (and an event stream): nothing may render it.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
    frameguard: { action: 'deny' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    hsts: ctx.env.APP_URL.startsWith('https://')
      ? { maxAge: 31_536_000, includeSubDomains: true }
      : false,
  });
  registerErrorHandling(app);

  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/health')) return;
    await enforceRateLimit(ctx.redis, RATE_LIMITS.global, request.ip, reply);
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    return payload;
  });

  await app.register(authPlugin, { sessions });
  await app.register(csrfPlugin, { secret: ctx.env.AUTH_SECRET, appUrl: ctx.env.APP_URL });

  await app.register(
    async (api) => {
      await api.register(healthRoutes(ctx));
      await api.register(authRoutes(ctx, auth, sessions));
      await api.register(catalogRoutes(catalog, insights));
      await api.register(betRoutes(ctx));
      await api.register(feedRoutes(ctx));
      await api.register(socialRoutes(ctx, leaderboard));
      await api.register(walletRoutes(ctx));
      await api.register(accountRoutes(ctx, accounts, sessions, twoFactor));
      await api.register(contactRoutes(ctx));
      await api.register(streamRoutes(ctx, tracker));
      await api.register(casinoRoutes(ctx, casinoCatalog), { prefix: '/casino' });
      await api.register(adminRoutes(ctx, admin, accounts, casinoCatalog, twoFactor), {
        prefix: '/admin',
      });
    },
    { prefix: '/api' },
  );

  return { app, tracker };
}
