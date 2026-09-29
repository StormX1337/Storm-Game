import { randomUUID } from 'node:crypto';
import {
  createPrismaClient,
  Prisma,
  withTransaction,
  type PrismaClient,
} from '@storm-bet/database';
import { openWallet } from '../src';

export const db: PrismaClient = createPrismaClient();

export const limits = {
  minStake: 10,
  maxStake: 1_000_000,
  maxPayout: 25_000_000,
  maxSelections: 20,
  maxTotalOdds: 10_000,
  acceptHigherMaxPct: 10,
};

export async function createUser(
  balance = 100_000n,
  overrides: Partial<Prisma.UserCreateInput> = {},
) {
  const user = await db.user.create({
    data: {
      email: `user-${randomUUID()}@test.local`,
      displayName: 'Test User',
      passwordHash: 'x',
      ...overrides,
    },
  });
  await withTransaction(db, (tx) => openWallet(tx, user.id, balance));
  return user;
}

async function sport() {
  return db.sport.upsert({
    where: { key: 'football' },
    create: { key: 'football', name: 'Fußball' },
    update: {},
  });
}

/** An open football event with a 1X2 market, owned by this test run. */
export async function createEvent(
  options: { odds?: [number, number, number]; startInMs?: number } = {},
) {
  const { odds = [1.65, 3.6, 5.0], startInMs = 3_600_000 } = options;
  const s = await sport();
  const tag = randomUUID().slice(0, 8);
  const league = await db.league.create({
    data: { sportId: s.id, provider: 'test', externalId: `league-${tag}`, name: 'Testliga' },
  });
  const [home, away] = await Promise.all(
    ['Home', 'Away'].map((name) =>
      db.team.create({
        data: {
          sportId: s.id,
          provider: 'test',
          externalId: `${name}-${tag}`,
          name: `${name} ${tag}`,
          shortName: name.slice(0, 3),
        },
      }),
    ),
  );
  const event = await db.event.create({
    data: {
      sportId: s.id,
      leagueId: league.id,
      homeTeamId: home!.id,
      awayTeamId: away!.id,
      provider: 'test',
      externalId: `event-${tag}`,
      startTime: new Date(Date.now() + startInMs),
      status: 'SCHEDULED',
    },
  });
  const market = await db.market.create({
    data: {
      eventId: event.id,
      key: 'MATCH_RESULT',
      type: 'MATCH_RESULT',
      name: 'Ergebnis (1X2)',
      selections: {
        create: (['HOME', 'DRAW', 'AWAY'] as const).map((outcome, i) => ({
          key: outcome,
          name: outcome,
          outcome,
          odds: new Prisma.Decimal(odds[i]!),
          sortOrder: i,
        })),
      },
    },
    include: { selections: { orderBy: { sortOrder: 'asc' } } },
  });
  const [homeSel, drawSel, awaySel] = market.selections;
  return { event, market, home: homeSel!, draw: drawSel!, away: awaySel! };
}

export async function finishEvent(eventId: string, home: number, away: number) {
  await db.event.update({
    where: { id: eventId },
    data: {
      status: 'FINISHED',
      homeScore: home,
      awayScore: away,
      resultConfirmedAt: new Date(),
      statistics: {
        sport: 'football',
        goals: { home, away },
        corners: { home: 4, away: 4 },
        yellowCards: { home: 1, away: 1 },
        redCards: { home: 0, away: 0 },
        shotsOnTarget: { home: 5, away: 5 },
        possession: { home: 50, away: 50 },
        goalEvents: [],
      },
    },
  });
}

export async function wallet(userId: string) {
  return db.wallet.findUniqueOrThrow({ where: { userId } });
}
