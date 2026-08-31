import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import type { FastifyInstance } from 'fastify';
import { loadApiEnv, type ApiEnv } from '@storm/config';
import { buildApp } from '../src/app.js';

// The app needs DATABASE_URL, JWT_SECRET, ENCRYPTION_KEY and COOKIE_SECRET to
// build at all, and a developer who has run the installer already has them in
// the repository .env. Reading it here means `pnpm test` works from a fresh
// checkout instead of failing with four "Required" lines. Anything already in
// the environment wins, so pointing DATABASE_URL at a scratch database on the
// command line still does what it looks like it does.
const repoEnv = path.resolve(fileURLToPath(import.meta.url), '../../../../.env');
if (existsSync(repoEnv)) {
  process.loadEnvFile(repoEnv);
}

/**
 * Integration tests run against the real Postgres and Redis the developer
 * already has running — no mocks. Each run namespaces its own data so a suite
 * never depends on, or destroys, anything another one created.
 */
export interface TestContext {
  app: FastifyInstance;
  env: ApiEnv;
  cleanup: () => Promise<void>;
}

export async function createTestApp(options: { rateLimit?: boolean } = {}): Promise<TestContext> {
  const env: ApiEnv = {
    ...loadApiEnv(),
    NODE_ENV: 'test',
    // Workers would pick up jobs from the developer's real queues.
    ENABLE_WORKERS: false,
    ENABLE_SWAGGER: false,
    LOG_LEVEL: 'fatal',
    LOGIN_RATE_LIMIT_MAX: 1000,
    RATE_LIMIT_MAX: 100000,
  };

  // Route-level limits (5 registrations per 10 minutes) would throttle a
  // suite that creates a dozen accounts, so they are off unless a test is
  // specifically exercising them.
  const app = await buildApp({ env, logger: false, rateLimit: options.rateLimit ?? false });
  await app.ready();

  return {
    app,
    env,
    cleanup: async () => {
      await app.close();
    },
  };
}

export function uniqueSuffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

export interface RegisteredUser {
  id: string;
  email: string;
  username: string;
  password: string;
  cookies: string;
  accessToken: string;
}

/** Registers a fresh customer and returns everything needed to act as them. */
export async function registerUser(app: FastifyInstance): Promise<RegisteredUser> {
  const suffix = uniqueSuffix();
  const email = `test-${suffix}@storm.test`;
  const username = `test${suffix}`;
  const password = 'TestPassword123!';

  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, username, password },
  });

  if (response.statusCode !== 201) {
    throw new Error(`Registration failed (${response.statusCode}): ${response.body}`);
  }

  const body = response.json<{ data: { user: { id: string }; accessToken: string } }>();

  return {
    id: body.data.user.id,
    email,
    username,
    password,
    cookies: collectCookies(response.headers['set-cookie']),
    accessToken: body.data.accessToken,
  };
}

export function collectCookies(header: string | string[] | undefined): string {
  if (!header) return '';
  const values = Array.isArray(header) ? header : [header];
  return values.map((cookie) => cookie.split(';')[0]).join('; ');
}

export function authHeaders(user: RegisteredUser): Record<string, string> {
  return { authorization: `Bearer ${user.accessToken}`, cookie: user.cookies };
}

/** Deletes everything a test created, in an order the foreign keys allow. */
export async function deleteUser(app: FastifyInstance, userId: string): Promise<void> {
  await app.prisma.serverAllocation.updateMany({
    where: { server: { ownerId: userId } },
    data: { serverId: null, isPrimary: false },
  });
  await app.prisma.server.deleteMany({ where: { ownerId: userId } });
  await app.prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
}
