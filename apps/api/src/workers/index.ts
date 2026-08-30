import type { FastifyInstance } from 'fastify';
import type { Worker } from 'bullmq';
import { createInstallWorker } from './install.worker.js';
import { createBackupWorker } from './backup.worker.js';
import { createWebhookWorker } from './webhook.worker.js';
import { createMailWorker } from './mail.worker.js';
import { createScheduleWorker } from './schedule.worker.js';
import { createMaintenanceWorker, scheduleMaintenanceJobs } from './maintenance.worker.js';

/**
 * Boots every background worker in-process. Set ENABLE_WORKERS=false on extra
 * API replicas so jobs are processed by exactly one deployment.
 */
export async function startWorkers(app: FastifyInstance): Promise<Worker[]> {
  const workers: Worker[] = [
    createInstallWorker(app),
    createBackupWorker(app),
    createWebhookWorker(app),
    createMailWorker(app),
    createScheduleWorker(app),
    createMaintenanceWorker(app),
  ];

  for (const worker of workers) {
    worker.on('failed', (job, error) => {
      app.log.error({ err: error, queue: worker.name, jobId: job?.id }, 'job failed');
    });
    worker.on('error', (error) => {
      app.log.error({ err: error, queue: worker.name }, 'worker error');
    });
  }

  await scheduleMaintenanceJobs(app.queues.maintenance);
  app.log.info({ workers: workers.length }, 'background workers started');

  app.addHook('onClose', async () => {
    await Promise.allSettled(workers.map((worker) => worker.close()));
  });

  return workers;
}
