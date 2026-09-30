import type { SportKey } from '@storm-bet/types';
import {
  ProviderError,
  type EventQuery,
  type OddsProvider,
  type ProviderEvent,
  type ProviderLeague,
  type ProviderMarket,
  type ProviderSport,
  type ProviderTeam,
} from '../provider';
import { basketballModel } from './basketball';
import {
  FIRST_NAMES,
  LAST_NAMES,
  MOCK_LEAGUES,
  MOCK_SPORTS,
  SQUAD_POSITIONS,
  shortName,
  type MockLeagueDef,
} from './catalog';
import { footballModel } from './football';
import type { MatchContext, MatchState, SportModel } from './model';
import { createRng } from './random';
import { tennisModel } from './tennis';

export interface MockProviderOptions {
  seed: string;
  timeScale: number;
  /** Injected clock (tests). */
  now?: () => number;
  /** Artificial latency, to exercise timeouts. */
  latencyMs?: number;
  /** Share of calls that fail with a retryable error, to exercise retries. */
  failureRate?: number;
}

type AnyModel = SportModel<unknown>;

/** The simulation covers these sports; real feeds add others. */
const MODELS: Partial<Record<SportKey, AnyModel>> = {
  football: footballModel as AnyModel,
  tennis: tennisModel as AnyModel,
  basketball: basketballModel as AnyModel,
};

/** Share of fixtures called off an hour before kick-off (settled as void). */
const CANCELLATION_RATE = 0.02;

interface Fixture {
  ctx: MatchContext;
  model: AnyModel;
  plan: unknown;
}

/**
 * Simulated odds feed. Fixtures follow a rolling schedule per league; every
 * fact about a fixture is a pure function of (seed, fixture id, time), so the
 * provider holds no state and any number of processes agree on it.
 *
 * All data it returns is flagged `isSimulated` and must be shown as demo data.
 */
export class MockOddsProvider implements OddsProvider {
  readonly key = 'mock';
  readonly name = 'STORM Simulator (Demo-Daten)';
  readonly isSimulated = true;

  private readonly now: () => number;
  private readonly teams = new Map<string, ProviderTeam[]>();
  private readonly fixtures = new Map<string, Fixture>();

  constructor(private readonly options: MockProviderOptions) {
    this.now = options.now ?? Date.now;
  }

  // ─── OddsProvider ─────────────────────────────────────────────────────────

  async getSports(): Promise<ProviderSport[]> {
    await this.simulateNetwork('getSports');
    return MOCK_SPORTS.map((s) => ({ ...s }));
  }

  async getLeagues(sportKey?: SportKey): Promise<ProviderLeague[]> {
    await this.simulateNetwork('getLeagues');
    return MOCK_LEAGUES.filter((l) => !sportKey || l.sport === sportKey).map((l) => ({
      externalId: l.id,
      sportKey: l.sport,
      name: l.name,
      country: l.country,
    }));
  }

  async getEvents(query: EventQuery): Promise<ProviderEvent[]> {
    await this.simulateNetwork('getEvents');
    const from = Date.parse(query.from);
    const to = Date.parse(query.to);
    const now = this.now();
    return MOCK_LEAGUES.filter((l) => !query.sportKey || l.sport === query.sportKey)
      .flatMap((league) => this.fixtureIds(league, from, to))
      .map((id) => this.toEvent(this.fixture(id), now))
      .filter((e): e is ProviderEvent => e !== null)
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
  }

  async getEvent(externalId: string): Promise<ProviderEvent | null> {
    await this.simulateNetwork('getEvent');
    const fixture = this.tryFixture(externalId);
    return fixture ? this.toEvent(fixture, this.now()) : null;
  }

  async getMarkets(eventExternalId: string): Promise<ProviderMarket[]> {
    await this.simulateNetwork('getMarkets');
    const fixture = this.tryFixture(eventExternalId);
    if (!fixture) return [];
    const now = this.now();
    const state = fixture.model.state(fixture.ctx, fixture.plan, now);
    return fixture.model.markets(fixture.ctx, fixture.plan, state, now);
  }

  async getLiveEvents(sportKey?: SportKey): Promise<ProviderEvent[]> {
    await this.simulateNetwork('getLiveEvents');
    const now = this.now();
    const out: ProviderEvent[] = [];
    for (const league of MOCK_LEAGUES) {
      if (sportKey && league.sport !== sportKey) continue;
      // Longest fixture of any sport is well under four simulated hours.
      const lookback = (240 / this.options.timeScale) * 60_000;
      for (const id of this.fixtureIds(league, now - lookback, now)) {
        const event = this.toEvent(this.fixture(id), now);
        if (event?.status === 'LIVE') out.push(event);
      }
    }
    return out.sort((a, b) => a.startTime.localeCompare(b.startTime));
  }

