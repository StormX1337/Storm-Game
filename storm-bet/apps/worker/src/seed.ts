import { randomUUID } from 'node:crypto';
import { BetPlacementService, openWallet } from '@storm-bet/betting-engine';
import { bettingLimitsFrom, parseEnv, seedEnvSchema, workerEnvSchema } from '@storm-bet/config';
import {
  createPrismaClient,
  recordAudit,
  SYSTEM_ACTOR,
  withTransaction,
  type PrismaClient,
} from '@storm-bet/database';
import { OddsSyncService } from '@storm-bet/odds-engine';
import { createRedis } from '@storm-bet/redis';
import { generatePassword, hashPassword } from '@storm-bet/security';
import type { UserRole } from '@storm-bet/types';
import { createProvider } from './provider';

/**
 * Idempotent demo seed:
 *  1. staff and demo accounts (created once; existing passwords are kept),
 *  2. the simulated catalogue (sports, leagues, teams, fixtures, markets),
 *  3. a few open demo bets so the dashboard is not empty.
 * All sportsbook data is simulated and flagged as such.
 */
async function ensureUser(
  db: PrismaClient,
  email: string,
  password: string | undefined,
  role: UserRole,
  displayName: string,
  startingBalance: bigint,
): Promise<{ id: string; created: boolean; password: string | null }> {
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) return { id: existing.id, created: false, password: null };
  const plain = password ?? generatePassword();
  const passwordHash = await hashPassword(plain);
  const user = await withTransaction(db, async (tx) => {
    const created = await tx.user.create({
      data: { email, displayName, passwordHash, role, emailVerifiedAt: new Date(), country: 'DE' },
    });
    await openWallet(tx, created.id, startingBalance);
    await recordAudit(tx, SYSTEM_ACTOR, {
      action: 'seed.user_created',
      targetType: 'user',
      targetId: created.id,
      metadata: { role },
    });
    return created;
  });
  return { id: user.id, created: true, password: password ? null : plain };
}

async function main(): Promise<void> {
  const seedEnv = parseEnv(seedEnvSchema);
  const env = parseEnv(workerEnvSchema);
  const db = createPrismaClient();
  const redis = createRedis(env.REDIS_URL);

  try {
    const balance = BigInt(seedEnv.DEMO_STARTING_BALANCE);
    const admin = await ensureUser(
      db,
      seedEnv.SEED_ADMIN_EMAIL,
      seedEnv.SEED_ADMIN_PASSWORD,
      'ADMIN',
      'Storm Admin',
      balance,
    );
    const demo = await ensureUser(
      db,
      seedEnv.SEED_DEMO_EMAIL,
      seedEnv.SEED_DEMO_PASSWORD,
      'USER',
      'Demo Spieler',
      balance,
    );

    console.log('\nKonten');
    for (const [label, email, account] of [
      ['Admin', seedEnv.SEED_ADMIN_EMAIL, admin],
      ['Demo ', seedEnv.SEED_DEMO_EMAIL, demo],
    ] as const) {
      const pw = account.password
        ? `Passwort (generiert, nur jetzt sichtbar): ${account.password}`
        : account.created
          ? 'Passwort aus .env'
          : 'existiert bereits – Passwort unverändert';
      console.log(`  ${label}  ${email}  ${pw}`);
    }

    const provider = createProvider(env, redis);
    console.log(
      provider.isSimulated
        ? '\nImportiere simulierten Katalog (Demo-Daten) …'
        : `\nImportiere Katalog von ${provider.name} …`,
    );
    const sync = new OddsSyncService(db, redis, provider, {
      horizonHours: env.ODDS_PROVIDER === 'mock' ? 36 : 7 * 24,
      lookbackHours: 6,
    });
    const catalog = await sync.syncCatalog();
    const live = await sync.syncLive();
    console.log(
      `  ${catalog.events} Events (${catalog.createdEvents} neu), ${catalog.createdMarkets + live.createdMarkets} Märkte neu angelegt`,
    );

    const openBets = await db.bet.count({ where: { userId: demo.id } });
    if (openBets === 0) {
      const placement = new BetPlacementService({
        db,
        redis,
        limits: bettingLimitsFrom(env),
        requireEmailVerification: false,
      });
      const upcoming = await db.event.findMany({
        where: {
          status: 'SCHEDULED',
          startTime: { gt: new Date(Date.now() + 10 * 60_000) },
          isActive: true,
        },
        include: {
          markets: {
            where: { type: { in: ['MATCH_RESULT', 'MATCH_WINNER'] }, status: 'OPEN' },
            include: { selections: true },
          },
        },
        orderBy: { startTime: 'asc' },
        take: 6,
      });
      const picks = upcoming
        .map((e) => e.markets[0]?.selections.find((s) => s.status === 'OPEN'))
        .filter((s): s is NonNullable<typeof s> => !!s);
      const odds = (s: (typeof picks)[number]) => Number(s.odds.toFixed(3));
      if (picks.length >= 3) {
        await placement.place(demo.id, {
          idempotencyKey: randomUUID(),
          mode: 'COMBO',
          stake: 1_000,
          oddsChangePolicy: 'REJECT',
          selections: picks.slice(0, 2).map((s) => ({ selectionId: s.id, odds: odds(s) })),
        });
        await placement.place(demo.id, {
          idempotencyKey: randomUUID(),
          mode: 'SINGLES',
          oddsChangePolicy: 'REJECT',
          selections: picks
            .slice(2, 4)
            .map((s) => ({ selectionId: s.id, odds: odds(s), stake: 500 })),
        });
        console.log('  Beispielwetten für das Demo-Konto platziert');
      }
    }
    console.log(
      provider.isSimulated
        ? '\nFertig. Alle Sportdaten sind simuliert und als Demo gekennzeichnet.\n'
        : `\nFertig. Quoten und Ergebnisse stammen von ${provider.name}; gewettet wird mit Demo-Guthaben.\n`,
    );
  } finally {
    await redis.quit();
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
