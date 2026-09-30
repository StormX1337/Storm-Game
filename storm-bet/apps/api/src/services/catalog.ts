import { decimalToNumber, oddsToMilli, type Prisma, type PrismaClient } from '@storm-bet/database';
import { isSimulatedProvider } from '@storm-bet/odds-engine';
import type { JsonCache } from '@storm-bet/redis';
import {
  AppError,
  type SharedSelectionDto,
  type EventDetailDto,
  type EventStatus,
  type EventSummaryDto,
  type LeagueDto,
  type MarketDto,
  type MarketStatus,
  type Paginated,
  type SelectionStatus,
  type SportDto,
  type SportKey,
} from '@storm-bet/types';
import { parseLiveState, parseStatistics, type EventListQuery } from '@storm-bet/validation';
import { cursorArgs, page } from '../lib/pagination';

const MAIN_MARKETS = ['MATCH_RESULT', 'MATCH_WINNER'] as const;

/** Start and end of a calendar day in Europe/Berlin (daylight saving included). */
export function berlinDay(day: string): [Date, Date] {
  const at = (date: string) => {
    const utc = new Date(`${date}T00:00:00Z`);
    const offset = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Berlin',
      timeZoneName: 'shortOffset',
    })
      .formatToParts(utc)
      .find((p) => p.type === 'timeZoneName')?.value;
    const hours = Number(/GMT([+-]\d+)/.exec(offset ?? '')?.[1] ?? 0);
    return new Date(utc.getTime() - hours * 3_600_000);
  };
  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return [at(day), at(next.toISOString().slice(0, 10))];
}
const VISIBLE_MARKET_STATUSES: MarketStatus[] = ['OPEN', 'SUSPENDED'];

const EVENT_BASE_INCLUDE = {
  sport: { select: { key: true, name: true } },
  league: { select: { id: true, name: true, country: true } },
  homeTeam: { select: { id: true, name: true, shortName: true } },
  awayTeam: { select: { id: true, name: true, shortName: true } },
} satisfies Prisma.EventInclude;

const SUMMARY_INCLUDE = {
  ...EVENT_BASE_INCLUDE,
  markets: {
    where: { type: { in: [...MAIN_MARKETS] }, status: { in: VISIBLE_MARKET_STATUSES } },
    include: { selections: { orderBy: { sortOrder: 'asc' } } },
    take: 1,
  },
  _count: { select: { markets: { where: { status: { in: VISIBLE_MARKET_STATUSES } } } } },
} satisfies Prisma.EventInclude;

type SummaryRow = Prisma.EventGetPayload<{ include: typeof SUMMARY_INCLUDE }>;
type EventRow = Prisma.EventGetPayload<{ include: typeof EVENT_BASE_INCLUDE }>;
type MarketRow = Prisma.MarketGetPayload<{ include: { selections: true } }>;
type EventFlags = Pick<EventRow, 'status' | 'isActive' | 'tradingSuspended' | 'startTime'>;

export function effectiveEventStatus(event: EventFlags): EventStatus {
  if (event.tradingSuspended && (event.status === 'SCHEDULED' || event.status === 'LIVE'))
    return 'SUSPENDED';
  return event.status;
}

/** What a player can do with a market right now, folding in staff locks and event state. */
export function effectiveMarketStatus(
  market: Pick<MarketRow, 'status' | 'tradingSuspended'>,
  event: EventFlags,
  now: Date,
): MarketStatus {
  if (market.status === 'CLOSED' || market.status === 'SETTLED') return market.status;
  if (event.status === 'FINISHED' || event.status === 'CANCELLED' || event.status === 'POSTPONED')
    return 'CLOSED';
  if (
    market.tradingSuspended ||
    event.tradingSuspended ||
    !event.isActive ||
    event.status === 'SUSPENDED' ||
    (event.status === 'SCHEDULED' && event.startTime <= now)
  ) {
    return 'SUSPENDED';
  }
  return market.status;
}

