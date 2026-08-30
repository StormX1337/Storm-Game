import type { FastifyInstance } from 'fastify';
import { STORM_VERSION } from '@storm/config';
import type { HealthReport } from '@storm/types';

/**
 * Liveness and readiness probes.
 *
 * `/health` answers as long as the process is up (liveness); `/ready` and
 * `/api/health` verify the dependencies the panel cannot serve traffic without
 * and return 503 when any of them is down, so an orchestrator drains the
 * replica instead of sending it requests.
 */
export default async function healthRoutes(app: FastifyInstance): Promise<void> {
  const startedAt = Date.now();

  async function probe(): Promise<HealthReport> {
    const checks: HealthReport['checks'] = {};

    const database = Date.now();
    try {
      await app.prisma.$queryRaw`SELECT 1`;
      checks.database = { status: 'ok', latencyMs: Date.now() - database };
    } catch (error) {
      checks.database = {
        status: 'error',
        message: error instanceof Error ? error.message : 'unreachable',
      };
    }

    const redis = Date.now();
    try {
      await app.redis.ping();
      checks.redis = { status: 'ok', latencyMs: Date.now() - redis };
    } catch (error) {
      checks.redis = {
        status: 'error',
        message: error instanceof Error ? error.message : 'unreachable',
      };
    }

    try {
      const [waiting, active, failed] = await Promise.all([
        app.queues.backups.getWaitingCount(),
        app.queues.backups.getActiveCount(),
        app.queues.backups.getFailedCount(),
      ]);
      checks.queue = { status: 'ok', message: `waiting=${waiting} active=${active} failed=${failed}` };
    } catch (error) {
      checks.queue = {
        status: 'error',
        message: error instanceof Error ? error.message : 'unreachable',
      };
    }

    try {
      const [total, online] = await Promise.all([
        app.prisma.node.count(),
        app.prisma.node.count({ where: { status: { in: ['ONLINE', 'MAINTENANCE'] } } }),
      ]);
      // Nodes being offline degrades the panel but never makes it unready:
      // customers must still be able to sign in and see what is happening.
      checks.nodes = {
        status: 'ok',
        message: `${online}/${total} reachable`,
      };
    } catch {
      checks.nodes = { status: 'error', message: 'unavailable' };
    }

    const critical = ['database', 'redis', 'queue'];
    const failedCritical = critical.filter((key) => checks[key]?.status === 'error');

    return {
      status: failedCritical.length > 0 ? 'error' : 'ok',
      version: STORM_VERSION,
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      checks,
    };
  }

  app.get('/health', { schema: { tags: ['System'], summary: 'Liveness probe' } }, async () => ({
    success: true,
    data: { status: 'ok', version: STORM_VERSION, uptime: Math.floor((Date.now() - startedAt) / 1000) },
  }));

  app.get('/ready', { schema: { tags: ['System'], summary: 'Readiness probe' } }, async (_request, reply) => {
    const report = await probe();
    return reply.status(report.status === 'ok' ? 200 : 503).send({ success: report.status === 'ok', data: report });
  });

  app.get('/api/health', { schema: { tags: ['System'], summary: 'Detailed health report' } }, async (_request, reply) => {
    const report = await probe();
    return reply.status(report.status === 'ok' ? 200 : 503).send({ success: report.status === 'ok', data: report });
  });
}
