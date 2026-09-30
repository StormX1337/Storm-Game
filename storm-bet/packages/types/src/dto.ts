import type {
  BetStatus,
  BetType,
  EventStatus,
  IncidentKind,
  KycStatus,
  LimitType,
  MarketStatus,
  OddsChangePolicy,
  SelectionResult,
  SelectionStatus,
  SlipMode,
  SportKey,
  TransactionType,
  UserRole,
  UserStatus,
} from './enums';
import type { ErrorCode } from './errors';
import type { MarketType, Outcome } from './markets';
import type { Permission } from './rbac';
import type { EventStatistics, LiveState, Pair } from './statistics';

/**
 * API contract. Money is always an integer amount of minor units (cents of
 * the DEMO currency); odds are decimal odds with at most three decimals.
 */
export type Money = number;

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

export interface DataSourceDto {
  provider: string;
  /** True for simulated data. The UI labels every such event as a demo. */
  isSimulated: boolean;
}

export interface SportDto {
  id: string;
  key: SportKey;
  name: string;
  eventCount: number;
  liveCount: number;
}

export interface LeagueDto {
  id: string;
  name: string;
  country: string | null;
  sportKey: SportKey;
  eventCount: number;
}

export interface TeamDto {
  id: string;
  name: string;
  shortName: string;
}

export interface SelectionDto {
  id: string;
  marketId: string;
  name: string;
  outcome: Outcome;
  odds: number;
  status: SelectionStatus;
  oddsVersion: number;
  playerId: string | null;
}

export interface MarketDto {
  id: string;
  eventId: string;
  type: MarketType;
  name: string;
  line: number | null;
  status: MarketStatus;
  selections: SelectionDto[];
}

export interface EventSummaryDto {
  id: string;
  sport: { key: SportKey; name: string };
  league: { id: string; name: string; country: string | null };
  home: TeamDto;
  away: TeamDto;
  startTime: string;
  status: EventStatus;
  isLive: boolean;
  score: Pair | null;
  liveState: LiveState | null;
  dataSource: DataSourceDto;
  mainMarket: MarketDto | null;
  marketCount: number;
}

export interface EventDetailDto extends EventSummaryDto {
  statistics: EventStatistics | null;
  markets: MarketDto[];
}

/** One live ticker line. `at` is when the change was seen, not an official time. */
export interface IncidentDto {
  id: string;
  kind: IncidentKind;
  side: 'HOME' | 'AWAY' | null;
  clock: string | null;
  period: string | null;
  playerName: string | null;
  score: { home: number; away: number } | null;
  at: string;
}

/** Recent finished games of a team, as recorded here (newest first). */
export interface FormEntryDto {
  eventId: string;
  startTime: string;
  opponent: string;
  home: boolean;
  goalsFor: number;
  goalsAgainst: number;
  result: 'W' | 'D' | 'L';
}

export interface HeadToHeadDto {
  eventId: string;
  startTime: string;
  homeTeam: string;
  awayTeam: string;
  score: { home: number; away: number };
}

export interface StandingRowDto {
  position: number;
  team: string;
  played: number;
  won: number;
  draw: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
  /** One of the match's teams. */
  highlight: boolean;
}

/** Form, head-to-head and (when a standings source is set up) the league table. */
export interface EventInsightsDto {
  form: { home: FormEntryDto[]; away: FormEntryDto[] };
  headToHead: HeadToHeadDto[];
  standings: { competition: string; source: string; rows: StandingRowDto[] } | null;
}

export interface TwoFactorStatusDto {
  enabled: boolean;
  enabledAt: string | null;
  recoveryCodesLeft: number;
}

export interface WalletDto {
  currency: 'DEMO';
  balance: Money;
  reserved: Money;
  available: Money;
}

export interface TransactionDto {
  id: string;
  type: TransactionType;
  /** Change to the balance. */
  amount: Money;
  /** Change to the reserved part of the balance. */
  reservedDelta: Money;
  balanceAfter: Money;
  reservedAfter: Money;
  availableAfter: Money;
  betId: string | null;
  betReference: string | null;
  description: string;
  createdAt: string;
}

export interface OddsSnapshotDto {
  odds: number;
  oddsVersion: number;
  eventStatus: EventStatus;
  marketStatus: MarketStatus;
  score: Pair | null;
  source: string;
  capturedAt: string;
}

