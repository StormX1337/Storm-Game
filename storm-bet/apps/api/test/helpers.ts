import { randomUUID } from 'node:crypto';
import { BetPlacementService, CashoutService, SettlementService } from '@storm-bet/betting-engine';
import {
  apiEnvSchema,
  bettingLimitsFrom,
  CSRF_COOKIE,
  demoWalletPolicyFrom,
  parseEnv,
  SESSION_COOKIE,
} from '@storm-bet/config';
import { createPrismaClient, withTransaction } from '@storm-bet/database';
import { openWallet } from '@storm-bet/betting-engine';
import { createRedis, createSubscriber, JsonCache, RealtimeHub } from '@storm-bet/redis';
import { hashPassword } from '@storm-bet/security';
import type { UserRole } from '@storm-bet/types';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app';
import { CasinoService, MockCasinoProvider } from '@storm-bet/casino';
import type { AppContext } from '../src/context';
import type { Mailer, MailMessage } from '../src/lib/mailer';

export const ORIGIN = 'http://localhost:3000';

export class CapturingMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  async send(message: MailMessage) {
    this.sent.push(message);
  }
  lastTokenFor(to: string): string {
    const mail = [...this.sent].reverse().find((m) => m.to === to);
    const match = mail && /token=([^\s&]+)/.exec(mail.text);
    if (!match?.[1]) throw new Error(`no token mailed to ${to}`);
    return decodeURIComponent(match[1]);
  }
}

export async function createTestApp() {
  const env = parseEnv(apiEnvSchema, { ...process.env, LOG_LEVEL: 'silent' });
  const db = createPrismaClient();
  const redis = createRedis(env.REDIS_URL);
  const hub = new RealtimeHub(createSubscriber(env.REDIS_URL));
  await hub.start();
  const mailer = new CapturingMailer();
  const limits = bettingLimitsFrom(env);
  const now = () => new Date();
  const ctx: AppContext = {
    env,
    db,
    redis,
    hub,
    cache: new JsonCache(redis),
    mailer,
    limits,
    demoWallet: demoWalletPolicyFrom(env),
    placement: new BetPlacementService({ db, redis, limits, requireEmailVerification: false, now }),
    cashout: new CashoutService({ db, redis, marginPct: 5, now }),
    settlement: new SettlementService({ db, redis, now }),
    casino: new CasinoService({ db, redis, providers: [new MockCasinoProvider()], now }),
    queues: [],
    now,
  };
  // Tests share Redis with each other; start from clean rate-limit buckets.
  const keys = await redis.keys('sb:rl:*');
  if (keys.length) await redis.del(...keys);
  const { app } = await buildApp(ctx, { logger: false });
  await app.ready();
  const close = async () => {
    await app.close();
    await hub.stop();
    await redis.quit();
    await db.$disconnect();
  };
  return { app, ctx, mailer, db, redis, close };
}

/** A browser-like client: keeps cookies and sends the CSRF header like the web app does. */
export class Client {
  private cookies = new Map<string, string>();

  constructor(
    private readonly app: FastifyInstance,
    readonly ip = `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
  ) {}

  private store(res: LightMyRequestResponse) {
    for (const c of res.cookies) {
      if (
        c.value === '' ||
        (c.maxAge !== undefined && c.maxAge <= 0) ||
        (c.expires && c.expires.getTime() < Date.now())
      ) {
        this.cookies.delete(c.name);
      } else this.cookies.set(c.name, c.value);
    }
  }

  get hasSession() {
    return this.cookies.has(SESSION_COOKIE);
  }

  async request(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
    options: { csrf?: boolean; origin?: string } = {},
  ) {
    if (method !== 'GET' && options.csrf !== false && !this.cookies.has(CSRF_COOKIE)) {
      await this.request('GET', '/api/auth/csrf');
    }
    const headers: Record<string, string> = { 'x-forwarded-for': this.ip };
    if (this.cookies.size)
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (method !== 'GET') {
      headers.origin = options.origin ?? ORIGIN;
      if (options.csrf !== false) headers['x-csrf-token'] = this.cookies.get(CSRF_COOKIE) ?? '';
    }
    const res = await this.app.inject({
      method,
      url,
      headers,
      remoteAddress: '127.0.0.1',
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    this.store(res);
    return {
      status: res.statusCode,
      body: res.body ? (JSON.parse(res.body) as any) : null,
      headers: res.headers,
    };
  }

  get = (url: string) => this.request('GET', url);
  post = (url: string, body: unknown = {}, options?: { csrf?: boolean; origin?: string }) =>
    this.request('POST', url, body, options);
  put = (url: string, body: unknown) => this.request('PUT', url, body);
  patch = (url: string, body: unknown) => this.request('PATCH', url, body);
}

export const PASSWORD = 'Sehr-sicher-2026';

export async function createUser(
  db: ReturnType<typeof createPrismaClient>,
  role: UserRole = 'USER',
  balance = 100_000n,
) {
  const email = `${role.toLowerCase()}-${randomUUID()}@test.local`;
  const user = await db.user.create({
    data: {
      email,
      displayName: `${role} Test`,
      passwordHash: await hashPassword(PASSWORD),
      role,
      emailVerifiedAt: new Date(),
    },
  });
  await withTransaction(db, (tx) => openWallet(tx, user.id, balance));
  return user;
}

export async function loginAs(app: FastifyInstance, email: string) {
  const client = new Client(app);
  const res = await client.post('/api/auth/login', { email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login failed: ${JSON.stringify(res.body)}`);
  return client;
}
