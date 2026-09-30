import { z } from 'zod';
import { HARD_LIMITS } from './constants';

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .optional()
    .transform((v) => (v === undefined ? fallback : v === 'true' || v === '1' || v === 'yes'));

const int = (fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const nodeEnv = z.enum(['development', 'test', 'production']).default('development');

const logLevel = z
  .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
  .default('info');

const url = z.string().url();

/**
 * Real-money play needs licences, KYC, geo rules and payment rails that this
 * build does not have. The switch exists so that the refusal is explicit: a
 * deployment that sets it gets a startup error, not a half-working cashier.
 */
const realMoneyGuard = z
  .enum(['false', '0', 'no'], {
    errorMap: () => ({
      message:
        'REAL_MONEY_ENABLED ist gesperrt: Echtgeldbetrieb erfordert Lizenz, KYC, Geo-Regeln und Zahlungsanbieter.',
    }),
  })
  .optional();

const sharedServerEnv = {
  NODE_ENV: nodeEnv,
  LOG_LEVEL: logLevel,
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://127.0.0.1:6379'),
  APP_URL: url.default('http://localhost:3000'),
  REAL_MONEY_ENABLED: realMoneyGuard,

  BET_MIN_STAKE: int(10, 1),
  BET_MAX_STAKE: int(10_000_00, 1, HARD_LIMITS.maxStakeMinor),
  BET_MAX_PAYOUT: int(250_000_00, 1, HARD_LIMITS.maxPayoutMinor),
  BET_MAX_SELECTIONS: int(20, 1, HARD_LIMITS.maxSelections),
  BET_MAX_TOTAL_ODDS: int(10_000, 2, HARD_LIMITS.maxTotalOdds),
  /** ACCEPT_HIGHER never takes a price that rose more than this (percent). */
  ODDS_ACCEPT_HIGHER_MAX_PCT: int(10, 0, 100),
  /** Cashout: published deduction from the value at current prices (percent). */
  CASHOUT_MARGIN_PCT: int(5, 0, 20),

  DEMO_STARTING_BALANCE: int(1_000_00, 0),
  DEMO_TOPUP_AMOUNT: int(500_00, 0),
  DEMO_TOPUP_THRESHOLD: int(50_00, 0),
  DEMO_TOPUP_COOLDOWN_HOURS: int(24, 0),

  /** Odds feed: the built-in simulator, The Odds API or SportsGameOdds (real prices and results). */
  ODDS_PROVIDER: z.enum(['mock', 'theoddsapi', 'sportsgameodds']).default('mock'),
};

const list = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );

export const apiEnvSchema = z.object({
  ...sharedServerEnv,
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: int(4000, 1, 65535),
  /** At least 32 characters. Keys the CSRF tokens. */
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET muss mindestens 32 Zeichen lang sein'),
  SESSION_TTL_HOURS: int(24 * 7, 1, 24 * 90),
  SESSION_IDLE_MINUTES: int(24 * 60, 5),
  ADMIN_SESSION_IDLE_MINUTES: int(30, 5),
  /** Hops or CIDRs whose X-Forwarded-For is believed. The web container proxies /api. */
  TRUST_PROXY: z.string().default('loopback,uniquelocal'),
  /** Comma-separated CIDRs allowed to reach /api/admin. Empty: any address. */
  ADMIN_IP_ALLOWLIST: z.string().default(''),
  AUTH_REQUIRE_EMAIL_VERIFICATION: bool(false),
  MAIL_FROM: z.string().default('STORM BET <no-reply@storm-bet.local>'),
  SMTP_URL: z.string().optional(),
  SUPPORT_EMAIL: z.string().email().default('support@storm-bet.local'),
  /** Record client IPs in the audit log. Switch off where that is not lawful. */
  AUDIT_LOG_IP: bool(true),
});
export type ApiEnv = z.infer<typeof apiEnvSchema>;

