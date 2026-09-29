import type {
  BasketballStatistics,
  EventStatistics,
  EventStatus,
  FootballStatistics,
  LiveState,
  MarketType,
  Pair,
  PlayerStatLine,
  SportKey,
} from '@storm-bet/types';
import { shortName } from '../mock/catalog';
import {
  ProviderError,
  ProviderRateLimitedError,
  type EventQuery,
  type OddsProvider,
  type ProviderEvent,
  type ProviderLeague,
  type ProviderMarket,
  type ProviderSport,
  type ProviderTeam,
} from '../provider';
import {
  americanToDecimal,
  buildMarket,
  buildPlayerTotalMarket,
  buildScorerMarket,
  errorDetail,
  marketGate,
  numberHeader,
  scoreStatistics,
  slug,
  SPORT_NAMES,
  type PlayerQuote,
  type ProviderQuota,
  type RawMarket,
} from './shared';
import { deriveFootballMarkets } from './derived';

/**
 * SportsGameOdds (https://sportsgameodds.com), API v2 — bookmaker odds,
 * live scores and official results in one event object.
 *
 * Usage is metered per event object returned (not per market or bookmaker).
 * The provider therefore keeps one snapshot of all configured leagues,
 * refreshed on a TTL, and re-reads only started, unfinished events at a
 * shorter interval until their result is final. Every OddsProvider method is
 * answered from that snapshot. Below a reserve of remaining objects it stops
 * refreshing and suspends all markets.
 *
 * Offered are only markets the official result object can settle: 1X2 /
 * match winner, handicap (spread) and over/under for the full game and the
 * halves, the anytime goalscorer and basketball player points, rebounds and
 * assists. Prices are American odds, converted to decimal; without configured
 * bookmakers the consensus price is used, and a market whose prices leave the
 * book without margin is not offered.
 */

export interface SportsGameOddsOptions {
  apiKey: string;
  baseUrl?: string;
  /** leagueIDs, e.g. BUNDESLIGA, EPL, NBA, ATP. */
  leagues: string[];
  /** Preferred bookmakerIDs, in order; empty = consensus of all bookmakers. */
  bookmakers: string[];
  /** How far ahead fixtures are imported. */
  horizonHours: number;
  /** Refresh of the full snapshot (upcoming and running events). */
  oddsTtlMs: number;
  /** Refresh of started, not yet final events (scores and results). */
  liveTtlMs: number;
  /** Stop fetching below this many remaining objects in the monthly quota. */
  minRemainingObjects: number;
  liveBetting: boolean;
  liveMaxAgeMs: number;
  fetch?: typeof fetch;
  now?: () => number;
}

interface SgoLeague {
  leagueID?: string;
  sportID?: string;
  name?: string;
  shortName?: string;
  enabled?: boolean;
}

interface SgoTeam {
  teamID?: string;
  names?: { long?: string; medium?: string; short?: string };
  score?: number;
}

interface SgoBookmakerOdds {
  odds?: string;
  spread?: string;
  overUnder?: string;
  available?: boolean;
}

interface SgoOdd {
  oddID?: string;
  statID?: string;
  statEntityID?: string;
  periodID?: string;
  betTypeID?: string;
  sideID?: string;
  playerID?: string;
  ended?: boolean;
  cancelled?: boolean;
  bookOdds?: string;
  bookSpread?: string;
  bookOverUnder?: string;
  bookOddsAvailable?: boolean;
  byBookmaker?: Record<string, SgoBookmakerOdds>;
}

interface SgoStatus {
  startsAt?: string;
  started?: boolean;
  live?: boolean;
  ended?: boolean;
  completed?: boolean;
  finalized?: boolean;
  cancelled?: boolean;
  periods?: { started?: string[]; ended?: string[] };
}

interface SgoPlayer {
  playerID?: string;
  teamID?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
}

interface SgoEvent {
  eventID?: string;
  players?: Record<string, SgoPlayer>;
  sportID?: string;
  leagueID?: string;
  teams?: { home?: SgoTeam; away?: SgoTeam };
  status?: SgoStatus;
  odds?: Record<string, SgoOdd>;
  /** `{periodID}.{statEntityID}.{statID} → number` */
  results?: Record<string, Record<string, Record<string, number>>>;
}

interface SgoPage<T> {
  success?: boolean;
  error?: string;
  data?: T[];
  nextCursor?: string;
}

interface SgoUsage {
  rateLimits?: Record<
    string,
    { 'current-entities'?: number; 'max-entities'?: number | 'unlimited' } | undefined
  >;
}

interface League {
  id: string;
  sport: SportKey;
  name: string;
}

interface Stored {
  event: SgoEvent;
  fetchedAt: number;
}