export interface BetSelectionDto {
  id: string;
  selectionId: string;
  eventId: string;
  sportKey: SportKey;
  eventName: string;
  startTime: string;
  marketType: MarketType;
  marketName: string;
  line: number | null;
  selectionName: string;
  outcome: Outcome;
  odds: number;
  result: SelectionResult;
  /** Won early by a two-goal lead. */
  earlyPayout: boolean;
  snapshot: OddsSnapshotDto | null;
  /** The match as it stands now: teams, status and score (final once finished). */
  event: {
    home: string;
    away: string;
    status: EventStatus;
    score: { home: number; away: number } | null;
    liveState: LiveState | null;
    /** Football figures some markets are decided on, when the feed reports them. */
    corners: { home: number; away: number } | null;
    cards: { home: number; away: number } | null;
  };
}

export interface BetDto {
  id: string;
  reference: string;
  slipId: string;
  type: BetType;
  status: BetStatus;
  stake: Money;
  totalOdds: number;
  potentialReturn: Money;
  payout: Money | null;
  oddsChangePolicy: OddsChangePolicy;
  placedAt: string;
  settledAt: string | null;
  settlementNote: string | null;
  /** Stake still open after partial cashouts. */
  remainingStake: Money;
  partialCashouts: { stake: Money; amount: Money; at: string }[];
  /** Auto-cashout target, if set. */
  autoCashout: Money | null;
  /** Placed with an odds boost (the total odds are the boosted price). */
  boosted: boolean;
  /** System bet: selections per combination and number of combinations. */
  system: { size: number; lines: number } | null;
  selections: BetSelectionDto[];
}

/** What an open bet can be closed for right now. */
export interface CashoutQuoteDto {
  betId: string;
  available: boolean;
  amount: Money | null;
  /** Why no cashout is offered right now. */
  reason: string | null;
  remainingStake: Money;
  autoCashout: Money | null;
}

export interface CashoutResponse {
  bet: BetDto;
  wallet: WalletDto;
}

export interface SlipIssueDto {
  code: ErrorCode;
  message: string;
  selectionId?: string;
  /** For ODDS_CHANGED: the price the server would accept now. */
  currentOdds?: number;
  requestedOdds?: number;
}

export interface SlipSelectionStateDto {
  selectionId: string;
  eventId: string;
  eventName: string;
  marketName: string;
  selectionName: string;
  requestedOdds: number;
  currentOdds: number;
  oddsVersion: number;
  status: SelectionStatus;
  marketStatus: MarketStatus;
  eventStatus: EventStatus;
  bettable: boolean;
}

export interface SlipQuoteDto {
  mode: SlipMode;
  betType: BetType | null;
  totalOdds: number;
  totalStake: Money;
  potentialReturn: Money;
  selectionCount: number;
  /** Kombi and Bet Builder: the highest stake the limits allow at this price. */
  maxStake: Money | null;
}

export interface ValidateSlipResponse {
  valid: boolean;
  quote: SlipQuoteDto;
  selections: SlipSelectionStateDto[];
  issues: SlipIssueDto[];
}

export interface PlaceBetResponse {
  slipId: string;
  /** True when this is a replay of an already-processed idempotency key. */
  replayed: boolean;
  bets: BetDto[];
  wallet: WalletDto;
}

export interface SessionUserDto {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  emailVerified: boolean;
  permissions: Permission[];
  createdAt: string;
}

export interface SessionInfoDto {
  id: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
}

export interface LimitDto {
  type: LimitType;
  amount: Money;
  effectiveFrom: string;
  pendingAmount: Money | null;
  pendingEffectiveAt: string | null;
  used: Money;
}

export interface SelfExclusionDto {
  active: boolean;
  startsAt: string | null;
  endsAt: string | null;
}

export interface ProfileDto extends SessionUserDto {
  country: string | null;
  dateOfBirth: string | null;
  kycStatus: KycStatus;
  lastLoginAt: string | null;
}

export interface AccountSummaryDto {
  wallet: WalletDto;
  openBets: number;
  settledBets: number;
  totalStaked: Money;
  totalReturns: Money;
  wonBets: number;
  lostBets: number;
}

export interface AdminUserDto extends ProfileDto {
  lockedReason: string | null;
  lockedAt: string | null;
  wallet: WalletDto | null;
  betCount: number;
  twoFactorEnabled: boolean;
}