function effectiveSelectionStatus(
  status: SelectionStatus,
  marketStatus: MarketStatus,
): SelectionStatus {
  if (marketStatus === 'OPEN') return status;
  if (marketStatus === 'SUSPENDED') return status === 'CLOSED' ? 'CLOSED' : 'SUSPENDED';
  return 'CLOSED';
}

export function toMarketDto(market: MarketRow, event: EventFlags, now: Date): MarketDto {
  const status = effectiveMarketStatus(market, event, now);
  return {
    id: market.id,
    eventId: market.eventId,
    type: market.type,
    name: market.name,
    line: decimalToNumber(market.line),
    status,
    selections: [...market.selections]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((s) => ({
        id: s.id,
        marketId: s.marketId,
        name: s.name,
        outcome: s.outcome,
        odds: oddsToMilli(s.odds) / 1000,
        status: effectiveSelectionStatus(s.status, status),
        oddsVersion: s.oddsVersion,
        playerId: s.playerId,
      })),
  };
}

function toSummary(
  event: EventRow,
  mainMarket: MarketRow | null,
  marketCount: number,
  now: Date,
): EventSummaryDto {
  const status = effectiveEventStatus(event);
  return {
    id: event.id,
    sport: { key: event.sport.key as SportKey, name: event.sport.name },
    league: event.league,
    home: event.homeTeam,
    away: event.awayTeam,
    startTime: event.startTime.toISOString(),
    status,
    isLive: event.status === 'LIVE',
    score: event.homeScore == null ? null : { home: event.homeScore, away: event.awayScore ?? 0 },
    liveState: parseLiveState(event.liveState),
    dataSource: { provider: event.provider, isSimulated: isSimulatedProvider(event.provider) },
    mainMarket: mainMarket ? toMarketDto(mainMarket, event, now) : null,
    marketCount,
  };
}

const summarize = (row: SummaryRow, now: Date) =>
  toSummary(row, row.markets[0] ?? null, row._count.markets, now);

export class CatalogService {
  constructor(
    private readonly db: PrismaClient,
    private readonly cache: JsonCache,
    private readonly now: () => Date,
  ) {}

  /** Public listing filter: active, not over, and (pre-match) not yet started. */
  private openEventsWhere(now: Date): Prisma.EventWhereInput {
    return {
      isActive: true,
      OR: [
        { status: 'LIVE' },
        { status: 'SUSPENDED' },
        { status: 'SCHEDULED', startTime: { gt: now } },
      ],
    };
  }

