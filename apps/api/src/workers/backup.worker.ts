import { Worker } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { QUEUE_NAMES } from '@storm/config';
import { BackupStatus, NotificationType, WebhookEvent, type AgentBackupResult } from '@storm/types';
import type { BackupJobData, RestoreJobData, TransferJobData } from '../plugins/queues.js';
import { runTransfer } from './transfer.worker.js';
import { concurrency } from './concurrency.js';

/** Executes backup creation and restoration against the owning node. */
export function createBackupWorker(
  app: FastifyInstance,
): Worker<BackupJobData | RestoreJobData | TransferJobData> {
  return new Worker<BackupJobData | RestoreJobData | TransferJobData>(
    QUEUE_NAMES.backups,
    async (job) => {
      // A move shares this queue because it is the same kind of work: hours
      // long, node-bound, and made of the very backup and restore below.
      if (job.name === 'transfer') {
        await runTransfer(app, job.data as TransferJobData);
        return;
      }
      if (job.name === 'restore') {
        await runRestore(app, job.data as RestoreJobData);
        return;
      }
      await runBackup(app, job.data as BackupJobData);
    },
    { connection: { url: app.env.REDIS_URL }, concurrency: concurrency(app, 3) },
  );
}

async function runBackup(app: FastifyInstance, data: BackupJobData): Promise<void> {
  const backup = await app.prisma.backup.findUnique({
    where: { id: data.backupId },
    include: { server: { include: { node: true } }, storage: true },
  });
  if (!backup) return;

  await app.prisma.backup.update({
    where: { id: backup.id },
    data: { status: BackupStatus.RUNNING },
  });

  try {
    const upload = await app.storage.uploadTarget(backup.storage, backup.server.uuid, backup.uuid);

    const result = await app.agents.request<AgentBackupResult>(
      backup.server.node,
      `/api/v1/servers/${backup.server.uuid}/backups`,
      {
        method: 'POST',
        body: {
          uuid: backup.server.uuid,
          backupUuid: backup.uuid,
          ignore: backup.ignoredFiles,
          upload,
        },
        timeoutMs: 6 * 3600_000,
      },
    );

    await app.prisma.backup.update({
      where: { id: backup.id },
      data: {
        status: BackupStatus.COMPLETED,
        bytes: BigInt(result.bytes ?? 0),
        checksum: result.checksum ?? null,
        storageKey: upload.key,
        completedAt: new Date(),
        error: null,
      },
    });

    await app.audit.system({
      action: 'backup.completed',
      targetType: 'backup',
      targetId: backup.id,
      targetLabel: backup.name,
      metadata: { serverId: backup.serverId, bytes: result.bytes },
    });
    await app.notifications.push(backup.server.ownerId, {
      type: NotificationType.BACKUP_COMPLETED,
      title: 'Backup complete',
      message: `Backup "${backup.name}" for ${backup.server.name} finished successfully.`,
      level: 'SUCCESS',
      link: `/servers/${backup.server.shortId}/backups`,
    });
    await app.webhooks.dispatch(WebhookEvent.BACKUP_COMPLETED, {
      backupId: backup.id,
      serverId: backup.serverId,
      bytes: result.bytes,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await app.prisma.backup.update({
      where: { id: backup.id },
      data: { status: BackupStatus.FAILED, error: message.slice(0, 500) },
    });
    await app.notifications.push(backup.server.ownerId, {
      type: NotificationType.BACKUP_FAILED,
      title: 'Backup failed',
      message: `Backup "${backup.name}" for ${backup.server.name} failed: ${message.slice(0, 160)}`,
      level: 'ERROR',
      link: `/servers/${backup.server.shortId}/backups`,
    });
    await app.webhooks.dispatch(WebhookEvent.BACKUP_FAILED, {
      backupId: backup.id,
      serverId: backup.serverId,
      error: message,
    });
    throw error;
  }
}

async function runRestore(app: FastifyInstance, data: RestoreJobData): Promise<void> {
  const backup = await app.prisma.backup.findUnique({
    where: { id: data.backupId },
    include: { server: { include: { node: true } }, storage: true },
  });
  if (!backup || !backup.storageKey) return;

  const previousStatus = backup.status;
  await app.prisma.backup.update({
    where: { id: backup.id },
    data: { status: BackupStatus.RESTORING },
  });

  try {
    const download = await app.storage.downloadSource(
      backup.storage,
      backup.server.uuid,
      backup.uuid,
    );

    await app.agents.request(
      backup.server.node,
      `/api/v1/servers/${backup.server.uuid}/backups/${backup.uuid}/restore`,
      {
        method: 'POST',
        body: {
          uuid: backup.server.uuid,
          backupUuid: backup.uuid,
          truncate: data.truncate,
          download,
        },
        timeoutMs: 6 * 3600_000,
      },
    );

    await app.prisma.backup.update({ where: { id: backup.id }, data: { status: previousStatus } });
    await app.audit.system({
      action: 'backup.restored',
      targetType: 'backup',
      targetId: backup.id,
      targetLabel: backup.name,
      metadata: { serverId: backup.serverId, userId: data.userId },
    });
    await app.notifications.push(backup.server.ownerId, {
      type: NotificationType.BACKUP_RESTORED,
      title: 'Backup restored',
      message: `Backup "${backup.name}" was restored to ${backup.server.name}.`,
      level: 'SUCCESS',
      link: `/servers/${backup.server.shortId}/backups`,
    });
    await app.webhooks.dispatch(WebhookEvent.BACKUP_RESTORED, {
      backupId: backup.id,
      serverId: backup.serverId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await app.prisma.backup.update({
      where: { id: backup.id },
      data: { status: previousStatus, error: message.slice(0, 500) },
    });
    await app.notifications.push(backup.server.ownerId, {
      type: NotificationType.BACKUP_FAILED,
      title: 'Restore failed',
      message: `Restoring "${backup.name}" failed: ${message.slice(0, 160)}`,
      level: 'ERROR',
      link: `/servers/${backup.server.shortId}/backups`,
    });
    throw error;
  }
}
