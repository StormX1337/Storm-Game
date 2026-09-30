import { type MarketType, type Pair, type SportKey } from '@storm-bet/types';
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
import { deriveFootballMarkets } from './derived';

/**
 * The Odds API (https://the-odds-api.com), v4 — a licensed aggregator of
 * bookmaker prices and scores.
 *
 * The API is metered in request credits, so this provider never calls it per
 * event: it keeps one odds snapshot and (only while games are running) one
 * scores snapshot per competition, refreshes them on a configurable TTL and
 * answers every OddsProvider method from those snapshots. When the remaining
 * credits fall below a reserve it stops refreshing and suspends all markets
 * rather than showing prices it cannot keep current.
 *
 * Only markets the feed can also settle are offered: match result/winner,
 * handicaps and totals on the score. Everything else (corners, cards, scorers,
 * set details) is simply absent — never invented.
 */

export interface TheOddsApiOptions {
  apiKey: string;
  baseUrl?: string;
  /** Competition keys to import; a trailing `*` matches every active key with that prefix. */
  sports: string[];
  /** Bookmaker regions, e.g. "eu" (each region costs credits). */
  regions: string;
  /** Preferred bookmakers, in order. All markets of an event come from one bookmaker. */
  bookmakers: string[];
  oddsTtlMs: number;
  scoresTtlMs: number;
  /** Stop spending credits below this many remaining. */
  minRemainingCredits: number;
  /**
   * In-play betting needs prices refreshed every few seconds. With snapshot
   * TTLs of minutes that is not possible, so live markets are suspended unless
   * this is enabled *and* the snapshot is younger than liveMaxAgeMs.
   */
  liveBetting: boolean;
  liveMaxAgeMs: number;
  fetch?: typeof fetch;
  now?: () => number;
}

interface ApiSport {
  key: string;
  group: string;
  title: string;
  description: string;
  active: boolean;
  has_outrights: boolean;
}

interface ApiOutcome {
  name: string;
  price: number;
  point?: number;
}

interface ApiMarket {
  key: string;
  last_update?: string;
  outcomes: ApiOutcome[];
}

interface ApiBookmaker {
  key: string;
  title: string;
  last_update: string;
  markets: ApiMarket[];
}

interface ApiOddsEvent {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: ApiBookmaker[];
}

interface ApiScoresEvent {
  id: string;
  sport_key: string;
  commence_time: string;
  completed: boolean;
  home_team: string;
  away_team: string;
  scores: { name: string; score: string }[] | null;
  last_update: string | null;
}

interface Snapshot<T> {
  data: T;
  fetchedAt: number;
}

const GROUP_TO_SPORT: Record<string, SportKey> = {
  Soccer: 'football',
  Tennis: 'tennis',
  Basketball: 'basketball',
  'Ice Hockey': 'hockey',
  'American Football': 'american_football',
  Baseball: 'baseball',
  Handball: 'handball',
  'Mixed Martial Arts': 'mma',
};

/** Markets requested per sport. Tennis handicaps/totals count games, which the scores feed cannot settle. */
const API_MARKETS: Record<SportKey, string[]> = {
  football: ['h2h', 'spreads', 'totals'],
  basketball: ['h2h', 'spreads', 'totals'],
  tennis: ['h2h'],
  hockey: ['h2h', 'spreads', 'totals'],
  american_football: ['h2h', 'spreads', 'totals'],
  baseball: ['h2h', 'spreads', 'totals'],
  handball: ['h2h', 'spreads', 'totals'],
  mma: ['h2h'],
};

const MARKET_FOR: Record<SportKey, Partial<Record<string, MarketType>>> = {
  football: { h2h: 'MATCH_RESULT', spreads: 'ASIAN_HANDICAP', totals: 'TOTAL_GOALS' },
  basketball: { h2h: 'MATCH_WINNER', spreads: 'POINT_SPREAD', totals: 'TOTAL_POINTS' },
  tennis: { h2h: 'MATCH_WINNER' },
  hockey: { h2h: 'MATCH_WINNER', spreads: 'POINT_SPREAD', totals: 'TOTAL_POINTS' },
  american_football: { h2h: 'MATCH_WINNER', spreads: 'POINT_SPREAD', totals: 'TOTAL_POINTS' },
  baseball: { h2h: 'MATCH_WINNER', spreads: 'POINT_SPREAD', totals: 'TOTAL_POINTS' },
  handball: { h2h: 'MATCH_RESULT', spreads: 'POINT_SPREAD', totals: 'TOTAL_POINTS' },
  mma: { h2h: 'MATCH_WINNER' },
};

