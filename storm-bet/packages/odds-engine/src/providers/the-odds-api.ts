import {
  isSupportedLine,
  marketKey,
  MARKET_DEFINITIONS,
  type BasketballStatistics,
  type EventStatistics,
  type FootballStatistics,
  type MarketStatus,
  type MarketType,
  type Outcome,
  type Pair,
  type SportKey,
  type TennisStatistics,
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
  type ProviderSelection,
  type ProviderSport,
  type ProviderTeam,
} from '../provider';

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

export interface ProviderQuota {
  remaining: number | null;
  used: number | null;
  lastCost: number | null;
  exhausted: boolean;
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
};

const SPORT_NAMES: Record<SportKey, string> = {
  football: 'Fußball',
  tennis: 'Tennis',
  basketball: 'Basketball',
};

/** Markets requested per sport. Tennis handicaps/totals count games, which the scores feed cannot settle. */
const API_MARKETS: Record<SportKey, string[]> = {
  football: ['h2h', 'spreads', 'totals'],
  basketball: ['h2h', 'spreads', 'totals'],
  tennis: ['h2h'],
};

const MARKET_FOR: Record<SportKey, Partial<Record<string, MarketType>>> = {
  football: { h2h: 'MATCH_RESULT', spreads: 'ASIAN_HANDICAP', totals: 'TOTAL_GOALS' },
  basketball: { h2h: 'MATCH_WINNER', spreads: 'POINT_SPREAD', totals: 'TOTAL_POINTS' },
  tennis: { h2h: 'MATCH_WINNER' },
};

function slug(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

/** Three decimals at most — the precision the book stores and compares. */
function price(value: number): number | null {
  if (!Number.isFinite(value) || value <= 1) return null;
  return Math.round(value * 1000) / 1000;
}

function numberHeader(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** A short, log-safe reason from an error response (API JSON `message` or plain text). */
async function errorDetail(response: Response): Promise<string> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return '';
  }
  try {
    const body = JSON.parse(text) as { message?: unknown };
    if (typeof body.message === 'string') text = body.message;
  } catch {
    // plain text
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

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
      statistics: pair ? this.statistics(sport, pair) : null,
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

  /** Only what the feed reports: the score. Details stay absent, not zero. */
  private statistics(sport: SportKey, pair: Pair): EventStatistics {
    if (sport === 'football') {
      const stats: FootballStatistics = { sport: 'football', goals: pair };
      return stats;
    }
    if (sport === 'tennis') {
      const stats: TennisStatistics = {
        sport: 'tennis',
        sets: [],
        setsWon: pair,
        currentGame: null,
        server: null,
      };
      return stats;
    }
    const stats: BasketballStatistics = { sport: 'basketball', points: pair, periods: [] };
    return stats;
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
    const age = this.now() - fetchedAt;
    let marketStatus: MarketStatus = 'OPEN';
    let reason: string | null = null;
    if (status === 'FINISHED') marketStatus = 'CLOSED';
    else if (this.quotaState.exhausted) {
      marketStatus = 'SUSPENDED';
      reason = 'Datenkontingent erschöpft';
    } else if (
      status === 'LIVE' &&
      (!this.options.liveBetting || age > this.options.liveMaxAgeMs)
    ) {
      marketStatus = 'SUSPENDED';
      reason = 'Live-Quoten nicht aktuell genug';
    }

    const markets: ProviderMarket[] = [];
    for (const apiMarket of bookmaker.markets) {
      const type = MARKET_FOR[sport][apiMarket.key];
      if (!type) continue;
      const built = this.mapMarket(type, apiMarket, event);
      if (!built) continue;
      const definition = MARKET_DEFINITIONS[type];
      markets.push({
        key: marketKey(type, built.line),
        type,
        name:
          built.line == null
            ? definition.label
            : `${definition.label} ${this.lineLabel(built.line, definition.kind === 'HANDICAP')}`,
        line: built.line,
        status: marketStatus,
        suspensionReason: marketStatus === 'SUSPENDED' ? reason : null,
        selections: built.selections.map((s) => ({
          ...s,
          status:
            marketStatus === 'OPEN' ? 'OPEN' : marketStatus === 'CLOSED' ? 'CLOSED' : 'SUSPENDED',
        })),
      });
    }
    return markets;
  }

  private lineLabel(line: number, signed: boolean): string {
    const text = Number.isInteger(line) ? line.toFixed(1) : String(line);
    return signed && line > 0 ? `+${text}` : text;
  }

  private mapMarket(
    type: MarketType,
    market: ApiMarket,
    event: ApiOddsEvent,
  ): { line: number | null; selections: Omit<ProviderSelection, 'status'>[] } | null {
    const byName = (name: string) => market.outcomes.find((o) => o.name === name);
    const selection = (outcome: Outcome, name: string, o: ApiOutcome | undefined) => {
      const odds = o ? price(o.price) : null;
      return odds === null ? null : { key: outcome, name, outcome, odds, playerExternalId: null };
    };
    const all = <T>(items: (T | null)[]): T[] | null =>
      items.every((i) => i !== null) ? (items as T[]) : null;

    const kind = MARKET_DEFINITIONS[type].kind;
    if (kind === 'THREE_WAY') {
      const items = all([
        selection('HOME', event.home_team, byName(event.home_team)),
        selection('DRAW', 'Unentschieden', byName('Draw')),
        selection('AWAY', event.away_team, byName(event.away_team)),
      ]);
      return items ? { line: null, selections: items } : null;
    }
    if (kind === 'TWO_WAY') {
      const items = all([
        selection('HOME', event.home_team, byName(event.home_team)),
        selection('AWAY', event.away_team, byName(event.away_team)),
      ]);
      return items ? { line: null, selections: items } : null;
    }
    if (kind === 'TOTAL') {
      const over = byName('Over');
      const under = byName('Under');
      const line = over?.point;
      if (line === undefined || under?.point !== line || !isSupportedLine(line)) return null;
      const items = all([
        selection('OVER', `Über ${line}`, over),
        selection('UNDER', `Unter ${line}`, under),
      ]);
      return items ? { line, selections: items } : null;
    }
    if (kind === 'HANDICAP') {
      const home = byName(event.home_team);
      const away = byName(event.away_team);
      const line = home?.point;
      // Quarter lines (±0.25, ±0.75) split the stake and are not offered.
      if (line === undefined || away?.point !== -line || !isSupportedLine(line)) return null;
      const fmt = (v: number) => (v > 0 ? `+${v}` : `${v}`);
      const items = all([
        selection('HOME', `${event.home_team} ${fmt(line)}`, home),
        selection('AWAY', `${event.away_team} ${fmt(-line)}`, away),
      ]);
      return items ? { line, selections: items } : null;
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
