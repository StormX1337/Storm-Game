import type { EventStatus, LiveState, MarketType, Pair, SportKey } from '@storm-bet/types';
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
  errorDetail,
  marketGate,
  numberHeader,
  scoreStatistics,
  slug,
  SPORT_NAMES,
  type ProviderQuota,
  type RawMarket,
} from './shared';

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
 * Offered are only markets that settle on the final score: 1X2 / match winner,
 * handicap (spread) and over/under. Prices are American odds, converted to
 * decimal; without configured bookmakers the consensus price is used, and a
 * market whose prices leave the book without margin is not offered.
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

interface SgoEvent {
  eventID?: string;
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

/** Bet types taken per sport; each settles on the final score. */
const MARKET_FOR: Record<SportKey, Partial<Record<string, MarketType>>> = {
  football: { ml3way: 'MATCH_RESULT', sp: 'ASIAN_HANDICAP', ou: 'TOTAL_GOALS' },
  basketball: { ml: 'MATCH_WINNER', sp: 'POINT_SPREAD', ou: 'TOTAL_POINTS' },
  tennis: { ml: 'MATCH_WINNER' },
};

/** Periods whose lines are taken, in order of preference (football bets are on regular time). */
const PERIODS: Record<SportKey, string[]> = {
  football: ['reg', 'game'],
  basketball: ['game'],
  tennis: ['game'],
};

/** Football periods that belong to regular time; anything else means extra time or penalties. */
const FOOTBALL_REGULAR = new Set(['game', 'reg', '1h', '2h']);

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
        const data = await this.fetchEvents({ eventIDs: chunk.join(',') });
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
    const byId = new Map(remote.map((l) => [l.leagueID ?? '', l]));
    const data: League[] = [];
    for (const id of this.options.leagues) {
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

  private team(league: League, team: SgoTeam, name: string): ProviderTeam {
    return {
      externalId: team.teamID ?? `${league.id}:${slug(name)}`,
      name,
      shortName: team.names?.short?.slice(0, 5) || shortName(name),
      players: [],
    };
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
    let resultFinal = false;
    let liveState: LiveState | null;
    if (st.cancelled) {
      // Settled as void (odds 1.00), as the terms state for cancelled events.
      status = 'CANCELLED';
      resultFinal = true;
      liveState = null;
    } else if (st.finalized || st.completed || st.ended) {
      status = 'FINISHED';
      const final = this.finalScore(league.sport, event);
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
      home: this.team(league, home, homeName),
      away: this.team(league, away, awayName),
      startTime: new Date(startsAt).toISOString(),
      status,
      score,
      liveState,
      statistics: score ? scoreStatistics(league.sport, score) : null,
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

  private buildMarkets(sport: SportKey, stored: Stored, event: ProviderEvent): ProviderMarket[] {
    const gate = marketGate({
      eventStatus: event.status,
      exhausted: this.quotaState.exhausted,
      liveBetting: this.options.liveBetting,
      ageMs: this.now() - stored.fetchedAt,
      liveMaxAgeMs: this.options.liveMaxAgeMs,
    });
    const odds = Object.values(stored.event.odds ?? {}).filter(
      (o) => o.statID === 'points' && !o.playerID && !o.ended && !o.cancelled,
    );
    const bookmaker = this.pickBookmaker(sport, odds);
    const names = { home: event.home.name, away: event.away.name };
    const markets: ProviderMarket[] = [];
    for (const [betType, type] of Object.entries(MARKET_FOR[sport])) {
      if (!type) continue;
      for (const periodID of PERIODS[sport]) {
        const inPeriod = odds.filter((o) => o.betTypeID === betType && o.periodID === periodID);
        const raw = this.rawMarket(betType, inPeriod, bookmaker);
        const market = raw ? buildMarket(type, raw, names, gate) : null;
        if (market) {
          markets.push(market);
          break;
        }
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