export class TheOddsApiProvider implements OddsProvider {
  readonly key = 'theoddsapi';
  readonly name = 'The Odds API';
  readonly isSimulated = false;

  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly baseUrl: string;
  private sportsSnapshot: Snapshot<ApiSport[]> | null = null;
  private readonly odds = new Map<string, Snapshot<ApiOddsEvent[]>>();
  private readonly scores = new Map<string, Snapshot<ApiScoresEvent[]>>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private quotaState: ProviderQuota = {
    remaining: null,
    used: null,
    lastCost: null,
    exhausted: false,
  };

  constructor(private readonly options: TheOddsApiOptions) {
    if (!options.apiKey)
      throw new ProviderError('The Odds API requires an API key (ODDS_API_KEY)', false);
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.baseUrl = (options.baseUrl ?? 'https://api.the-odds-api.com/v4').replace(/\/$/, '');
  }

  getQuota(): ProviderQuota {
    return { ...this.quotaState };
  }

  // ─── OddsProvider ─────────────────────────────────────────────────────────

  async getSports(): Promise<ProviderSport[]> {
    const leagues = await this.getLeagues();
    const present = new Set(leagues.map((l) => l.sportKey));
    return (Object.keys(SPORT_NAMES) as SportKey[])
      .filter((key) => present.has(key))
      .map((key) => ({ key, name: SPORT_NAMES[key] }));
  }

  async getLeagues(sportKey?: SportKey): Promise<ProviderLeague[]> {
    const competitions = await this.competitions();
    return competitions
      .map((s) => ({
        externalId: s.key,
        sportKey: GROUP_TO_SPORT[s.group] as SportKey,
        name: s.description && s.description !== s.title ? s.description : s.title,
        country: null,
      }))
      .filter((l) => !sportKey || l.sportKey === sportKey);
  }

  async getEvents(query: EventQuery): Promise<ProviderEvent[]> {
    const from = Date.parse(query.from);
    const to = Date.parse(query.to);
    const events = await this.allEvents(query.sportKey);
    return events.filter((e) => {
      const start = Date.parse(e.startTime);
      return start >= from && start <= to;
    });
  }

  async getEvent(externalId: string): Promise<ProviderEvent | null> {
    const events = await this.allEvents();
    return events.find((e) => e.externalId === externalId) ?? null;
  }

  async getMarkets(eventExternalId: string): Promise<ProviderMarket[]> {
    for (const competition of await this.competitions()) {
      const snapshot = this.odds.get(competition.key);
      const event = snapshot?.data.find((e) => e.id === eventExternalId);
      if (!event || !snapshot) continue;
      const sport = GROUP_TO_SPORT[competition.group] as SportKey;
      const state = await this.eventState(
        competition,
        event.id,
        event.commence_time,
        event.home_team,
        event.away_team,
      );
      return this.buildMarkets(sport, event, state.status, snapshot.fetchedAt);
    }
    return [];
  }

  async getLiveEvents(sportKey?: SportKey): Promise<ProviderEvent[]> {
    return (await this.allEvents(sportKey)).filter((e) => e.status === 'LIVE');
  }

  // ─── snapshots ────────────────────────────────────────────────────────────

  private async competitions(): Promise<ApiSport[]> {
    const now = this.now();
    if (!this.sportsSnapshot || now - this.sportsSnapshot.fetchedAt > 3_600_000) {
      // The sports list does not cost credits.
      const data = await this.request<ApiSport[]>('/sports', {}, 'sports');
      this.sportsSnapshot = { data, fetchedAt: now };
    }
    const wanted = this.options.sports;
    return this.sportsSnapshot.data.filter(
      (s) =>
        s.active &&
        !s.has_outrights &&
        GROUP_TO_SPORT[s.group] !== undefined &&
        wanted.some((w) => (w.endsWith('*') ? s.key.startsWith(w.slice(0, -1)) : s.key === w)),
    );
  }

  private async oddsFor(competition: ApiSport): Promise<Snapshot<ApiOddsEvent[]>> {
    const cached = this.odds.get(competition.key);
    if (
      cached &&
      (this.now() - cached.fetchedAt < this.options.oddsTtlMs || this.quotaState.exhausted)
    )
      return cached;
    if (this.quotaState.exhausted && !cached) return { data: [], fetchedAt: 0 };
    const sport = GROUP_TO_SPORT[competition.group] as SportKey;
    const data = await this.request<ApiOddsEvent[]>(
      `/sports/${encodeURIComponent(competition.key)}/odds`,
      {
        // Named bookmakers take priority over regions and cost one region per ten bookmakers.
        ...(this.options.bookmakers.length
          ? { bookmakers: this.options.bookmakers.join(',') }
          : { regions: this.options.regions }),
        markets: API_MARKETS[sport].join(','),
        oddsFormat: 'decimal',
        dateFormat: 'iso',
      },
      `odds:${competition.key}`,
    );
    const snapshot = { data, fetchedAt: this.now() };
    this.odds.set(competition.key, snapshot);
    return snapshot;
  }

