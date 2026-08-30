import fp from 'fastify-plugin';
import { Queue, type JobsOptions } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { QUEUE_NAMES } from '@storm/config';

export interface InstallJobData {
  serverId: string;
  startOnCompletion: boolean;
  reinstall?: boolean;
  wipe?: boolean;
}

export interface BackupJobData {
  backupId: string;
}

export interface RestoreJobData {
  backupId: string;
  truncate: boolean;
  userId: string | null;
}

export interface WebhookJobData {
  webhookId: string;
  event: string;
  payload: Record<string, unknown>;
}

export interface MailJobData {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface ScheduleJobData {
  scheduleId: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    queues: {
      install: Queue<InstallJobData>;
      backups: Queue<BackupJobData | RestoreJobData>;
      webhooks: Queue<WebhookJobData>;
      mail: Queue<MailJobData>;
      schedules: Queue<ScheduleJobData>;
      maintenance: Queue;
      enqueueInstall: (serverId: string, options?: Partial<InstallJobData>) => Promise<void>;
      enqueueBackup: (backupId: string) => Promise<void>;
      enqueueRestore: (backupId: string, truncate: boolean, userId: string | null) => Promise<void>;
      enqueueWebhook: (webhookId: string, event: string, payload: Record<string, unknown>) => Promise<void>;
      enqueueMail: (data: MailJobData) => Promise<void>;
      enqueueSchedule: (scheduleId: string) => Promise<void>;
    };
  }
}

const RETRY: JobsOptions = {
  attempts: 4,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { age: 3600, count: 500 },
  removeOnFail: { age: 86400 * 7 },
};

export default fp(
  async function queuesPlugin(app: FastifyInstance) {
    const connection = { url: app.env.REDIS_URL };

    const install = new Queue<InstallJobData>(QUEUE_NAMES.installs, { connection });
    const backups = new Queue<BackupJobData | RestoreJobData>(QUEUE_NAMES.backups, { connection });
    const webhooks = new Queue<WebhookJobData>(QUEUE_NAMES.webhooks, { connection });
    const mail = new Queue<MailJobData>(QUEUE_NAMES.mail, { connection });
    const schedules = new Queue<ScheduleJobData>(QUEUE_NAMES.schedules, { connection });
    const maintenance = new Queue(QUEUE_NAMES.maintenance, { connection });

    app.decorate('queues', {
      install,
      backups,
      webhooks,
      mail,
      schedules,
      maintenance,

      async enqueueInstall(serverId, options = {}) {
        await install.add(
          'install',
          { serverId, startOnCompletion: false, ...options },
          // Installs are long and expensive; a single retry avoids hammering a
          // node that is genuinely broken.
          { ...RETRY, attempts: 2, jobId: `install-${serverId}-${Date.now()}` },
        );
      },

      async enqueueBackup(backupId) {
        await backups.add('backup', { backupId }, { ...RETRY, attempts: 2, jobId: `backup-${backupId}` });
      },

      async enqueueRestore(backupId, truncate, userId) {
        await backups.add(
          'restore',
          { backupId, truncate, userId },
          { ...RETRY, attempts: 1, jobId: `restore-${backupId}-${Date.now()}` },
        );
      },

      async enqueueWebhook(webhookId, event, payload) {
        await webhooks.add('deliver', { webhookId, event, payload }, RETRY);
      },

      async enqueueMail(data) {
        await mail.add('send', data, RETRY);
      },

      async enqueueSchedule(scheduleId) {
        await schedules.add('run', { scheduleId }, { ...RETRY, attempts: 1 });
      },
    });

    app.addHook('onClose', async () => {
      await Promise.allSettled([
        install.close(),
        backups.close(),
        webhooks.close(),
        mail.close(),
        schedules.close(),
        maintenance.close(),
      ]);
    });
  },
  { name: 'storm-queues', dependencies: ['storm-env'] },
);