const SPORT_FOR: Record<string, SportKey> = {
  SOCCER: 'football',
  BASKETBALL: 'basketball',
  TENNIS: 'tennis',
};

/** Used when the leagues endpoint is unavailable. */
const KNOWN_LEAGUES: Record<string, { sportID: string; name: string }> = {
  BUNDESLIGA: { sportID: 'SOCCER', name: 'Bundesliga' },
  EPL: { sportID: 'SOCCER', name: 'Premier League' },
  LA_LIGA: { sportID: 'SOCCER', name: 'La Liga' },
  IT_SERIE_A: { sportID: 'SOCCER', name: 'Serie A' },
  FR_LIGUE_1: { sportID: 'SOCCER', name: 'Ligue 1' },
  UEFA_CHAMPIONS_LEAGUE: { sportID: 'SOCCER', name: 'UEFA Champions League' },
  UEFA_EUROPA_LEAGUE: { sportID: 'SOCCER', name: 'UEFA Europa League' },
  MLS: { sportID: 'SOCCER', name: 'MLS' },
  NBA: { sportID: 'BASKETBALL', name: 'NBA' },
  WNBA: { sportID: 'BASKETBALL', name: 'WNBA' },
  NCAAB: { sportID: 'BASKETBALL', name: 'NCAA Basketball' },
  ATP: { sportID: 'TENNIS', name: 'ATP' },
  WTA: { sportID: 'TENNIS', name: 'WTA' },
};

/** periodIDs of the halves (the feed's docs use both spellings). */
const H1 = ['1h', 'h1'];
const H2 = ['2h', 'h2'];
const QUARTERS = [
  ['1q', 'q1'],
  ['2q', 'q2'],
  ['3q', 'q3'],
  ['4q', 'q4'],
];

/**
 * Team markets per sport: the feed's bet type and the periods it is read
 * from, in order of preference (football full-time bets are on regular time).
 */
const TEAM_MARKETS: Record<SportKey, { type: MarketType; betType: string; periods: string[] }[]> = {
  football: [
    { type: 'MATCH_RESULT', betType: 'ml3way', periods: ['reg', 'game'] },
    { type: 'ASIAN_HANDICAP', betType: 'sp', periods: ['reg', 'game'] },
    { type: 'TOTAL_GOALS', betType: 'ou', periods: ['reg', 'game'] },
    { type: 'HALF_TIME_RESULT', betType: 'ml3way', periods: H1 },
    { type: 'FIRST_HALF_HANDICAP', betType: 'sp', periods: H1 },
    { type: 'FIRST_HALF_TOTAL_GOALS', betType: 'ou', periods: H1 },
    { type: 'SECOND_HALF_RESULT', betType: 'ml3way', periods: H2 },
    { type: 'SECOND_HALF_TOTAL_GOALS', betType: 'ou', periods: H2 },
  ],
  basketball: [
    { type: 'MATCH_WINNER', betType: 'ml', periods: ['game'] },
    { type: 'POINT_SPREAD', betType: 'sp', periods: ['game'] },
    { type: 'TOTAL_POINTS', betType: 'ou', periods: ['game'] },
    { type: 'FIRST_HALF_WINNER', betType: 'ml', periods: H1 },
    { type: 'FIRST_HALF_SPREAD', betType: 'sp', periods: H1 },
    { type: 'FIRST_HALF_TOTAL_POINTS', betType: 'ou', periods: H1 },
  ],
  tennis: [{ type: 'MATCH_WINNER', betType: 'ml', periods: ['game'] }],
};

/** Basketball player over/under markets by the feed's statID. */
const PLAYER_TOTALS: [string, MarketType][] = [
  ['points', 'PLAYER_POINTS'],
  ['rebounds', 'PLAYER_REBOUNDS'],
  ['assists', 'PLAYER_ASSISTS'],
];

/** Player figures kept from the official result, per sport. */
const PLAYER_FIGURES: Record<SportKey, ('goals' | 'points' | 'rebounds' | 'assists')[]> = {
  football: ['goals'],
  basketball: ['points', 'rebounds', 'assists'],
  tennis: [],
};

const TEAM_ENTITIES = new Set(['home', 'away', 'all']);

/** Football periods that belong to regular time; anything else means extra time or penalties. */
const FOOTBALL_REGULAR = new Set(['game', 'reg', ...H1, ...H2]);

const PAGE_SIZE = 50;
const MAX_PAGES = 20;
const USAGE_TTL_MS = 10 * 60_000;
const LEAGUES_TTL_MS = 3_600_000;
const NOT_FOUND_TTL_MS = 3_600_000;
const KEEP_FINISHED_MS = 3 * 24 * 3_600_000;

