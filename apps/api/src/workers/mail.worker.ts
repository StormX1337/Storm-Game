import { Worker } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { QUEUE_NAMES } from '@storm/config';
import type { MailJobData } from '../plugins/queues.js';
import { concurrency } from './concurrency.js';

export function createMailWorker(app: FastifyInstance): Worker<MailJobData> {
  return new Worker<MailJobData>(
    QUEUE_NAMES.mail,
    async (job) => {
      await app.mail.send(job.data);
    },
    { connection: { url: app.env.REDIS_URL }, concurrency: concurrency(app, 5) },
  );
}
