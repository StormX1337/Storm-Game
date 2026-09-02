import { z } from 'zod';
import type { Job, Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { Permission } from '@storm/types';
import { params, query } from '../../lib/validation.js';
import { ok } from '../../lib/response.js';
import { notFound } from '../../lib/errors.js';

/**
 * The work the panel does out of sight.
 *
 * Installs, backups, restores, transfers, webhook deliveries, mail and
 * schedules all run through queues. When one fails at three in the morning it
 * retries a few times, gives up, and sits in Redis for a week — where nothing
 * in the panel could reach it. The first anyone knew was a customer asking why
 * their backup was not there.
 *
 * So: what each queue is doing, what has failed and why, and the two things an
 * operator wants to do about it. Both writes are audited, because retrying an
 * install is not a read.
 */

/** The queues an operator may look at, by the name used in the URL. */
const QUEUES = ['install', 'backups', 'webhooks', 'mail', 'schedules', 'maintenance'] as const;
type QueueKey = (typeof QUEUES)[number];

/** What each one is for, so the page does not have to guess from a name. */
const QUEUE_LABELS: Record<QueueKey, string> = {
  install: 'Installs and reinstalls',
  backups: 'Backups, restores and transfers',
  webhooks: 'Webhook deliveries',
  mail: 'Outgoing email',
  schedules: 'Scheduled tasks',
  maintenance: 'Housekeeping',
};

const queueParam = z.object({ queue: z.enum(QUEUES) });

/** BullMQ ids are opaque; bound the length rather than the alphabet. */
const jobParam = queueParam.extend({ jobId: z.string().min(1).max(256) });

export default async function adminJobRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.requirePermission(Permission.ADMIN_DASHBOARD));

  /**
   * The queue behind a name.
   *
   * The name is validated against a fixed list rather than passed through, so
   * this cannot become a way to address arbitrary BullMQ keys in the Redis the
   * panel shares with its sessions and rate limiters.
   */
  const queueFor = (key: QueueKey): Queue => app.queues[key] as unknown as Queue;

  /** A failed job, flattened to what an operator can act on. */
  const describe = (job: Job): Record<string, unknown> => ({
    id: String(job.id ?? ''),
    name: job.name,
    attempts: job.attemptsMade,
    // The stack is not sent. It is long, it is for the panel's logs, and the
    // first line is what says which of the six things went wrong.
    reason: (job.failedReason ?? '').split('\n')[0]?.slice(0, 500) ?? '',
    data: job.data,
    createdAt: job.timestamp ? new Date(job.timestamp).toISOString() : null,
    failedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
  });

  app.get(
    '/',
    { schema: { tags: ['Admin: Jobs'], summary: 'What every queue is doing' } },
    async () => {
      const rows = await Promise.all(
        QUEUES.map(async (key) => {
          const queue = queueFor(key);
          // A queue whose Redis is unreachable reports as unreachable rather
          // than taking the whole page down with it.
          const counts = await queue
            .getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed', 'paused')
            .catch(() => null);

          return {
            key,
            label: QUEUE_LABELS[key],
            reachable: counts !== null,
            waiting: counts?.waiting ?? 0,
            active: counts?.active ?? 0,
            delayed: counts?.delayed ?? 0,
            completed: counts?.completed ?? 0,
            failed: counts?.failed ?? 0,
            paused: counts?.paused ?? 0,
          };
        }),
      );

      return ok(rows);
    },
  );

  app.get(
    '/:queue/failed',
    { schema: { tags: ['Admin: Jobs'], summary: 'Jobs that gave up, newest first' } },
    async (request) => {
      const { queue } = params(request, queueParam);
      const { limit } = query(
        request,
        z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) }),
      );

      const jobs = await queueFor(queue).getFailed(0, limit - 1);
      return ok(jobs.map(describe));
    },
  );

  app.post(
    '/:queue/:jobId/retry',
    {
      config: { rateLimit: { max: 30, timeWindow: '5 minutes' } },
      schema: { tags: ['Admin: Jobs'], summary: 'Put a failed job back in the queue' },
    },
    async (request) => {
      const { queue, jobId } = params(request, jobParam);

      const job = await queueFor(queue).getJob(jobId);
      if (!job) throw notFound('That job is no longer in the queue');
      await job.retry();

      await app.audit.log(request, {
        action: 'admin.job_retried',
        targetType: 'job',
        targetId: jobId,
        targetLabel: `${queue}/${job.name}`,
      });

      return ok({ retried: true, message: 'Queued again. Watch the count for the result.' });
    },
  );

  app.delete(
    '/:queue/:jobId',
    { schema: { tags: ['Admin: Jobs'], summary: 'Discard a failed job' } },
    async (request) => {
      const { queue, jobId } = params(request, jobParam);

      const job = await queueFor(queue).getJob(jobId);
      if (!job) throw notFound('That job is no longer in the queue');
      await job.remove();

      await app.audit.log(request, {
        action: 'admin.job_discarded',
        targetType: 'job',
        targetId: jobId,
        targetLabel: `${queue}/${job.name}`,
      });

      return ok({ discarded: true });
    },
  );
}