class HttpError extends ProviderError {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message, status >= 500);
  }
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pairOf(home: unknown, away: unknown): Pair | null {
  const h = num(home);
  const a = num(away);
  if (h === null || a === null || !Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0)
    return null;
  return { home: h, away: a };
}

export class SportsGameOddsProvider implements OddsProvider {
  readonly key = 'sportsgameodds';
  readonly name = 'SportsGameOdds';
  readonly isSimulated = false;

  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly baseUrl: string;
  private leaguesSnapshot: { data: League[]; fetchedAt: number } | null = null;
  private readonly events = new Map<string, Stored>();
  private readonly lookups = new Set<string>();
  private readonly notFound = new Map<string, number>();
  private snapshotAt = 0;
  private liveAt = 0;
  private usageAt = 0;
  private refreshing: Promise<void> | null = null;
  private quotaState: ProviderQuota = {
    remaining: null,
    used: null,
    lastCost: null,
    exhausted: false,
  };

  constructor(private readonly options: SportsGameOddsOptions) {
    if (!options.apiKey)
      throw new ProviderError('SportsGameOdds requires an API key (SGO_API_KEY)', false);
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.baseUrl = (options.baseUrl ?? 'https://api.sportsgameodds.com/v2').replace(/\/$/, '');
  }

  /** The plan has no monthly object limit. */
  unlimited = false;

  getQuota(): ProviderQuota {
    return { ...this.quotaState };
  }

  /** Reads the account usage now (costs no event objects). */
  async loadQuota(): Promise<ProviderQuota> {
    this.usageAt = 0;
    await this.refreshUsage();
    return this.getQuota();
  }

  // ─── OddsProvider ─────────────────────────────────────────────────────────

  async getSports(): Promise<ProviderSport[]> {
    const present = new Set((await this.leagues()).map((l) => l.sport));
    return (Object.keys(SPORT_NAMES) as SportKey[])
      .filter((key) => present.has(key))
      .map((key) => ({ key, name: SPORT_NAMES[key] }));
  }

  async getLeagues(sportKey?: SportKey): Promise<ProviderLeague[]> {
    return (await this.leagues())
      .filter((l) => !sportKey || l.sport === sportKey)
      .map((l) => ({ externalId: l.id, sportKey: l.sport, name: l.name, country: null }));
  }

  async getEvents(query: EventQuery): Promise<ProviderEvent[]> {
    const from = Date.parse(query.from);
    const to = Date.parse(query.to);
    return (await this.allEvents(query.sportKey)).filter((e) => {
      const start = Date.parse(e.startTime);
      return start >= from && start <= to;
    });
  }

  async getEvent(externalId: string): Promise<ProviderEvent | null> {
    await this.refresh();
    const stored = this.events.get(externalId);
    const leagues = await this.leagueMap();
    const league = stored ? leagues.get(stored.event.leagueID ?? '') : undefined;
    if (stored && league) return this.toEvent(stored.event, league);
    // Unknown here (e.g. after a restart): looked up with the next refresh.
    const missSince = this.notFound.get(externalId);
    if (!stored && (missSince === undefined || this.now() - missSince > NOT_FOUND_TTL_MS))
      this.lookups.add(externalId);
    return null;
  }

  async getMarkets(eventExternalId: string): Promise<ProviderMarket[]> {
    await this.refresh();
    const stored = this.events.get(eventExternalId);
    const league = stored && (await this.leagueMap()).get(stored.event.leagueID ?? '');
    if (!stored || !league) return [];
    const event = this.toEvent(stored.event, league);
    if (!event) return [];
    return this.buildMarkets(league.sport, stored, event);
  }

  async getLiveEvents(sportKey?: SportKey): Promise<ProviderEvent[]> {
    return (await this.allEvents(sportKey)).filter((e) => e.status === 'LIVE');
  }

  // ─── snapshot ─────────────────────────────────────────────────────────────

  private async allEvents(sportKey?: SportKey): Promise<ProviderEvent[]> {
    await this.refresh();
    const leagues = await this.leagueMap();
    const out: ProviderEvent[] = [];
    for (const { event } of this.events.values()) {
      const league = leagues.get(event.leagueID ?? '');
      if (!league || (sportKey && league.sport !== sportKey)) continue;
      const mapped = this.toEvent(event, league);
      if (mapped) out.push(mapped);
    }
    return out.sort((a, b) => a.startTime.localeCompare(b.startTime));
  }

