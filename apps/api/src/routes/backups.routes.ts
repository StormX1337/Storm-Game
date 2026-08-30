import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  BackupStatus,
  ErrorCode,
  Permission,
  WebhookEvent,
  createBackupSchema,
  paginationQuerySchema,
} from '@storm/types';
import { body, params, query } from '../lib/validation.js';
import { ok, paginated, pageArgs } from '../lib/response.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { ServerAccessService } from '../services/server-access.service.js';
import { toBackupSummary } from '../lib/transformers.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const backupParam = idParam.extend({ backupId: z.string().min(1).max(64) });

export default async function backupRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  app.get('/:id/backups', { schema: { tags: ['Backups'], summary: 'List backups for a server' } }, async (request) => {
    const user = request.currentUser();
    const { id } = params(request, idParam);
    const q = query(request, paginationQuerySchema);
    const access = await app.serverAccess.require(user, id, Permission.SERVERS_BACKUPS);

    const where = { serverId: access.server.id };
    const [items, total, owner] = await Promise.all([
      app.prisma.backup.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...pageArgs(q.page, q.perPage),
      }),
      app.prisma.backup.count({ where }),
      app.prisma.user.findUniqueOrThrow({ where: { id: access.server.ownerId } }),
    ]);

    const response = paginated(items.map(toBackupSummary), total, q.page, q.perPage);
    return { ...response, data: { items: response.data, limit: owner.backupLimit, used: total } };
  });

  app.post('/:id/backups', { schema: { tags: ['Backups'], summary: 'Create a backup' } }, async (request, reply) => {
    const user = request.currentUser();
    const { id } = params(request, idParam);
    const input = body(request, createBackupSchema);
    const access = await app.serverAccess.require(user, id, Permission.SERVERS_BACKUPS_CREATE);
    ServerAccessService.assertNotSuspended(access);
    ServerAccessService.assertInstalled(access);

    const owner = await app.prisma.user.findUniqueOrThrow({ where: { id: access.server.ownerId } });
    const existing = await app.prisma.backup.count({ where: { serverId: access.server.id } });
    if (owner.backupLimit > 0 && existing >= owner.backupLimit) {
      throw new AppError(
        409,
        ErrorCode.RESOURCE_LIMIT_REACHED,
        `This server may keep at most ${owner.backupLimit} backups. Delete one first.`,
      );
    }

    const running = await app.prisma.backup.count({
      where: { serverId: access.server.id, status: { in: [BackupStatus.PENDING, BackupStatus.RUNNING] } },
    });
    if (running > 0) throw conflict('A backup for this server is already running');

    const storage = await app.prisma.backupStorage.findFirst({
      where: { isActive: true },
      orderBy: { isDefault: 'desc' },
    });
    if (!storage) throw new AppError(503, ErrorCode.STORAGE_ERROR, 'No backup storage is configured');

    const backup = await app.prisma.backup.create({
      data: {
        serverId: access.server.id,
        storageId: storage.id,
        createdById: user.id,
        name: input.name || `Backup — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
        ignoredFiles: input.ignoredFiles,
        isLocked: input.isLocked,
      },
    });

    await app.queues.enqueueBackup(backup.id);
    await app.audit.activity(request, {
      serverId: access.server.id,
      event: 'backup:created',
      metadata: { backupId: backup.id, name: backup.name },
    });
    await app.webhooks.dispatch(WebhookEvent.BACKUP_CREATED, {
      backupId: backup.id,
      serverId: access.server.id,
      name: backup.name,
    });

    return reply.status(201).send(ok(toBackupSummary(backup)));
  });

  app.get('/:id/backups/:backupId', { schema: { tags: ['Backups'] } }, async (request) => {
    const user = request.currentUser();
    const { id, backupId } = params(request, backupParam);
    const access = await app.serverAccess.require(user, id, Permission.SERVERS_BACKUPS);

    const backup = await app.prisma.backup.findFirst({
      where: { id: backupId, serverId: access.server.id },
    });
    if (!backup) throw notFound('Backup was not found', ErrorCode.BACKUP_NOT_FOUND);
    return ok(toBackupSummary(backup));
  });

  app.patch('/:id/backups/:backupId', { schema: { tags: ['Backups'], summary: 'Rename or lock a backup' } }, async (request) => {
    const user = request.currentUser();
    const { id, backupId } = params(request, backupParam);
    const input = body(
      request,
      z.object({ name: z.string().trim().min(1).max(100).optional(), isLocked: z.boolean().optional() }),
    );
    const access = await app.serverAccess.require(user, id, Permission.SERVERS_BACKUPS_CREATE);

    const backup = await app.prisma.backup.findFirst({
      where: { id: backupId, serverId: access.server.id },
    });
    if (!backup) throw notFound('Backup was not found', ErrorCode.BACKUP_NOT_FOUND);

    const updated = await app.prisma.backup.update({
      where: { id: backupId },
      data: {
        ...(input.name ? { name: input.name } : {}),
        ...(input.isLocked !== undefined ? { isLocked: input.isLocked } : {}),
      },
    });
    return ok(toBackupSummary(updated));
  });

  app.get('/:id/backups/:backupId/download', { schema: { tags: ['Backups'], summary: 'Download a backup archive' } }, async (request, reply) => {
    const user = request.currentUser();
    const { id, backupId } = params(request, backupParam);
    const access = await app.serverAccess.require(user, id, Permission.SERVERS_BACKUPS);

    const backup = await app.prisma.backup.findFirst({
      where: { id: backupId, serverId: access.server.id },
      include: { storage: true },
    });
    if (!backup) throw notFound('Backup was not found', ErrorCode.BACKUP_NOT_FOUND);
    if (backup.status !== BackupStatus.COMPLETED) {
      throw badRequest('That backup has not finished yet');
    }

    await app.audit.activity(request, {
      serverId: access.server.id,
      event: 'backup:download',
      metadata: { backupId },
    });

    // Object storage hands the browser a short-lived signed URL so the archive
    // never passes through the panel; local archives are streamed from the node.
    if (!app.storage.isLocal(backup.storage) && backup.storageKey) {
      const url = await app.storage.presignDownload(
        backup.storage,
        backup.storageKey,
        `${backup.name.replace(/[^\w.-]+/g, '_')}.tar.gz`,
      );
      return ok({ url });
    }

    const response = await app.agents.rawRequest(
      access.server.node,
      `/api/v1/servers/${access.server.uuid}/backups/${backup.uuid}/download`,
      { raw: true, timeoutMs: 0 },
    );
    if (response.statusCode >= 400) {
      throw new AppError(response.statusCode, ErrorCode.STORAGE_ERROR, 'That archive is no longer available');
    }

    void reply
      .header('content-type', 'application/gzip')
      .header(
        'content-disposition',
        `attachment; filename="${backup.name.replace(/[^\w.-]+/g, '_')}.tar.gz"`,
      );
    return reply.send(response.body);
  });

  app.post('/:id/backups/:backupId/restore', { schema: { tags: ['Backups'], summary: 'Restore a backup' } }, async (request) => {
    const user = request.currentUser();
    const { id, backupId } = params(request, backupParam);
    const input = body(request, z.object({ truncate: z.boolean().default(false) }));
    const access = await app.serverAccess.require(user, id, Permission.SERVERS_BACKUPS_RESTORE);
    ServerAccessService.assertNotSuspended(access);

    const backup = await app.prisma.backup.findFirst({
      where: { id: backupId, serverId: access.server.id },
    });
    if (!backup) throw notFound('Backup was not found', ErrorCode.BACKUP_NOT_FOUND);
    if (backup.status !== BackupStatus.COMPLETED) throw badRequest('That backup is not restorable');

    // A restore rewrites the data directory; the server must be stopped first.
    if (access.server.status !== 'OFFLINE' && access.server.status !== 'CRASHED') {
      throw conflict('Stop the server before restoring a backup');
    }

    await app.queues.enqueueRestore(backup.id, input.truncate, user.id);
    await app.audit.activity(request, {
      serverId: access.server.id,
      event: 'backup:restore',
      metadata: { backupId, truncate: input.truncate },
    });

    return ok({ queued: true });
  });

  app.delete('/:id/backups/:backupId', { schema: { tags: ['Backups'] } }, async (request) => {
    const user = request.currentUser();
    const { id, backupId } = params(request, backupParam);
    const access = await app.serverAccess.require(user, id, Permission.SERVERS_BACKUPS_DELETE);

    const backup = await app.prisma.backup.findFirst({
      where: { id: backupId, serverId: access.server.id },
      include: { storage: true },
    });
    if (!backup) throw notFound('Backup was not found', ErrorCode.BACKUP_NOT_FOUND);
    if (backup.isLocked) throw badRequest('That backup is locked. Unlock it before deleting.');
    if (backup.status === BackupStatus.RUNNING) throw conflict('That backup is still being created');

    await app.prisma.backup.update({ where: { id: backupId }, data: { status: BackupStatus.DELETING } });

    try {
      if (backup.storageKey) {
        if (app.storage.isLocal(backup.storage)) {
          await app.agents.request(
            access.server.node,
            `/api/v1/servers/${access.server.uuid}/backups/${backup.uuid}`,
            { method: 'DELETE' },
          );
        } else {
          await app.storage.remove(backup.storage, backup.storageKey);
        }
      }
    } catch (error) {
      app.log.warn({ err: error, backupId }, 'failed to remove backup archive; deleting record anyway');
    }

    await app.prisma.backup.delete({ where: { id: backupId } });
    await app.audit.activity(request, {
      serverId: access.server.id,
      event: 'backup:deleted',
      metadata: { backupId, name: backup.name },
    });

    return ok({ deleted: true });
  });
}