  /**
   * Scores cost credits too, so they are fetched only while at least one known
   * game of the competition has started and is not known to be over.
   */
  private async scoresFor(competition: ApiSport, needed: boolean): Promise<ApiScoresEvent[]> {
    const cached = this.scores.get(competition.key);
    if (!needed) return cached?.data ?? [];
    if (
      cached &&
      (this.now() - cached.fetchedAt < this.options.scoresTtlMs || this.quotaState.exhausted)
    )
      return cached.data;
    if (this.quotaState.exhausted) return cached?.data ?? [];
    const data = await this.request<ApiScoresEvent[]>(
      `/sports/${encodeURIComponent(competition.key)}/scores`,
      { daysFrom: '3', dateFormat: 'iso' },
      `scores:${competition.key}`,
    );
    this.scores.set(competition.key, { data, fetchedAt: this.now() });
    return data;
  }

  private async allEvents(sportKey?: SportKey): Promise<ProviderEvent[]> {
    const out: ProviderEvent[] = [];
    for (const competition of await this.competitions()) {
      const sport = GROUP_TO_SPORT[competition.group] as SportKey;
      if (sportKey && sport !== sportKey) continue;
      const odds = await this.oddsFor(competition);
      const now = this.now();
      const scoresCached = this.scores.get(competition.key)?.data ?? [];
      const finished = new Set(scoresCached.filter((s) => s.completed).map((s) => s.id));
      const running = odds.data.some(
        (e) => Date.parse(e.commence_time) <= now && !finished.has(e.id),
      );
      const scores = await this.scoresFor(competition, running);

      const seen = new Set<string>();
      for (const e of odds.data) {
        seen.add(e.id);
        out.push(
          this.toEvent(sport, competition, e.id, e.commence_time, e.home_team, e.away_team, scores),
        );
      }
      // Finished games drop out of the odds feed; the scores feed still has them.
      for (const s of scores) {
        if (seen.has(s.id)) continue;
        out.push(
          this.toEvent(sport, competition, s.id, s.commence_time, s.home_team, s.away_team, scores),
        );
      }
    }
    return out.sort((a, b) => a.startTime.localeCompare(b.startTime));
  }

  private async eventState(
    competition: ApiSport,
    id: string,
    commence: string,
    home: string,
    away: string,
  ) {
    const sport = GROUP_TO_SPORT[competition.group] as SportKey;
    const scores = this.scores.get(competition.key)?.data ?? [];
    return this.toEvent(sport, competition, id, commence, home, away, scores);
  }

  // ─── mapping ──────────────────────────────────────────────────────────────

  private team(competition: ApiSport, name: string): ProviderTeam {
    return {
      externalId: `${competition.key}:${slug(name)}`,
      name,
      shortName: shortName(name),
      players: [],
    };
  }

  private toEvent(
    sport: SportKey,
    competition: ApiSport,
    id: string,
    commence: string,
    home: string,
    away: string,
    scores: ApiScoresEvent[],
  ): ProviderEvent {
    const score = scores.find((s) => s.id === id);
    const started = Date.parse(commence) <= this.now();
    const pair = score?.scores ? this.scorePair(score, home, away) : null;
    const completed = !!score?.completed && pair !== null;
    const status = completed ? 'FINISHED' : started ? 'LIVE' : 'SCHEDULED';
    return {
      externalId: id,
      sportKey: sport,
      leagueExternalId: competition.key,
      home: this.team(competition, home),
      away: this.team(competition, away),
      startTime: new Date(commence).toISOString(),
      status,
      score: pair,
      liveState:
        status === 'SCHEDULED'
          ? { period: 'PRE', clock: null }
          : { period: completed ? 'FT' : 'LIVE', clock: null },
      statistics: pair ? scoreStatistics(sport, pair) : null,
      resultFinal: completed,
    };
  }

  private scorePair(score: ApiScoresEvent, home: string, away: string): Pair | null {
    const find = (name: string) => score.scores?.find((s) => s.name === name)?.score;
    const h = Number(find(home));
    const a = Number(find(away));
    if (!Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0) return null;
    return { home: h, away: a };
  }