  /**
   * What the last snapshot contained and why events were left out — for
   * `odds:check --with-odds` when a feed shows fewer events than expected.
   */
  async diagnostics() {
    await this.refresh();
    const leagues = await this.leagueMap();
    let mapped = 0;
    let markets = 0;
    const skipped: Record<string, number> = {};
    for (const stored of this.events.values()) {
      const league = leagues.get(stored.event.leagueID ?? '');
      const event = league ? this.toEvent(stored.event, league) : null;
      const reason = !league
        ? `Liga nicht aktiv: ${stored.event.leagueID ?? '?'}`
        : !event
          ? 'Teams, Namen oder Startzeit fehlen'
          : null;
      if (reason) skipped[reason] = (skipped[reason] ?? 0) + 1;
      else {
        mapped++;
        markets += this.buildMarkets(league!.sport, stored, event!).length;
      }
    }
    const first = this.events.values().next().value?.event;
    return {
      fetched: this.events.size,
      mapped,
      markets,
      skipped,
      sample: first
        ? {
            keys: Object.keys(first),
            status: first.status,
            home: first.teams?.home?.names,
            odds: Object.keys(first.odds ?? {}).slice(0, 8),
          }
        : null,
    };
  }

  private refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    await this.refreshUsage();
    const leagues = await this.leagues();
    if (leagues.length === 0 || this.quotaState.exhausted) return;
    const now = this.now();

    if (now - this.snapshotAt >= this.options.oddsTtlMs) {
      const data = await this.fetchEvents({
        leagueID: leagues.map((l) => l.id).join(','),
        finalized: 'false',
        // Every returned event is billed: skip long-past fixtures that never got finalized.
        startsAfter: new Date(now - 12 * 3_600_000).toISOString(),
        startsBefore: new Date(now + this.options.horizonHours * 3_600_000).toISOString(),
      });
      const seen = new Set<string>();
      for (const event of data) {
        if (!event.eventID) continue;
        seen.add(event.eventID);
        this.events.set(event.eventID, { event, fetchedAt: now });
      }
      // A fixture that left the feed before kick-off is no longer offered.
      for (const [id, stored] of this.events) {
        if (!seen.has(id) && !this.hasStarted(stored.event, now)) this.events.delete(id);
      }
      this.snapshotAt = now;
    }

    const pending = [...this.events.values()]
      .filter((s) => this.awaitsResult(s.event, now))
      .map((s) => s.event.eventID!);
    const ids = [...new Set([...pending, ...this.lookups])];
    if (ids.length && !this.quotaState.exhausted && now - this.liveAt >= this.options.liveTtlMs) {
      for (let i = 0; i < ids.length; i += PAGE_SIZE) {
        const chunk = ids.slice(i, i + PAGE_SIZE);
        // Full box scores: player figures settle the player markets.
        const data = await this.fetchEvents({ eventIDs: chunk.join(','), expandResults: 'true' });
        const found = new Set<string>();
        for (const event of data) {
          if (!event.eventID) continue;
          found.add(event.eventID);
          this.events.set(event.eventID, { event, fetchedAt: now });
        }
        for (const id of chunk) {
          this.lookups.delete(id);
          if (!found.has(id)) this.notFound.set(id, now);
        }
      }
      this.liveAt = now;
    }