export interface AuditLogDto {
  id: string;
  actorId: string | null;
  actorEmail: string | null;
  actorRole: UserRole | null;
  action: string;
  targetType: string;
  targetId: string | null;
  ip: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export type ProviderState = 'HEALTHY' | 'DEGRADED' | 'DOWN' | 'UNKNOWN';

export interface ProviderHealthDto {
  key: string;
  name: string;
  isSimulated: boolean;
  state: ProviderState;
  circuit: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  avgLatencyMs: number | null;
  requests: number;
  failures: number;
  lastSyncAt: string | null;
  /** Metered feeds only: request credits as reported by the provider. */
  quota: { remaining: number | null; used: number | null; exhausted: boolean } | null;
}

export interface ComponentHealthDto {
  name: string;
  ok: boolean;
  latencyMs: number | null;
  detail: string | null;
}

export interface SystemHealthDto {
  status: 'ok' | 'degraded' | 'down';
  components: ComponentHealthDto[];
  worker: { lastHeartbeatAt: string | null; ok: boolean };
  queues: { name: string; waiting: number; active: number; failed: number; delayed: number }[];
  time: string;
}

export interface AdminOverviewDto {
  users: { total: number; active: number; locked: number; newToday: number };
  events: { total: number; live: number; upcoming: number; awaitingSettlement: number };
  bets: { total: number; pending: number; placedToday: number; stakedToday: Money };
  transactions: { today: number };
  system: SystemHealthDto;
  providers: ProviderHealthDto[];
}

export interface UserRefDto {
  id: string;
  email: string;
  displayName: string;
}

export interface AdminBetDto extends BetDto {
  user: UserRefDto;
}

export interface AdminBetDetailDto extends AdminBetDto {
  transactions: TransactionDto[];
  audit: AuditLogDto[];
}

export interface AdminTransactionDto extends TransactionDto {
  user: UserRefDto;
}

export interface AdminSelectionDto extends SelectionDto {
  rawStatus: SelectionStatus;
  result: SelectionResult;
  suspensionReason: string | null;
}

export interface AdminMarketDto extends Omit<MarketDto, 'selections'> {
  rawStatus: MarketStatus;
  tradingSuspended: boolean;
  settledAt: string | null;
  selections: AdminSelectionDto[];
}

export interface AdminEventDto extends Omit<EventDetailDto, 'markets'> {
  provider: string;
  rawStatus: EventStatus;
  isActive: boolean;
  tradingSuspended: boolean;
  resultConfirmedAt: string | null;
  settledAt: string | null;
  betCount: number;
  openBetCount: number;
  markets: AdminMarketDto[];
}

export interface AdminEventListItemDto extends EventSummaryDto {
  provider: string;
  rawStatus: EventStatus;
  isActive: boolean;
  tradingSuspended: boolean;
  resultConfirmedAt: string | null;
  settledAt: string | null;
}

export interface AdminCatalogDto {
  sports: { key: SportKey; name: string }[];
  leagues: { id: string; name: string; sportKey: SportKey }[];
  teams: {
    id: string;
    name: string;
    sportKey: SportKey;
    players: { id: string; name: string }[];
  }[];
}

export interface AdminUserDetailDto extends AdminUserDto {
  limits: LimitDto[];
  selfExclusion: SelfExclusionDto;
  activeSessions: number;
}

export interface PlatformMetaDto {
  /** Always false in this build. */
  realMoney: false;
  odds: { provider: string; name: string; isSimulated: boolean };
}

/** A selection as a shared bet slip shows it, with its current price and state. */
export interface SharedSelectionDto {
  selectionId: string;
  selectionName: string;
  outcome: Outcome;
  odds: number;
  /** Open for betting right now (selection, market and event). */
  open: boolean;
  marketId: string;
  marketName: string;
  marketType: MarketType;
  eventId: string;
  eventName: string;
  sportKey: SportKey;
  startTime: string;
  isLive: boolean;
}

/** An odds boost on offer. */
export interface BoostDto {
  id: string;
  title: string;
  upliftPct: number;
  maxStake: Money;
  endsAt: string;
  /** The player has already used it. */
  used: boolean;
  /** Bettable right now. */
  open: boolean;
  selectionId: string;
  selectionName: string;
  marketId: string;
  marketName: string;
  eventId: string;
  eventName: string;
  sportKey: SportKey;
  startTime: string;
  odds: number;
  boostedOdds: number;
}
