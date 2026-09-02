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

export async function createTestApp(
  options: { rateLimit?: boolean; env?: Partial<ApiEnv> } = {},
): Promise<TestContext> {
  const env: ApiEnv = {
    ...loadApiEnv(),
    NODE_ENV: 'test',
    // Workers would pick up jobs from the developer's real queues.
    ENABLE_WORKERS: false,
    ENABLE_SWAGGER: false,
    LOG_LEVEL: 'fatal',
    LOGIN_RATE_LIMIT_MAX: 1000,
    RATE_LIMIT_MAX: 100000,
    // Last, so a suite can point something at a stub it controls — an external
    // registry, say, which a test can neither reach nor make answer with the
    // hostile things worth asserting against.
    ...options.env,
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

/**
 * A private copy of a seeded template, for a suite that changes one.
 *
 * Templates are panel-wide rows and `node --test` runs the files in parallel,
 * so a suite that toggles the shared `minecraft-java` breaks every other suite
 * reading it for as long as the toggle lasts — which is exactly what happened:
 * two suites passed alone and failed together. Owning a copy removes the race
 * rather than timing around it.
 */
export async function cloneTemplate(
  app: FastifyInstance,
  slug: string,
  features: string[],
): Promise<{ id: string; slug: string }> {
  const source = await app.prisma.gameTemplate.findUniqueOrThrow({ where: { slug } });
  const {
    id: _id,
    uuid: _uuid,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    parentId: _parentId,
    ...rest
  } = source;

  const copy = await app.prisma.gameTemplate.create({
    data: {
      ...rest,
      name: `${source.name} (test ${uniqueSuffix()})`,
      slug: `${slug}-test-${uniqueSuffix()}`,
      features,
      dockerImages: source.dockerImages as object,
      configFiles: source.configFiles as object,
      logConfig: source.logConfig as object,
    },
  });

  // The variables a template requires are what server creation validates, so
  // a copy without them would refuse every server built on it.
  const variables = await app.prisma.templateVariable.findMany({
    where: { templateId: source.id },
  });
  for (const variable of variables) {
    const { id: _varId, templateId: _templateId, ...definition } = variable;
    await app.prisma.templateVariable.create({ data: { ...definition, templateId: copy.id } });
  }

  return { id: copy.id, slug: copy.slug };
}

const PANEL_STORAGE_LOCK = 'storm:test:panel-storage';

/**
 * Takes a turn at the panel's one backup-storage configuration.
 *
 * `node --test` runs the files in parallel against one database, and a panel
 * has exactly one storage setup: the move worker asks "is there an active
 * bucket?" and gets a panel-wide answer. So a suite that keeps an active
 * bucket alive and one that asserts there is none cannot both be true at the
 * same moment — and they were not, about one full run in three, in whichever
 * suite happened to read the other's row.
 *
 * They take turns instead. The lock expires on its own, so a suite that dies
 * mid-setup does not wedge the next run.
 */
export async function claimPanelStorage(app: FastifyInstance): Promise<() => Promise<void>> {
  const token = uniqueSuffix();
  const deadline = Date.now() + 180_000;

  for (;;) {
    const won = await app.redis.set(PANEL_STORAGE_LOCK, token, 'PX', 300_000, 'NX');
    if (won) break;
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for a turn at the panel backup storage');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return async () => {
    // Only give back a turn that is still ours; an expired one has moved on.
    if ((await app.redis.get(PANEL_STORAGE_LOCK)) === token) {
      await app.redis.del(PANEL_STORAGE_LOCK);
    }
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