    for (const [id, since] of this.notFound) {
      if (now - since > NOT_FOUND_TTL_MS) this.notFound.delete(id);
    }
    for (const [id, stored] of this.events) {
      const start = Date.parse(stored.event.status?.startsAt ?? '');
      const over = stored.event.status?.finalized || stored.event.status?.cancelled;
      if (over && now - start > KEEP_FINISHED_MS) this.events.delete(id);
    }
  }

  private hasStarted(event: SgoEvent, now: number): boolean {
    const st = event.status ?? {};
    return !!(st.started || st.live || Date.parse(st.startsAt ?? '') <= now);
  }

  private awaitsResult(event: SgoEvent, now: number): boolean {
    const st = event.status ?? {};
    return this.hasStarted(event, now) && !st.finalized && !st.cancelled;
  }

  private async fetchEvents(params: Record<string, string>): Promise<SgoEvent[]> {
    // Pinned bookmakers: only their prices are downloaded (events are large).
    if (this.options.bookmakers.length)
      params = { ...params, bookmakerID: this.options.bookmakers.join(',') };
    const out: SgoEvent[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await this.request<SgoPage<SgoEvent>>('/events', {
        ...params,
        limit: String(PAGE_SIZE),
        ...(cursor ? { cursor } : {}),
      });
      const data = body.data ?? [];
      out.push(...data);
      this.countObjects(data.length);
      cursor = body.nextCursor || undefined;
      if (!cursor || this.quotaState.exhausted) break;
    }
    return out;
  }

  private remoteLeagues: SgoLeague[] = [];

  /**
   * Every league the key can access, marked by whether this book can offer
   * its sport (football, basketball, tennis) and whether it is configured.
   */
  async availableLeagues(): Promise<
    { id: string; name: string; sportID: string; supported: boolean; active: boolean }[]
  > {
    const active = new Set((await this.leagues()).map((l) => l.id));
    return this.remoteLeagues
      .filter((l) => l.leagueID && l.enabled !== false)
      .map((l) => ({
        id: l.leagueID!,
        name: l.name ?? l.leagueID!,
        sportID: l.sportID ?? '',
        supported: SPORT_FOR[l.sportID ?? ''] !== undefined,
        active: active.has(l.leagueID!),
      }));
  }

  private async leagues(): Promise<League[]> {
    const now = this.now();
    if (this.leaguesSnapshot && now - this.leaguesSnapshot.fetchedAt < LEAGUES_TTL_MS)
      return this.leaguesSnapshot.data;
    let remote: SgoLeague[] = [];
    try {
      remote = (await this.request<SgoPage<SgoLeague>>('/leagues', {})).data ?? [];
    } catch (error) {
      if (error instanceof HttpError && (error.status === 401 || error.status === 403)) throw error;
      // Otherwise fall back to the built-in league list.
    }
    this.remoteLeagues = remote;
    const byId = new Map(remote.map((l) => [l.leagueID ?? '', l]));
    // "*" takes every league of a supported sport the key can access.
    const wanted = this.options.leagues.includes('*')
      ? [
          ...new Set([
            ...this.options.leagues.filter((id) => id !== '*'),
            ...(remote.length
              ? remote.flatMap((l) => (l.leagueID ? [l.leagueID] : []))
              : Object.keys(KNOWN_LEAGUES)),
          ]),
        ]
      : this.options.leagues;
    const data: League[] = [];
    for (const id of wanted) {
      const r = byId.get(id);
      const known = KNOWN_LEAGUES[id];
      if (r?.enabled === false) continue;
      const sport = SPORT_FOR[r?.sportID ?? known?.sportID ?? ''];
      if (!sport) continue;
      data.push({ id, sport, name: r?.name ?? known?.name ?? id });
    }
    this.leaguesSnapshot = { data, fetchedAt: now };
    return data;
  }

  private async leagueMap(): Promise<Map<string, League>> {
    return new Map((await this.leagues()).map((l) => [l.id, l]));
  }

  // ─── mapping ──────────────────────────────────────────────────────────────

  private team(league: League, team: SgoTeam, name: string, event: SgoEvent): ProviderTeam {
    const roster = team.teamID
      ? [...this.roster(event)].filter(([, p]) => p.teamID === team.teamID)
      : [];
    return {
      externalId: team.teamID ?? `${league.id}:${slug(name)}`,
      name,
      shortName: team.names?.short?.slice(0, 5) || shortName(name),
      players: roster.map(([externalId, p]) => ({ externalId, name: p.name, position: null })),
    };
  }

  /** Players of this event's two teams, by the feed's playerID. */
  private roster(event: SgoEvent): Map<string, { name: string; teamID: string }> {
    const teams = new Set([event.teams?.home?.teamID, event.teams?.away?.teamID]);
    const out = new Map<string, { name: string; teamID: string }>();
    for (const [key, p] of Object.entries(event.players ?? {})) {
      const id = p.playerID ?? key;
      const name = (p.name ?? [p.firstName, p.lastName].filter(Boolean).join(' ')).trim();
      if (!name || !p.teamID || !teams.has(p.teamID)) continue;
      out.set(id, { name: name.slice(0, 80), teamID: p.teamID });
    }
    return out;
  }

  private toEvent(event: SgoEvent, league: League): ProviderEvent | null {
    const home = event.teams?.home;
    const away = event.teams?.away;
    const homeName = home?.names?.long ?? home?.names?.medium;
    const awayName = away?.names?.long ?? away?.names?.medium;
    const startsAt = Date.parse(event.status?.startsAt ?? '');
    if (!event.eventID || !home || !away || !homeName || !awayName || Number.isNaN(startsAt))
      return null;
    const st = event.status ?? {};
    const live = pairOf(home.score, away.score);

    let status: EventStatus;
    let score: Pair | null = null;
    let final: Pair | null = null;
    let resultFinal = false;
    let liveState: LiveState | null;
    if (st.cancelled) {
      // Settled as void (odds 1.00), as the terms state for cancelled events.
      status = 'CANCELLED';
      resultFinal = true;
      liveState = null;
    } else if (st.finalized || st.completed || st.ended) {
      status = 'FINISHED';
      final = this.finalScore(league.sport, event);
      score = final ?? live;
      resultFinal = !!st.finalized && final !== null;
      liveState = { period: 'FT', clock: null };
    } else if (this.hasStarted(event, this.now())) {
      status = 'LIVE';
      score = live;
      liveState = { period: 'LIVE', clock: null };
    } else {
      status = 'SCHEDULED';
      liveState = { period: 'PRE', clock: null };
    }
    return {
      externalId: event.eventID,
      sportKey: league.sport,
      leagueExternalId: league.id,
      home: this.team(league, home, homeName, event),
      away: this.team(league, away, awayName, event),
      startTime: new Date(startsAt).toISOString(),
      status,
      score,
      liveState,
      statistics: final
        ? this.resultStatistics(league.sport, event, final)
        : score
          ? scoreStatistics(league.sport, score)
          : null,
      resultFinal,
    };
  }

  /**
   * The score bets are settled on, or null when it cannot be determined safely.
   * Football settles on regular time: after extra time or penalties the result
   * is left to staff rather than guessed.
   */
  private finalScore(sport: SportKey, event: SgoEvent): Pair | null {
    const results = event.results ?? {};
    const period = (id: string) => pairOf(results[id]?.home?.points, results[id]?.away?.points);
    const teams = pairOf(event.teams?.home?.score, event.teams?.away?.score);
    if (sport !== 'football') return period('game') ?? teams;
    const periods = [
      ...(event.status?.periods?.started ?? []),
      ...(event.status?.periods?.ended ?? []),
      ...Object.keys(results),
    ];
    if (periods.some((p) => !FOOTBALL_REGULAR.has(p))) return null;
    return period('reg') ?? period('game') ?? teams;
  }

  /** Official figures: the score, the halves and player stat lines — only what the feed reports. */
  private resultStatistics(sport: SportKey, event: SgoEvent, final: Pair): EventStatistics {
    const results = event.results ?? {};
    const period = (ids: string[]) => {
      for (const id of ids) {
        const pair = pairOf(results[id]?.home?.points, results[id]?.away?.points);
        if (pair) return pair;
      }
      return null;
    };
    const stats = scoreStatistics(sport, final);
    if (stats.sport === 'football') {
      const football: FootballStatistics = { ...stats };
      const firstHalf = period(H1);
      const secondHalf = period(H2);
      if (firstHalf) football.firstHalf = firstHalf;
      if (secondHalf) football.secondHalf = secondHalf;
      const players = this.playerLines(sport, event);
      if (players) football.players = players;
      return football;
    }
    if (stats.sport === 'basketball') {
      const basketball: BasketballStatistics = { ...stats };
      const quarters = QUARTERS.map(period);
      if (quarters.every((q) => q !== null)) basketball.periods = quarters as Pair[];
      const firstHalf = period(H1);
      if (firstHalf) basketball.firstHalf = firstHalf;
      const players = this.playerLines(sport, event);
      if (players) basketball.players = players;
      return basketball;
    }
    return stats;
  }

  /**
   * Player stat lines from the full-game result (football regular time: a game
   * with extra time never gets here). Undefined when the feed reports none.
   */
  private playerLines(sport: SportKey, event: SgoEvent): PlayerStatLine[] | undefined {
    const figures = PLAYER_FIGURES[sport];
    const game = event.results?.game ?? event.results?.reg;
    if (!game || figures.length === 0) return undefined;
    const roster = this.roster(event);
    const lines: PlayerStatLine[] = [];
    for (const [entity, values] of Object.entries(game)) {
      if (TEAM_ENTITIES.has(entity)) continue;
      const stats: PlayerStatLine['stats'] = {};
      for (const figure of figures) {
        const value = num(values?.[figure]);
        if (value !== null && Number.isInteger(value) && value >= 0) stats[figure] = value;
      }
      if (Object.keys(stats).length === 0) continue;
      lines.push({ playerId: entity, name: roster.get(entity)?.name ?? null, stats });
    }
    return lines.length ? lines : undefined;
  }

  private buildMarkets(sport: SportKey, stored: Stored, event: ProviderEvent): ProviderMarket[] {
    const gate = marketGate({
      eventStatus: event.status,
      exhausted: this.quotaState.exhausted,
      liveBetting: this.options.liveBetting,
      ageMs: this.now() - stored.fetchedAt,
      liveMaxAgeMs: this.options.liveMaxAgeMs,
    });
    const open = Object.values(stored.event.odds ?? {}).filter((o) => !o.ended && !o.cancelled);
    const odds = open.filter(
      (o) => o.statID === 'points' && !o.playerID && TEAM_ENTITIES.has(o.statEntityID ?? ''),
    );
    const bookmaker = this.pickBookmaker(sport, odds);
    const names = { home: event.home.name, away: event.away.name };
    const markets: ProviderMarket[] = [];
    for (const { type, betType, periods } of TEAM_MARKETS[sport]) {
      for (const periodID of periods) {
        const inPeriod = odds.filter((o) => o.betTypeID === betType && o.periodID === periodID);
        const raw = this.rawMarket(betType, inPeriod, bookmaker);
        const market = raw ? buildMarket(type, raw, names, gate) : null;
        if (market) {
          markets.push(market);
          break;
        }
      }
    }
    if (sport === 'football' && event.status === 'SCHEDULED')
      markets.push(...deriveFootballMarkets(markets, names, gate, { halves: true }));
    markets.push(...this.playerMarkets(sport, stored.event, open, bookmaker, gate));
    return markets;
  }

  /**
   * Player markets for players of the two teams: the anytime goalscorer
   * ("yes" on goals, or over 0.5 goals) and basketball player over/unders.
   */
  private playerMarkets(
    sport: SportKey,
    event: SgoEvent,
    odds: SgoOdd[],
    bookmaker: string | null,
    gate: ReturnType<typeof marketGate>,
  ): ProviderMarket[] {
    const roster = this.roster(event);
    const byPlayer = new Map<string, SgoOdd[]>();
    for (const o of odds) {
      if (!o.playerID || o.statEntityID !== o.playerID || !roster.has(o.playerID)) continue;
      byPlayer.set(o.playerID, [...(byPlayer.get(o.playerID) ?? []), o]);
    }
    if (sport === 'football') {
      const quotes: PlayerQuote[] = [];
      for (const [playerID, list] of byPlayer) {
        const goals = list.filter(
          (o) => o.statID === 'goals' && (o.periodID === 'game' || o.periodID === 'reg'),
        );
        const yes = this.quote(
          goals.find((o) => o.betTypeID === 'yn' && o.sideID === 'yes'),
          bookmaker,
        );
        const over = this.quote(
          goals.find((o) => o.betTypeID === 'ou' && o.sideID === 'over'),
          bookmaker,
        );
        const odds = yes?.odds ?? (over?.overUnder === 0.5 ? over.odds : null);
        if (odds !== null)
          quotes.push({ externalId: playerID, name: roster.get(playerID)!.name, odds });
      }
      const market = buildScorerMarket(quotes, gate);
      return market ? [market] : [];
    }
    if (sport !== 'basketball') return [];
    const markets: ProviderMarket[] = [];
    for (const [playerID, list] of byPlayer) {
      const player = { externalId: playerID, name: roster.get(playerID)!.name };
      for (const [statID, type] of PLAYER_TOTALS) {
        const mine = list.filter(
          (o) => o.statID === statID && o.periodID === 'game' && o.betTypeID === 'ou',
        );
        const over = this.quote(
          mine.find((o) => o.sideID === 'over'),
          bookmaker,
        );
        const under = this.quote(
          mine.find((o) => o.sideID === 'under'),
          bookmaker,
        );
        if (!over || !under || over.overUnder === null || over.overUnder !== under.overUnder)
          continue;
        const market = buildPlayerTotalMarket(
          type,
          player,
          over.overUnder,
          over.odds,
          under.odds,
          gate,
        );
        if (market) markets.push(market);
      }
    }
    return markets;
  }

  /** The first preferred bookmaker quoting the main market; null = consensus prices. */
  private pickBookmaker(sport: SportKey, odds: SgoOdd[]): string | null {
    const main = sport === 'football' ? 'ml3way' : 'ml';
    const mainOdds = odds.filter((o) => o.betTypeID === main);
    for (const bookmaker of this.options.bookmakers) {
      const quoted = mainOdds.some((o) => {
        const b = o.byBookmaker?.[bookmaker];
        return b && b.available !== false && americanToDecimal(b.odds) !== null;
      });
      if (quoted) return bookmaker;
    }
    return null;
  }

  private quote(
    odd: SgoOdd | undefined,
    bookmaker: string | null,
  ): { odds: number | null; spread: number | null; overUnder: number | null } | null {
    if (!odd) return null;
    if (bookmaker) {
      const b = odd.byBookmaker?.[bookmaker];
      if (!b || b.available === false) return null;
      return {
        odds: americanToDecimal(b.odds),
        spread: num(b.spread),
        overUnder: num(b.overUnder),
      };
    }
    if (odd.bookOddsAvailable === false) return null;
    return {
      odds: americanToDecimal(odd.bookOdds),
      spread: num(odd.bookSpread),
      overUnder: num(odd.bookOverUnder),
    };
  }

  private rawMarket(betType: string, odds: SgoOdd[], bookmaker: string | null): RawMarket | null {
    const side = (sideID: string, entity: string) =>
      odds.find((o) => o.sideID === sideID && o.statEntityID === entity) ??
      odds.find((o) => o.sideID === sideID);
    if (betType === 'ml3way') {
      const [h, d, a] = [
        this.quote(side('home', 'home'), bookmaker),
        this.quote(side('draw', 'all'), bookmaker),
        this.quote(side('away', 'away'), bookmaker),
      ];
      if (!h || !d || !a) return null;
      return { kind: 'THREE_WAY', home: h.odds, draw: d.odds, away: a.odds };
    }
    if (betType === 'ml') {
      const [h, a] = [
        this.quote(side('home', 'home'), bookmaker),
        this.quote(side('away', 'away'), bookmaker),
      ];
      if (!h || !a) return null;
      return { kind: 'TWO_WAY', home: h.odds, away: a.odds };
    }
    if (betType === 'sp') {
      const [h, a] = [
        this.quote(side('home', 'home'), bookmaker),
        this.quote(side('away', 'away'), bookmaker),
      ];
      if (!h || !a || h.spread === null || a.spread === null) return null;
      if (Math.abs(h.spread + a.spread) > 1e-9) return null;
      return { kind: 'HANDICAP', line: h.spread, home: h.odds, away: a.odds };
    }
    if (betType === 'ou') {
      // Only the game total (statEntityID "all"), not team totals.
      const over = odds.find((o) => o.sideID === 'over' && o.statEntityID === 'all');
      const under = odds.find((o) => o.sideID === 'under' && o.statEntityID === 'all');
      const [o, u] = [this.quote(over, bookmaker), this.quote(under, bookmaker)];
      if (!o || !u || o.overUnder === null || o.overUnder !== u.overUnder) return null;
      return { kind: 'TOTAL', line: o.overUnder, over: o.odds, under: u.odds };
    }
    return null;
  }

  // ─── quota ────────────────────────────────────────────────────────────────

  private async refreshUsage(): Promise<void> {
    const now = this.now();
    if (now - this.usageAt < USAGE_TTL_MS) return;
    this.usageAt = now;
    let usage: SgoUsage | undefined;
    try {
      usage = (await this.request<{ data?: SgoUsage }>('/account/usage', {})).data;
    } catch (error) {
      if (error instanceof HttpError && (error.status === 401 || error.status === 403)) throw error;
      return; // quota unknown for now; odds keep flowing
    }
    const month = usage?.rateLimits?.['per-month'];
    const max = month?.['max-entities'];
    const current = month?.['current-entities'];
    this.unlimited = max === 'unlimited';
    this.quotaState.used = typeof current === 'number' ? current : this.quotaState.used;
    this.quotaState.remaining =
      typeof max === 'number' && typeof current === 'number' ? Math.max(0, max - current) : null;
    this.updateExhausted();
  }

  /** Between usage reads, every returned event object counts against the quota. */
  private countObjects(n: number): void {
    this.quotaState.lastCost = n;
    if (this.quotaState.used !== null) this.quotaState.used += n;
    if (this.quotaState.remaining !== null)
      this.quotaState.remaining = Math.max(0, this.quotaState.remaining - n);
    this.updateExhausted();
  }

  private updateExhausted(): void {
    const { remaining } = this.quotaState;
    this.quotaState.exhausted = remaining !== null && remaining <= this.options.minRemainingObjects;
  }

  // ─── HTTP ─────────────────────────────────────────────────────────────────

  private async request<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { accept: 'application/json', 'x-api-key': this.options.apiKey },
      });
    } catch (error) {
      throw new ProviderError(
        `SportsGameOdds unreachable: ${error instanceof Error ? error.message : String(error)}`,
        true,
        { cause: error },
      );
    }
    if (response.status === 429) {
      const retryAfter = numberHeader(response.headers, 'retry-after');
      throw new ProviderRateLimitedError((retryAfter ?? 10) * 1000);
    }
    if (!response.ok) {
      const reason = await errorDetail(response);
      throw new HttpError(
        `SportsGameOdds responded ${response.status} for ${path}${reason ? `: ${reason}` : ''}`,
        response.status,
      );
    }
    let body: T & { success?: boolean; error?: unknown };
    try {
      body = (await response.json()) as T & { success?: boolean; error?: unknown };
    } catch (error) {
      throw new ProviderError('SportsGameOdds returned malformed JSON', true, { cause: error });
    }
    if (body && body.success === false) {
      throw new ProviderError(
        `SportsGameOdds rejected ${path}: ${typeof body.error === 'string' ? body.error : 'unknown error'}`,
        false,
      );
    }
    return body;
  }
}
