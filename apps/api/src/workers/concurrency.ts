import type { FastifyInstance } from 'fastify';

/**
 * Queue concurrency, scaled by WORKER_CONCURRENCY. Each queue keeps its own
 * base number — installs and backups are heavy, webhooks are mostly waiting on
 * the network — and the environment variable moves them all together.
 */
export function concurrency(app: FastifyInstance, base: number): number {
  return Math.max(1, Math.round(base * app.env.WORKER_CONCURRENCY));
}
