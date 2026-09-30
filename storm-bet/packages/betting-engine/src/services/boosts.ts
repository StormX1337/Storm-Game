import { oddsToMilli, type PrismaClient } from '@storm-bet/database';
import type { BoostDto, SportKey } from '@storm-bet/types';
import { boostedOddsMilli } from '../domain/slip';

export interface BoostDeps {
  db: PrismaClient;
  now?: () => Date;
}

/** Published boost terms: +20 % on the price, up to 10,00 DEMO, one bet per player. */
export const BOOST_UPLIFT_PCT = 20;
export const BOOST_MAX_STAKE = 1_000n;
const DAILY_BOOSTS = 3;

/**
 * Odds boosts: a selection at a raised price for a limited stake, until
 * kick-off. Chosen automatically among upcoming favourites.
 */
export class BoostService {
  private readonly now: () => Date;

  constructor(private readonly deps: BoostDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async active(userId: string | null): Promise<BoostDto[]> {
    const now = this.now();
    const rows = await this.deps.db.oddsBoost.findMany({
      where: { startsAt: { lte: now }, endsAt: { gt: now } },
      orderBy: { endsAt: 'asc' },
      include: {
        selection: {
          include: {
            market: {
              include: {
                event: {
                  include: {
                    sport: { select: { key: true } },
                    homeTeam: { select: { name: true } },
                    awayTeam: { select: { name: true } },
                  },
                },
              },
            },
          },
        },
        bets: userId
          ? { where: { userId }, select: { id: true } }
          : { take: 0, select: { id: true } },
      },
    });
    return rows.map((b) => {
      const { selection } = b;
      const { market } = selection;
      const { event } = market;
      const odds = oddsToMilli(selection.odds);
      return {
        id: b.id,
        title: b.title,
        upliftPct: b.upliftPct,
        maxStake: Number(b.maxStake),
        endsAt: b.endsAt.toISOString(),
        used: b.bets.length > 0,
        open:
          selection.status === 'OPEN' &&
          market.status === 'OPEN' &&
          !market.tradingSuspended &&
          event.status === 'SCHEDULED' &&
          event.isActive &&
          !event.tradingSuspended,
        selectionId: selection.id,
        selectionName: selection.name,
        marketId: market.id,
        marketName: market.name,
        eventId: event.id,
        eventName: `${event.homeTeam.name} – ${event.awayTeam.name}`,
        sportKey: event.sport.key as SportKey,
        startTime: event.startTime.toISOString(),
        odds: odds / 1000,
        boostedOdds: boostedOddsMilli(odds, b.upliftPct) / 1000,
      };
    });
  }

  /** Keeps a few boosts on offer: favourites of matches starting within a day. */
  async ensureDaily(): Promise<number> {
    const now = this.now();
    const active = await this.deps.db.oddsBoost.findMany({
      where: { endsAt: { gt: now } },
      select: { selection: { select: { market: { select: { eventId: true } } } } },
    });
    if (active.length >= DAILY_BOOSTS) return 0;
    const taken = new Set(active.map((a) => a.selection.market.eventId));
    const candidates = await this.deps.db.selection.findMany({
      where: {
        status: 'OPEN',
        outcome: { in: ['HOME', 'AWAY'] },
        odds: { gte: 1.4, lte: 2.6 },
        market: {
          status: 'OPEN',
          tradingSuspended: false,
          type: { in: ['MATCH_RESULT', 'MATCH_WINNER'] },
          event: {
            status: 'SCHEDULED',
            isActive: true,
            startTime: {
              gt: new Date(now.getTime() + 30 * 60_000),
              lt: new Date(now.getTime() + 24 * 3_600_000),
            },
            sport: { key: { in: ['football', 'basketball'] } },
          },
        },
      },
      include: { market: { select: { eventId: true, event: { select: { startTime: true } } } } },
      orderBy: [{ market: { event: { startTime: 'asc' } } }, { odds: 'asc' }],
      take: 200,
    });
    let created = 0;
    for (const s of candidates) {
      if (active.length + created >= DAILY_BOOSTS) break;
      if (taken.has(s.market.eventId)) continue;
      taken.add(s.market.eventId);
      await this.deps.db.oddsBoost.create({
        data: {
          selectionId: s.id,
          title: `${s.name} gewinnt`,
          upliftPct: BOOST_UPLIFT_PCT,
          maxStake: BOOST_MAX_STAKE,
          startsAt: now,
          endsAt: s.market.event.startTime,
        },
      });
      created += 1;
    }
    return created;
  }
}
