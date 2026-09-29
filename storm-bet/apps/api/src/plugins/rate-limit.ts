import { consumeRateLimit, type RateLimitRule, type Redis } from '@storm-bet/redis';
import { AppError } from '@storm-bet/types';
import type { FastifyReply, FastifyRequest } from 'fastify';

export const RATE_LIMITS = {
  global: { bucket: 'global-ip', limit: 900, windowMs: 60_000 },
  login: { bucket: 'login-ip', limit: 20, windowMs: 10 * 60_000 },
  register: { bucket: 'register-ip', limit: 10, windowMs: 60 * 60_000 },
  passwordReset: { bucket: 'reset-ip', limit: 5, windowMs: 15 * 60_000 },
  verification: { bucket: 'verify-user', limit: 3, windowMs: 15 * 60_000 },
  placeBet: { bucket: 'place-user', limit: 30, windowMs: 60_000 },
  validateSlip: { bucket: 'validate-ip', limit: 240, windowMs: 60_000 },
  topUp: { bucket: 'topup-user', limit: 5, windowMs: 60 * 60_000 },
  contact: { bucket: 'contact-ip', limit: 3, windowMs: 60 * 60_000 },
  admin: { bucket: 'admin-user', limit: 300, windowMs: 60_000 },
  adminWrite: { bucket: 'admin-write-user', limit: 60, windowMs: 60_000 },
  stream: { bucket: 'stream-ip', limit: 30, windowMs: 60_000 },
} satisfies Record<string, RateLimitRule>;

/**
 * Consumes one unit of `rule` for `identifier` and throws RATE_LIMITED when
 * exhausted. A Redis outage fails open for rate limiting (availability over
 * throttling) — every money-relevant check lives in PostgreSQL anyway.
 */
export async function enforceRateLimit(
  redis: Redis,
  rule: RateLimitRule,
  identifier: string,
  reply?: FastifyReply,
): Promise<void> {
  let result;
  try {
    result = await consumeRateLimit(redis, rule, identifier);
  } catch {
    return;
  }
  if (reply) {
    reply.header('RateLimit-Limit', rule.limit);
    reply.header('RateLimit-Remaining', result.remaining);
  }
  if (!result.allowed) {
    const retryAfter = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
    throw new AppError('RATE_LIMITED', undefined, { retryAfter });
  }
}

export const limitBy =
  (redis: Redis, rule: RateLimitRule, key: 'ip' | 'user') =>
  async (request: FastifyRequest, reply: FastifyReply) => {
    const identifier = key === 'user' && request.session ? request.session.userId : request.ip;
    await enforceRateLimit(redis, rule, identifier, reply);
  };
