/**
 * Fixed values that are part of the product's contract rather than of a
 * deployment. Anything an operator may reasonably tune lives in env.ts.
 */

export const APP_NAME = 'STORM BET';

/** Play money only. There is no code path that moves real funds. */
export const CURRENCY = 'DEMO' as const;

export const SESSION_COOKIE = 'sb_session';
export const CSRF_COOKIE = 'sb_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

export const TOKEN_TTL = {
  emailVerificationMinutes: 24 * 60,
  passwordResetMinutes: 30,
} as const;

export const REDIS_KEYS = {
  prefix: 'sb:',
  rateLimit: (bucket: string, id: string) => `sb:rl:${bucket}:${id}`,
  loginFailures: (subject: string) => `sb:auth:fail:${subject}`,
  lock: (name: string) => `sb:lock:${name}`,
  cache: (name: string) => `sb:cache:${name}`,
  session: (tokenHash: string) => `sb:session:${tokenHash}`,
  providerHealth: (provider: string) => `sb:provider:${provider}:health`,
  providerCircuit: (provider: string) => `sb:provider:${provider}:circuit`,
  workerHeartbeat: 'sb:worker:heartbeat',
  lastSync: (provider: string) => `sb:provider:${provider}:last-sync`,
} as const;

export const REDIS_CHANNELS = {
  realtime: 'sb:realtime',
  cacheInvalidation: 'sb:cache-invalidate',
} as const;

export const QUEUES = {
  oddsSync: 'odds-sync',
  settlement: 'settlement',
  maintenance: 'maintenance',
} as const;

/** Upper bounds that no configuration may exceed. */
export const HARD_LIMITS = {
  maxSelections: 20,
  maxStakeMinor: 100_000_00,
  maxPayoutMinor: 1_000_000_00,
  maxTotalOdds: 100_000,
} as const;
