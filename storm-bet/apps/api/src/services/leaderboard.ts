import { moneyToNumber, Prisma, type PrismaClient } from '@storm-bet/database';
import type { JsonCache } from '@storm-bet/redis';
import type {
  LeaderboardDto,
  LeaderboardEntryDto,
  LeaderboardPeriod,
  LeaderboardRanking,
  LeaderboardStatsDto,
} from '@storm-bet/types';
import { berlinDay } from './catalog';

/** Decided (won or lost) bets needed before a hit rate is ranked. */
export const MIN_DECIDED = 5;
const TOP = 50;

interface Row {
  userId: string;
  name: string;
  settled: number;
  won: number;
  lost: number;
  profit: bigint;
}

interface Ranked extends Omit<LeaderboardStatsDto, 'profit'> {
  userId: string;
  name: string;
  profit: number;
}

/** Monday 00:00 or the 1st 00:00 in Europe/Berlin. */
export function periodStart(period: LeaderboardPeriod, now: Date): Date {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(now);
  if (period === 'month') return berlinDay(`${today.slice(0, 8)}01`)[0];
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return berlinDay(date.toISOString().slice(0, 10))[0];
}

function stats(row: Row): Ranked {
  const decided = row.won + row.lost;
  return {
    userId: row.userId,
    name: row.name,
    settled: row.settled,
    won: row.won,
    lost: row.lost,
    profit: moneyToNumber(row.profit),
    hitRate: decided > 0 ? row.won / decided : null,
  };
}

function rank(rows: Ranked[], by: LeaderboardRanking): Ranked[] {
  if (by === 'hitrate') {
    return rows
      .filter((r) => r.won + r.lost >= MIN_DECIDED)
      .sort(
        (a, b) =>
          (b.hitRate ?? 0) - (a.hitRate ?? 0) ||
          b.won + b.lost - (a.won + a.lost) ||
          b.profit - a.profit ||
          a.name.localeCompare(b.name),
      );
  }
  return [...rows].sort(
    (a, b) => b.profit - a.profit || b.settled - a.settled || a.name.localeCompare(b.name),
  );
}

/**
 * Sportsbook results of players who chose to take part. Profit counts what a
 * bet returned (payout plus partial cashouts) minus its stake.
 */
export class LeaderboardService {
  constructor(
    private readonly db: PrismaClient,
    private readonly cache: JsonCache,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async aggregate(from: Date, userId: string | null): Promise<Row[]> {
    return this.db.$queryRaw<Row[]>`
      SELECT b.user_id AS "userId", u.display_name AS "name",
             COUNT(*)::int AS "settled",
             (COUNT(*) FILTER (WHERE b.status = 'WON'))::int AS "won",
             (COUNT(*) FILTER (WHERE b.status = 'LOST'))::int AS "lost",
             SUM(COALESCE(b.payout, 0) + COALESCE(c.amount, 0) - b.stake)::bigint AS "profit"
      FROM bets b
      JOIN users u ON u.id = b.user_id
      LEFT JOIN LATERAL (
        SELECT SUM(bc.amount) AS amount FROM bet_cashouts bc WHERE bc.bet_id = b.id
      ) c ON true
      WHERE b.settled_at >= ${from}
        AND b.status <> 'PENDING'
        AND ${
          userId === null
            ? Prisma.sql`u.leaderboard_opt_in AND u.role = 'USER' AND u.status = 'ACTIVE'`
            : Prisma.sql`u.id = ${userId}::uuid`
        }
      GROUP BY b.user_id, u.display_name`;
  }

  /** Everyone taking part, ranked; shared by all viewers for a minute. */
  private async ranked(period: LeaderboardPeriod, by: LeaderboardRanking, from: Date) {
    return this.cache.wrap(`leaderboard:${period}:${by}:${from.toISOString()}`, 60, async () =>
      rank((await this.aggregate(from, null)).map(stats), by),
    );
  }

  async board(
    period: LeaderboardPeriod,
    by: LeaderboardRanking,
    viewerId: string | null,
  ): Promise<LeaderboardDto> {
    const from = periodStart(period, this.now());
    const all = await this.ranked(period, by, from);
    const entries: LeaderboardEntryDto[] = all.slice(0, TOP).map((r, i) => ({
      ...r,
      rank: i + 1,
      me: r.userId === viewerId,
    }));
    let me: LeaderboardDto['me'] = null;
    if (viewerId) {
      const [user, own] = await Promise.all([
        this.db.user.findUnique({
          where: { id: viewerId },
          select: { leaderboardOptIn: true },
        }),
        this.aggregate(from, viewerId),
      ]);
      const mine = own[0] ? stats(own[0]) : null;
      const position = all.findIndex((r) => r.userId === viewerId);
      me = {
        optIn: user?.leaderboardOptIn ?? false,
        settled: mine?.settled ?? 0,
        won: mine?.won ?? 0,
        lost: mine?.lost ?? 0,
        profit: mine?.profit ?? 0,
        hitRate: mine?.hitRate ?? null,
        rank: position >= 0 ? position + 1 : null,
      };
    }
    return { period, by, from: from.toISOString(), minDecided: MIN_DECIDED, entries, me };
  }

  async setOptIn(userId: string, optIn: boolean): Promise<void> {
    await this.db.user.update({ where: { id: userId }, data: { leaderboardOptIn: optIn } });
    await this.cache.delPrefix('leaderboard:');
  }
}