  private pickBookmaker(event: ApiOddsEvent): ApiBookmaker | null {
    const withMain = event.bookmakers.filter((b) => b.markets.some((m) => m.key === 'h2h'));
    for (const preferred of this.options.bookmakers) {
      const hit = withMain.find((b) => b.key === preferred);
      if (hit) return hit;
    }
    return withMain[0] ?? null;
  }

  private buildMarkets(
    sport: SportKey,
    event: ApiOddsEvent,
    status: ProviderEvent['status'],
    fetchedAt: number,
  ): ProviderMarket[] {
    const bookmaker = this.pickBookmaker(event);
    if (!bookmaker) return [];
    const gate = marketGate({
      eventStatus: status,
      exhausted: this.quotaState.exhausted,
      liveBetting: this.options.liveBetting,
      ageMs: this.now() - fetchedAt,
      liveMaxAgeMs: this.options.liveMaxAgeMs,
    });
    const names = { home: event.home_team, away: event.away_team };
    const markets: ProviderMarket[] = [];
    for (const apiMarket of bookmaker.markets) {
      const type = MARKET_FOR[sport][apiMarket.key];
      const raw = type ? this.rawMarket(apiMarket, event) : null;
      const market = type && raw ? buildMarket(type, raw, names, gate, sport) : null;
      if (market) markets.push(market);
    }
    if (sport === 'football' && status === 'SCHEDULED')
      markets.push(...deriveFootballMarkets(markets, names, gate, { halves: false }));
    return markets;
  }

  private rawMarket(market: ApiMarket, event: ApiOddsEvent): RawMarket | null {
    const byName = (name: string) => market.outcomes.find((o) => o.name === name);
    const home = byName(event.home_team);
    const away = byName(event.away_team);
    if (market.key === 'h2h') {
      const draw = byName('Draw');
      return draw
        ? {
            kind: 'THREE_WAY',
            home: home?.price ?? null,
            draw: draw.price,
            away: away?.price ?? null,
          }
        : { kind: 'TWO_WAY', home: home?.price ?? null, away: away?.price ?? null };
    }
    if (market.key === 'totals') {
      const over = byName('Over');
      const under = byName('Under');
      if (over?.point === undefined || under?.point !== over.point) return null;
      return { kind: 'TOTAL', line: over.point, over: over.price, under: under.price };
    }
    if (market.key === 'spreads') {
      const line = home?.point;
      if (line === undefined || away?.point !== -line) return null;
      return { kind: 'HANDICAP', line, home: home?.price ?? null, away: away?.price ?? null };
    }
    return null;
  }

  // ─── HTTP ─────────────────────────────────────────────────────────────────

  private async request<T>(
    path: string,
    params: Record<string, string>,
    dedupeKey: string,
  ): Promise<T> {
    const pending = this.inflight.get(dedupeKey) as Promise<T> | undefined;
    if (pending) return pending;
    const job = this.doRequest<T>(path, params).finally(() => this.inflight.delete(dedupeKey));
    this.inflight.set(dedupeKey, job);
    return job;
  }

  private async doRequest<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set('apiKey', this.options.apiKey);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers: { accept: 'application/json' } });
    } catch (error) {
      throw new ProviderError(
        `The Odds API unreachable: ${error instanceof Error ? error.message : String(error)}`,
        true,
        {
          cause: error,
        },
      );
    }
    this.trackQuota(response.headers);
    if (response.status === 429) {
      const retryAfter = numberHeader(response.headers, 'retry-after');
      throw new ProviderRateLimitedError((retryAfter ?? 5) * 1000);
    }
    if (!response.ok) {
      // The body says why: an invalid key, bad parameters – or a proxy blocking the host.
      const reason = await errorDetail(response);
      const retryable = response.status >= 500;
      throw new ProviderError(
        `The Odds API responded ${response.status} for ${path}${reason ? `: ${reason}` : ''}`,
        retryable,
      );
    }
    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new ProviderError('The Odds API returned malformed JSON', true, { cause: error });
    }
  }

  private trackQuota(headers: Headers): void {
    const remaining = numberHeader(headers, 'x-requests-remaining');
    const used = numberHeader(headers, 'x-requests-used');
    const last = numberHeader(headers, 'x-requests-last');
    if (remaining !== null) this.quotaState.remaining = remaining;
    if (used !== null) this.quotaState.used = used;
    if (last !== null) this.quotaState.lastCost = last;
    this.quotaState.exhausted = remaining !== null && remaining <= this.options.minRemainingCredits;
  }
}