  // ─── Schedule ─────────────────────────────────────────────────────────────

  private fixtureIds(league: MockLeagueDef, from: number, to: number): string[] {
    const slot = league.slotMinutes * 60_000;
    const offset = league.offsetMinutes * 60_000;
    const first = Math.floor((from - offset) / slot) - 1;
    const last = Math.floor((to - offset) / slot);
    const ids: string[] = [];
    for (let s = first; s <= last; s += 1) {
      for (let n = 0; n < league.fixturesPerSlot; n += 1) {
        const kickoff = offset + s * slot + n * league.staggerMinutes * 60_000;
        if (kickoff >= from && kickoff <= to) ids.push(`${league.id}:${s}:${n}`);
      }
    }
    return ids;
  }

  private tryFixture(externalId: string): Fixture | null {
    try {
      return this.fixture(externalId);
    } catch {
      return null;
    }
  }

  private fixture(externalId: string): Fixture {
    const cached = this.fixtures.get(externalId);
    if (cached) return cached;
    const match = /^([a-z0-9-]+):(-?\d+):(\d+)$/.exec(externalId);
    const league = match && MOCK_LEAGUES.find((l) => l.id === match[1]);
    const slot = match ? Number(match[2]) : NaN;
    const n = match ? Number(match[3]) : NaN;
    if (!league || !Number.isSafeInteger(slot) || !(n < league.fixturesPerSlot)) {
      throw new ProviderError(`unknown fixture ${externalId}`, false);
    }
    const teams = this.leagueTeams(league);
    // Each round pairs a fresh shuffle of the league, so nobody plays twice in a round.
    const order = createRng(this.options.seed, league.id, 'round', slot).shuffle(teams);
    const home = order[2 * n];
    const away = order[2 * n + 1];
    if (!home || !away) throw new ProviderError(`league ${league.id} has too few teams`, false);
    const ctx: MatchContext = {
      seed: this.options.seed,
      externalId,
      league,
      home,
      away,
      kickoff:
        league.offsetMinutes * 60_000 +
        slot * league.slotMinutes * 60_000 +
        n * league.staggerMinutes * 60_000,
      timeScale: this.options.timeScale,
      cancelled: createRng(this.options.seed, externalId, 'cancel').next() < CANCELLATION_RATE,
    };
    const model = MODELS[league.sport]!;
    const fixture: Fixture = { ctx, model, plan: model.plan(ctx) };
    // Bounded memo: the rolling window never needs more than a few thousand.
    if (this.fixtures.size > 5_000) this.fixtures.clear();
    this.fixtures.set(externalId, fixture);
    return fixture;
  }

  private leagueTeams(league: MockLeagueDef): ProviderTeam[] {
    const cached = this.teams.get(league.id);
    if (cached) return cached;
    const teams = league.teams.map((name, index): ProviderTeam => {
      const externalId = `${league.id}:team:${index}`;
      const rng = createRng(this.options.seed, externalId, 'squad');
      const players =
        league.sport === 'football'
          ? SQUAD_POSITIONS.map((position, i) => ({
              externalId: `${externalId}:p${i}`,
              name: `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`,
              position,
            }))
          : [];
      return { externalId, name, shortName: shortName(name), players };
    });
    this.teams.set(league.id, teams);
    return teams;
  }

  private toEvent(fixture: Fixture, now: number): ProviderEvent | null {
    const { ctx, model, plan } = fixture;
    const state: MatchState = model.state(ctx, plan, now);
    return {
      externalId: ctx.externalId,
      sportKey: ctx.league.sport,
      leagueExternalId: ctx.league.id,
      home: ctx.home,
      away: ctx.away,
      startTime: new Date(ctx.kickoff).toISOString(),
      status: state.status,
      score: state.score,
      liveState: state.liveState,
      statistics: state.statistics,
      resultFinal: state.resultFinal,
    };
  }

  private async simulateNetwork(operation: string): Promise<void> {
    const { latencyMs = 0, failureRate = 0 } = this.options;
    if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
    if (failureRate > 0 && Math.random() < failureRate) {
      throw new ProviderError(`simulated upstream failure in ${operation}`, true);
    }
  }
}
