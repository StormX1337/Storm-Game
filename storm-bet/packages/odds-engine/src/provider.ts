import type {
  EventStatistics,
  EventStatus,
  LiveState,
  MarketStatus,
  MarketType,
  Outcome,
  Pair,
  SelectionStatus,
  SportKey,
} from '@storm-bet/types';

/**
 * Provider-neutral feed contract. A licensed data vendor is integrated by
 * implementing this interface; nothing downstream (sync, API, UI) knows which
 * vendor is behind it. All values are plain JSON so responses can be cached.
 */

export interface ProviderSport {
  key: SportKey;
  name: string;
}

export interface ProviderLeague {
  externalId: string;
  sportKey: SportKey;
  name: string;
  country: string | null;
}

export interface ProviderPlayer {
  externalId: string;
  name: string;
  position: string | null;
}

export interface ProviderTeam {
  externalId: string;
  name: string;
  shortName: string;
  players: ProviderPlayer[];
}

export interface ProviderEvent {
  externalId: string;
  sportKey: SportKey;
  leagueExternalId: string;
  home: ProviderTeam;
  away: ProviderTeam;
  /** ISO 8601. */
  startTime: string;
  status: EventStatus;
  score: Pair | null;
  liveState: LiveState | null;
  /**
   * In provider payloads `goalEvents[].playerId` carries the provider's player
   * id; the sync layer translates it to the internal id before storing.
   */
  statistics: EventStatistics | null;
  /** The result is official and may be settled against. */
  resultFinal: boolean;
}

export interface ProviderSelection {
  key: string;
  name: string;
  outcome: Outcome;
  odds: number;
  status: SelectionStatus;
  playerExternalId: string | null;
}

export interface ProviderMarket {
  key: string;
  type: MarketType;
  name: string;
  line: number | null;
  status: MarketStatus;
  /** Why a SUSPENDED market is closed right now (e.g. "Tor"), if the feed says. */
  suspensionReason: string | null;
  selections: ProviderSelection[];
  /** Priced by the book's own goal model from the feed's prices, not quoted by the feed. */
  derived?: boolean;
}

export interface EventQuery {
  sportKey?: SportKey;
  /** ISO 8601 window on start time. */
  from: string;
  to: string;
}

export interface OddsProvider {
  readonly key: string;
  readonly name: string;
  /** True when the data is generated, not observed. Surfaced in every UI view. */
  readonly isSimulated: boolean;

  getSports(): Promise<ProviderSport[]>;
  getLeagues(sportKey?: SportKey): Promise<ProviderLeague[]>;
  getEvents(query: EventQuery): Promise<ProviderEvent[]>;
  getEvent(externalId: string): Promise<ProviderEvent | null>;
  getMarkets(eventExternalId: string): Promise<ProviderMarket[]>;
  getLiveEvents(sportKey?: SportKey): Promise<ProviderEvent[]>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = 'ProviderError';
  }
}

export class ProviderTimeoutError extends ProviderError {
  constructor(operation: string, timeoutMs: number) {
    super(`${operation} timed out after ${timeoutMs} ms`, true);
    this.name = 'ProviderTimeoutError';
  }
}

export class ProviderRateLimitedError extends ProviderError {
  constructor(readonly retryAfterMs: number) {
    super(`provider rate limit reached, retry in ${retryAfterMs} ms`, true);
    this.name = 'ProviderRateLimitedError';
  }
}

export class CircuitOpenError extends ProviderError {
  constructor(provider: string) {
    super(`circuit for provider "${provider}" is open`, false);
    this.name = 'CircuitOpenError';
  }
}