  async listSports(): Promise<SportDto[]> {
    return this.cache.wrap('catalog:sports', 5, async () => {
      const now = this.now();
      const [sports, open, live] = await Promise.all([
        this.db.sport.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } }),
        this.db.event.groupBy({
          by: ['sportId'],
          where: this.openEventsWhere(now),
          _count: { _all: true },
        }),
        this.db.event.groupBy({
          by: ['sportId'],
          where: { isActive: true, status: 'LIVE' },
          _count: { _all: true },
        }),
      ]);
      const count = (rows: typeof open, id: string) =>
        rows.find((r) => r.sportId === id)?._count._all ?? 0;
      return sports.map((s) => ({
        id: s.id,
        key: s.key as SportKey,
        name: s.name,
        eventCount: count(open, s.id),
        liveCount: count(live, s.id),
      }));
    });
  }

  async getSport(key: SportKey): Promise<{ sport: SportDto; leagues: LeagueDto[] }> {
    const sports = await this.listSports();
    const sport = sports.find((s) => s.key === key);
    if (!sport) throw new AppError('NOT_FOUND', 'Sportart nicht gefunden.');
    const leagues = await this.cache.wrap(`catalog:leagues:${key}`, 5, async () => {
      const now = this.now();
      const [rows, counts] = await Promise.all([
        this.db.league.findMany({
          where: { sportId: sport.id, isActive: true },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        }),
        this.db.event.groupBy({
          by: ['leagueId'],
          where: { sportId: sport.id, ...this.openEventsWhere(now) },
          _count: { _all: true },
        }),
      ]);
      return rows
        .map((l) => ({
          id: l.id,
          name: l.name,
          country: l.country,
          sportKey: key,
          eventCount: counts.find((c) => c.leagueId === l.id)?._count._all ?? 0,
        }))
        .filter((l) => l.eventCount > 0);
    });
    return { sport, leagues };
  }

  async listEvents(query: EventListQuery): Promise<Paginated<EventSummaryDto>> {
    const key = `catalog:events:${JSON.stringify(query)}`;
    return this.cache.wrap(key, 3, async () => {
      const now = this.now();
      const where: Prisma.EventWhereInput = { isActive: true };
      if (query.sport) where.sport = { key: query.sport };
      if (query.league) where.leagueId = query.league;
      if (query.status === 'live') {
        where.status = { in: ['LIVE', 'SUSPENDED'] };
      } else if (query.status === 'upcoming') {
        where.status = 'SCHEDULED';
        where.startTime = {
          gt: now,
          ...(query.withinHours
            ? { lte: new Date(now.getTime() + query.withinHours * 3_600_000) }
            : {}),
        };
        if (query.day) {
          const [from, to] = berlinDay(query.day);
          where.startTime = { gt: from > now ? from : now, lt: to };
        }
      } else {
        Object.assign(where, this.openEventsWhere(now));
      }
      const rows = await this.db.event.findMany({
        where,
        include: SUMMARY_INCLUDE,
        orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
        ...cursorArgs(query.cursor, query.limit),
      });
      return page(rows, query.limit, (row) => summarize(row, now));
    });
  }

  async getEvent(id: string): Promise<EventDetailDto> {
    return this.cache.wrap(`catalog:event:${id}`, 2, async () => {
      const now = this.now();
      const event = await this.db.event.findUnique({
        where: { id },
        include: {
          ...EVENT_BASE_INCLUDE,
          markets: {
            where: { status: { in: VISIBLE_MARKET_STATUSES } },
            include: { selections: true },
            orderBy: { sortOrder: 'asc' },
          },
        },
      });
      if (!event || !event.isActive) throw new AppError('NOT_FOUND', 'Event nicht gefunden.');
      const over = event.status === 'FINISHED' || event.status === 'CANCELLED';
      const markets = over ? [] : event.markets.map((m) => toMarketDto(m, event, now));
      const main =
        event.markets.find((m) => (MAIN_MARKETS as readonly string[]).includes(m.type)) ?? null;
      return {
        ...toSummary(event, over ? null : main, markets.length, now),
        statistics: parseStatistics(event.statistics),
        markets,
      };
    });
  }

  /** Selections of a shared bet slip, as the book holds them now. */
  async sharedSelections(ids: string[]): Promise<SharedSelectionDto[]> {
    const rows = await this.db.selection.findMany({
      where: { id: { in: ids } },
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
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.flatMap((id) => {
      const s = byId.get(id);
      if (!s) return [];
      const { market } = s;
      const { event } = market;
      return [
        {
          selectionId: s.id,
          selectionName: s.name,
          outcome: s.outcome,
          odds: oddsToMilli(s.odds) / 1000,
          open:
            s.status === 'OPEN' &&
            market.status === 'OPEN' &&
            !market.tradingSuspended &&
            event.isActive &&
            !event.tradingSuspended &&
            (event.status === 'SCHEDULED' || event.status === 'LIVE'),
          marketId: market.id,
          marketName: market.name,
          marketType: market.type,
          eventId: event.id,
          eventName: `${event.homeTeam.name} – ${event.awayTeam.name}`,
          sportKey: event.sport.key as SportKey,
          startTime: event.startTime.toISOString(),
          isLive: event.status === 'LIVE',
        },
      ];
    });
  }

  async getMarkets(id: string): Promise<MarketDto[]> {
    return (await this.getEvent(id)).markets;
  }
}