export const workerEnvSchema = z
  .object({
    ...sharedServerEnv,
    MOCK_SEED: z.string().min(1).default('storm-bet-demo'),
    /** Simulated match minutes per real minute. 1 plays matches in real time. */
    MOCK_TIME_SCALE: z.coerce.number().min(0.1).max(60).default(3),
    PROVIDER_TIMEOUT_MS: int(3_000, 100, 60_000),
    PROVIDER_MAX_RETRIES: int(3, 0, 10),
    PROVIDER_RATE_LIMIT_PER_MINUTE: int(1_200, 1),
    PROVIDER_CACHE_TTL_SECONDS: int(2, 0, 3600),
    CATALOG_SYNC_INTERVAL_MS: int(30_000, 1_000),
    LIVE_SYNC_INTERVAL_MS: int(3_000, 500),
    PREMATCH_ODDS_INTERVAL_MS: int(20_000, 1_000),
    SETTLEMENT_INTERVAL_MS: int(15_000, 1_000),
    WORKER_HEALTH_PORT: int(4100, 1, 65535),

    /** The Odds API — see SETUP.md for credit costs. */
    ODDS_API_KEY: z.string().min(10).optional(),
    ODDS_API_BASE_URL: z.string().url().default('https://api.the-odds-api.com/v4'),
    ODDS_API_SPORTS: list(
      'soccer_germany_bundesliga,soccer_epl,soccer_spain_la_liga,soccer_uefa_champs_league,basketball_nba,basketball_euroleague,tennis_atp_*,tennis_wta_*',
    ),
    ODDS_API_REGIONS: z.string().default('eu'),
    ODDS_API_BOOKMAKERS: list(''),
    ODDS_API_ODDS_TTL_SECONDS: int(900, 60),
    ODDS_API_SCORES_TTL_SECONDS: int(300, 30),
    ODDS_API_MIN_REMAINING: int(25, 0),
    ODDS_API_LIVE_BETTING: bool(false),
    ODDS_API_LIVE_MAX_AGE_SECONDS: int(60, 5),

    /** SportsGameOdds — billed per event object returned, see SETUP.md. */
    SGO_API_KEY: z.string().min(10).optional(),
    SGO_BASE_URL: z.string().url().default('https://api.sportsgameodds.com/v2'),
    SGO_LEAGUES: list('BUNDESLIGA,EPL,LA_LIGA,UEFA_CHAMPIONS_LEAGUE,NBA'),
    SGO_BOOKMAKERS: list(''),
    SGO_HORIZON_HOURS: int(48, 1, 24 * 14),
    SGO_ODDS_TTL_SECONDS: int(1800, 60),
    /** Running games are re-read this often; 1 = every second (with LIVE_SYNC_INTERVAL_MS=1000). */
    SGO_LIVE_TTL_SECONDS: int(5, 1),
    SGO_MIN_REMAINING: int(50, 0),
    SGO_LIVE_BETTING: bool(false),
    SGO_LIVE_MAX_AGE_SECONDS: int(60, 5),
    /** A completed game's result counts as final this long after the feed reports it (or once finalized). */
    SGO_SETTLE_AFTER_MINUTES: int(5, 0, 1440),
  })
  .superRefine((env, ctx) => {
    if (env.ODDS_PROVIDER === 'theoddsapi' && !env.ODDS_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ODDS_API_KEY'],
        message: 'ODDS_PROVIDER=theoddsapi benötigt ODDS_API_KEY',
      });
    }
    if (env.ODDS_PROVIDER === 'sportsgameodds' && !env.SGO_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SGO_API_KEY'],
        message: 'ODDS_PROVIDER=sportsgameodds benötigt SGO_API_KEY',
      });
    }
  });
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export const seedEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DEMO_STARTING_BALANCE: int(1_000_00, 0),
  SEED_ADMIN_EMAIL: z.string().email().default('admin@storm-bet.local'),
  SEED_ADMIN_PASSWORD: z.string().min(10).optional(),
  SEED_DEMO_EMAIL: z.string().email().default('demo@storm-bet.local'),
  SEED_DEMO_PASSWORD: z.string().min(10).optional(),
});
export type SeedEnv = z.infer<typeof seedEnvSchema>;

export class EnvError extends Error {
  constructor(readonly issues: string[]) {
    super(`Ungültige Konfiguration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvError';
  }
}

export function parseEnv<T extends z.ZodTypeAny>(
  schema: T,
  source: Record<string, string | undefined> = process.env,
): z.infer<T> {
  // Empty strings from `.env` templates mean "unset", not "the empty value".
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== undefined && v !== ''),
  );
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    throw new EnvError(result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const env = result.data as z.infer<T> & { NODE_ENV?: string; APP_URL?: string };
  if (env.NODE_ENV === 'production' && env.APP_URL?.startsWith('http://')) {
    const host = new URL(env.APP_URL).hostname;
    if (host !== 'localhost' && host !== '127.0.0.1') {
      throw new EnvError(['APP_URL: in production muss APP_URL https verwenden']);
    }
  }
  return env;
}

/** Limits the betting engine enforces, derived once from the environment. */
export interface BettingLimits {
  minStake: number;
  maxStake: number;
  maxPayout: number;
  maxSelections: number;
  maxTotalOdds: number;
  acceptHigherMaxPct: number;
}

export function bettingLimitsFrom(env: {
  BET_MIN_STAKE: number;
  BET_MAX_STAKE: number;
  BET_MAX_PAYOUT: number;
  BET_MAX_SELECTIONS: number;
  BET_MAX_TOTAL_ODDS: number;
  ODDS_ACCEPT_HIGHER_MAX_PCT: number;
}): BettingLimits {
  return {
    minStake: env.BET_MIN_STAKE,
    maxStake: env.BET_MAX_STAKE,
    maxPayout: env.BET_MAX_PAYOUT,
    maxSelections: env.BET_MAX_SELECTIONS,
    maxTotalOdds: env.BET_MAX_TOTAL_ODDS,
    acceptHigherMaxPct: env.ODDS_ACCEPT_HIGHER_MAX_PCT,
  };
}

export interface DemoWalletPolicy {
  startingBalance: number;
  topUpAmount: number;
  topUpThreshold: number;
  topUpCooldownHours: number;
}

export function demoWalletPolicyFrom(env: {
  DEMO_STARTING_BALANCE: number;
  DEMO_TOPUP_AMOUNT: number;
  DEMO_TOPUP_THRESHOLD: number;
  DEMO_TOPUP_COOLDOWN_HOURS: number;
}): DemoWalletPolicy {
  return {
    startingBalance: env.DEMO_STARTING_BALANCE,
    topUpAmount: env.DEMO_TOPUP_AMOUNT,
    topUpThreshold: env.DEMO_TOPUP_THRESHOLD,
    topUpCooldownHours: env.DEMO_TOPUP_COOLDOWN_HOURS,
  };
}
