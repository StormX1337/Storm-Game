import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  ErrorCode,
  NodeStatus,
  Permission,
  ServerStatus,
  auditQuerySchema,
  createBackupStorageSchema,
  createDatabaseHostSchema,
  createWebhookSchema,
  paginationQuerySchema,
  updateBackupStorageSchema,
  updateDatabaseHostSchema,
  updateSettingsSchema,
  updateWebhookSchema,
  WEBHOOK_EVENTS,
  type AdminOverview,
  type NodeLiveStats,
} from '@storm/types';
import { assertSafeUrl, generateToken, signWebhook } from '@storm/security';
import { request as undiciRequest } from 'undici';
import { readSettings, writeSettings } from '@storm/database';
import { body, params, query } from '../../lib/validation.js';
import { ok, paginated, pageArgs } from '../../lib/response.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { toAuditLog } from '../../lib/transformers.js';
import { renderMail } from '../../services/mail.service.js';

const idParam = z.object({ id: z.string().min(1).max(64) });

export default async function adminSystemRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  /* -------------------------------------------------------- webhooks -- */

  app.post(
    '/webhooks/:id/test',
    {
      config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
      preHandler: app.requirePermission(Permission.WEBHOOKS_MANAGE),
      schema: { tags: ['Admin'], summary: 'Send a signed test delivery' },
    },
    async (request) => {
      const { id } = params(request, idParam);
      const hook = await app.prisma.webhook.findUnique({ where: { id } });
      if (!hook) throw notFound('Webhook was not found');

      const secret = app.encrypter.tryDecrypt(hook.secretEnc) ?? '';
      const payload = {
        event: 'panel.test',
        deliveredAt: new Date().toISOString(),
        message:
          'A test delivery from Storm Panel. Verify the signature the same way you would a real one.',
      };
      const body = JSON.stringify(payload);
      const timestamp = Math.floor(Date.now() / 1000);
      const started = Date.now();

      let status = 0;
      let error: string | null = null;
      let responseBody = '';

      try {
        // Re-checked here exactly as at delivery time: a hostname that has
        // started resolving to something internal must not become a way to
        // probe the panel's own network from the admin area.
        await assertSafeUrl(hook.url);

        const response = await undiciRequest(hook.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'StormPanel-Webhook/1.0',
            'x-storm-event': 'panel.test',
            'x-storm-signature': signWebhook(secret, timestamp, body),
            'x-storm-delivery': `test_${timestamp}`,
          },
          body,
          headersTimeout: 10_000,
          bodyTimeout: 10_000,
        });

        status = response.statusCode;
        // A snippet is enough to recognise "that is my endpoint" or an error
        // page from something else entirely.
        responseBody = (await response.body.text()).slice(0, 300);
        if (status >= 400) error = `The endpoint responded with ${status}`;
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }

      // Recorded like any other delivery, so a test appears in the same history
      // an operator is already reading.
      await app.prisma.webhookDelivery.create({
        data: {
          webhookId: hook.id,
          event: 'panel.test',
          payload: payload as object,
          status: error ? 'FAILED' : 'SUCCESS',
          responseCode: status || null,
          error: error?.slice(0, 500) ?? null,
        },
      });

      await app.audit.log(request, {
        action: 'admin.webhook_tested',
        targetType: 'webhook',
        targetId: hook.id,
        targetLabel: hook.name,
        metadata: { status, ok: !error },
      });

      return ok({
        ok: !error,
        status: status || null,
        error,
        responseBody,
        tookMs: Date.now() - started,
      });
    },
  );

  /* ------------------------------------------------------------ mail -- */

  app.post(
    '/settings/mail/test',
    {
      // Sending costs money and reputation, and a loop here would be someone
      // else's spam problem.
      config: { rateLimit: { max: 5, timeWindow: '10 minutes' } },
      preHandler: app.requirePermission(Permission.SETTINGS_MANAGE),
      schema: { tags: ['Admin'], summary: 'Prove the SMTP configuration works' },
    },
    async (request) => {
      const user = request.currentUser();

      if (!app.mail.enabled) {
        throw badRequest(
          'No SMTP server is configured. Set SMTP_HOST and restart the API; until then, verification and reset links are written to the API log.',
        );
      }

      // Deliberately only to the caller's own address. A field for "send to
      // anyone" turns an admin session into a relay for whatever the panel
      // will render.
      const started = Date.now();
      try {
        await app.mail.verify();
      } catch (cause) {
        // The SMTP error is the whole value here: "535 authentication failed"
        // says what to fix, "could not connect" says something else entirely.
        throw badRequest(
          `The SMTP server rejected the connection: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }

      const settings = await readSettings(app.prisma);
      const { html, text } = renderMail('Test email', [
        `This is a test from <strong>${settings.panelName}</strong>, sent because you asked for one in the administration area.`,
        'If it reached you, password resets and email verification will reach your customers too.',
      ]);

      try {
        await app.mail.send({
          to: user.email,
          subject: `${settings.panelName}: test email`,
          html,
          text,
        });
      } catch (cause) {
        throw badRequest(
          `Connected, but sending failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }

      await app.audit.log(request, {
        action: 'admin.mail_tested',
        targetType: 'settings',
        targetId: 'mail',
        targetLabel: user.email,
      });

      return ok({ sentTo: user.email, tookMs: Date.now() - started });
    },
  );

  /* --------------------------------------------------------- updates -- */

  app.get(
    '/updates',
    {
      preHandler: app.requirePermission(Permission.PANEL_UPDATE),
      schema: { tags: ['Admin'], summary: 'Current version and whether an update exists' },
    },
    async () => ok(await app.updates.status()),
  );

  app.post(
    '/updates/apply',
    {
      // Tighter than the rest of the admin surface: this replaces the running
      // code, and a stolen session should not be able to do it on repeat.
      config: { rateLimit: { max: 5, timeWindow: '10 minutes' } },
      preHandler: app.requirePermission(Permission.PANEL_UPDATE),
      schema: { tags: ['Admin'], summary: 'Ask the host-side updater to apply an update' },
    },
    async (request) => {
      const input = body(request, z.object({ commit: z.string().min(7).max(40) }));
      const current = await app.updates.status();

      // Only ever the version the panel just offered. Without this the endpoint
      // is "run any commit of anything the repository has ever held".
      if (input.commit !== current.available.commit) {
        throw badRequest('That is no longer the latest version. Refresh and try again.');
      }
      if (!current.canApply) {
        throw badRequest(current.reason ?? 'This deployment cannot apply updates from the panel.');
      }

      const user = request.currentUser();
      const job = await app.updates.request(input.commit, user.username);

      await app.audit.log(request, {
        action: 'admin.panel_update_requested',
        targetType: 'panel',
        targetId: job.id,
        targetLabel: `${current.current.shortCommit} → ${current.available.shortCommit}`,
        metadata: {
          from: current.current.commit,
          to: input.commit,
          behindBy: current.available.behindBy,
        },
      });

      return ok(job);
    },
  );

  /* -------------------------------------------------------- overview -- */

  app.get(
    '/overview',
    {
      preHandler: app.requirePermission(Permission.ADMIN_DASHBOARD),
      schema: { tags: ['Admin'], summary: 'Administration dashboard metrics' },
    },
    async () => {
      const weekAgo = new Date(Date.now() - 7 * 86400_000);
      const activeCutoff = new Date(Date.now() - 15 * 60_000);

      const [totalUsers, onlineUsers, suspendedUsers, newUsers, serverCounts, nodes, recentEvents] =
        await Promise.all([
          app.prisma.user.count(),
          app.prisma.session.findMany({
            where: { revokedAt: null, lastUsedAt: { gte: activeCutoff } },
            distinct: ['userId'],
            select: { userId: true },
          }),
          app.prisma.user.count({ where: { suspendedAt: { not: null } } }),
          app.prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),
          app.prisma.server.groupBy({ by: ['status'], _count: { _all: true } }),
          app.prisma.node.findMany({
            include: { servers: { select: { memoryLimit: true, diskLimit: true } } },
          }),
          app.prisma.auditLog.findMany({
            include: { actor: true },
            orderBy: { createdAt: 'desc' },
            take: 15,
          }),
        ]);

      const byStatus = new Map(serverCounts.map((row) => [row.status, row._count._all]));
      const total = serverCounts.reduce((sum, row) => sum + row._count._all, 0);

      // Live node stats come from Redis, written by the heartbeat handler.
      const liveStats = await Promise.all(
        nodes.map(async (node) => {
          const cached = await app.redis.get(`storm:node:${node.uuid}:stats`);
          return cached ? (JSON.parse(cached) as NodeLiveStats) : null;
        }),
      );

      const resources = liveStats.reduce(
        (acc, stats, index) => {
          const node = nodes[index]!;
          if (stats) {
            acc.cpuSum += stats.cpuPercent;
            acc.cpuCount += 1;
            acc.memoryUsed += stats.memoryUsed;
            acc.diskUsed += stats.diskUsed;
            acc.networkRx += stats.networkRx;
            acc.networkTx += stats.networkTx;
          }
          acc.memoryTotal += node.memoryTotal * 1024 * 1024;
          acc.diskTotal += node.diskTotal * 1024 * 1024;
          return acc;
        },
        {
          cpuSum: 0,
          cpuCount: 0,
          memoryUsed: 0,
          memoryTotal: 0,
          diskUsed: 0,
          diskTotal: 0,
          networkRx: 0,
          networkTx: 0,
        },
      );

      const overview: AdminOverview = {
        users: {
          total: totalUsers,
          online: onlineUsers.length,
          suspended: suspendedUsers,
          newThisWeek: newUsers,
        },
        servers: {
          total,
          online: byStatus.get(ServerStatus.ONLINE) ?? 0,
          offline:
            (byStatus.get(ServerStatus.OFFLINE) ?? 0) + (byStatus.get(ServerStatus.CRASHED) ?? 0),
          suspended: byStatus.get(ServerStatus.SUSPENDED) ?? 0,
        },
        nodes: {
          total: nodes.length,
          online: nodes.filter((node) => node.status === NodeStatus.ONLINE).length,
          offline: nodes.filter((node) => node.status === NodeStatus.OFFLINE).length,
          degraded: nodes.filter((node) => node.status === NodeStatus.DEGRADED).length,
          maintenance: nodes.filter((node) => node.status === NodeStatus.MAINTENANCE).length,
        },
        resources: {
          cpuPercent: resources.cpuCount > 0 ? resources.cpuSum / resources.cpuCount : 0,
          memoryUsed: resources.memoryUsed,
          memoryTotal: resources.memoryTotal,
          diskUsed: resources.diskUsed,
          diskTotal: resources.diskTotal,
          networkRx: resources.networkRx,
          networkTx: resources.networkTx,
        },
        recentEvents: recentEvents.map(toAuditLog),
      };

      return ok(overview);
    },
  );

  /* ------------------------------------------------------- audit log -- */

  app.get(
    '/audit',
    { preHandler: app.requirePermission(Permission.AUDIT_VIEW), schema: { tags: ['Admin'] } },
    async (request) => {
      const q = query(request, auditQuerySchema);

      const where = {
        ...(q.action ? { action: { contains: q.action, mode: 'insensitive' as const } } : {}),
        ...(q.actorId ? { actorId: q.actorId } : {}),
        ...(q.targetType ? { targetType: q.targetType } : {}),
        ...(q.targetId ? { targetId: q.targetId } : {}),
        ...(q.from || q.to
          ? {
              createdAt: {
                ...(q.from ? { gte: new Date(q.from) } : {}),
                ...(q.to ? { lte: new Date(q.to) } : {}),
              },
            }
          : {}),
        ...(q.search
          ? {
              OR: [
                { action: { contains: q.search, mode: 'insensitive' as const } },
                { targetLabel: { contains: q.search, mode: 'insensitive' as const } },
                { actorLabel: { contains: q.search, mode: 'insensitive' as const } },
                { ip: { contains: q.search } },
              ],
            }
          : {}),
      };

      const [items, total] = await Promise.all([
        app.prisma.auditLog.findMany({
          where,
          include: { actor: true },
          orderBy: { createdAt: 'desc' },
          ...pageArgs(q.page, q.perPage),
        }),
        app.prisma.auditLog.count({ where }),
      ]);

      return paginated(items.map(toAuditLog), total, q.page, q.perPage);
    },
  );

  /* -------------------------------------------------------- settings -- */

  app.get(
    '/settings',
    { preHandler: app.requirePermission(Permission.SETTINGS_MANAGE), schema: { tags: ['Admin'] } },
    async () => ok(await readSettings(app.prisma)),
  );

  app.patch(
    '/settings',
    { preHandler: app.requirePermission(Permission.SETTINGS_MANAGE), schema: { tags: ['Admin'] } },
    async (request) => {
      const input = body(request, updateSettingsSchema);
      const settings = await writeSettings(app.prisma, input);
      // The maintenance guard reads from a cache on every request; without
      // this, flipping the switch here would take effect only once that copy
      // expired, and the administrator would watch nothing happen.
      app.settings.invalidate();

      await app.audit.log(request, {
        action: 'admin.settings_updated',
        targetType: 'settings',
        metadata: { fields: Object.keys(input) },
      });

      return ok(settings);
    },
  );

  /* ------------------------------------------------- backup storages -- */

  app.get(
    '/backup-storages',
    {
      preHandler: app.requirePermission(Permission.BACKUP_STORAGE_MANAGE),
      schema: { tags: ['Admin'] },
    },
    async () => {
      const storages = await app.prisma.backupStorage.findMany({
        include: { _count: { select: { backups: true } } },
        orderBy: { createdAt: 'asc' },
      });
      return ok(
        storages.map((storage) => ({
          id: storage.id,
          name: storage.name,
          driver: storage.driver,
          isDefault: storage.isDefault,
          bucket: storage.bucket,
          region: storage.region,
          endpoint: storage.endpoint,
          pathPrefix: storage.pathPrefix,
          forcePathStyle: storage.forcePathStyle,
          retentionDays: storage.retentionDays,
          isActive: storage.isActive,
          backupCount: storage._count.backups,
          hasCredentials: Boolean(storage.accessKeyEnc),
          createdAt: storage.createdAt.toISOString(),
        })),
      );
    },
  );

  app.post(
    '/backup-storages',
    {
      preHandler: app.requirePermission(Permission.BACKUP_STORAGE_MANAGE),
      schema: { tags: ['Admin'] },
    },
    async (request, reply) => {
      const input = body(request, createBackupStorageSchema);
      if (input.driver !== 'LOCAL' && (!input.bucket || !input.accessKey || !input.secretKey)) {
        throw badRequest('Object storage requires a bucket, access key and secret key');
      }

      const storage = await app.prisma.$transaction(async (tx) => {
        if (input.isDefault) {
          await tx.backupStorage.updateMany({ where: {}, data: { isDefault: false } });
        }
        return tx.backupStorage.create({
          data: {
            name: input.name,
            driver: input.driver,
            isDefault: input.isDefault,
            bucket: input.bucket ?? null,
            region: input.region ?? null,
            endpoint: input.endpoint ?? null,
            accessKeyEnc: input.accessKey ? app.encrypter.encrypt(input.accessKey) : null,
            secretKeyEnc: input.secretKey ? app.encrypter.encrypt(input.secretKey) : null,
            pathPrefix: input.pathPrefix,
            forcePathStyle: input.forcePathStyle,
            retentionDays: input.retentionDays,
            isActive: input.isActive,
          },
        });
      });

      await app.audit.log(request, {
        action: 'admin.backup_storage_created',
        targetType: 'backup_storage',
        targetId: storage.id,
        targetLabel: storage.name,
      });

      return reply.status(201).send(ok({ id: storage.id, name: storage.name }));
    },
  );

  app.patch(
    '/backup-storages/:id',
    {
      preHandler: app.requirePermission(Permission.BACKUP_STORAGE_MANAGE),
      schema: { tags: ['Admin'] },
    },
    async (request) => {
      const { id } = params(request, idParam);
      const input = body(request, updateBackupStorageSchema);

      await app.prisma.$transaction(async (tx) => {
        if (input.isDefault) {
          await tx.backupStorage.updateMany({ where: {}, data: { isDefault: false } });
        }
        await tx.backupStorage.update({
          where: { id },
          data: {
            ...(input.name ? { name: input.name } : {}),
            ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
            ...(input.bucket !== undefined ? { bucket: input.bucket } : {}),
            ...(input.region !== undefined ? { region: input.region } : {}),
            ...(input.endpoint !== undefined ? { endpoint: input.endpoint } : {}),
            ...(input.accessKey ? { accessKeyEnc: app.encrypter.encrypt(input.accessKey) } : {}),
            ...(input.secretKey ? { secretKeyEnc: app.encrypter.encrypt(input.secretKey) } : {}),
            ...(input.pathPrefix ? { pathPrefix: input.pathPrefix } : {}),
            ...(input.forcePathStyle !== undefined ? { forcePathStyle: input.forcePathStyle } : {}),
            ...(input.retentionDays !== undefined ? { retentionDays: input.retentionDays } : {}),
            ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          },
        });
      });

      await app.audit.log(request, {
        action: 'admin.backup_storage_updated',
        targetType: 'backup_storage',
        targetId: id,
      });
      return ok({ updated: true });
    },
  );

  app.delete(
    '/backup-storages/:id',
    {
      preHandler: app.requirePermission(Permission.BACKUP_STORAGE_MANAGE),
      schema: { tags: ['Admin'] },
    },
    async (request) => {
      const { id } = params(request, idParam);
      const storage = await app.prisma.backupStorage.findUnique({
        where: { id },
        include: { _count: { select: { backups: true } } },
      });
      if (!storage) throw notFound('Backup storage was not found');
      if (storage._count.backups > 0) throw conflict('Delete the backups on this storage first');

      await app.prisma.backupStorage.delete({ where: { id } });
      return ok({ deleted: true });
    },
  );

  /* --------------------------------------------------- database hosts -- */

  app.get(
    '/database-hosts',
    {
      preHandler: app.requirePermission(Permission.DATABASE_HOSTS_MANAGE),
      schema: { tags: ['Admin'] },
    },
    async () => {
      const hosts = await app.prisma.databaseHost.findMany({
        include: { node: true, _count: { select: { databases: true } } },
        orderBy: { createdAt: 'asc' },
      });
      return ok(
        hosts.map((host) => ({
          id: host.id,
          name: host.name,
          engine: host.engine,
          host: host.host,
          publicHost: host.publicHost,
          port: host.port,
          username: host.username,
          maxDatabases: host.maxDatabases,
          databaseCount: host._count.databases,
          node: host.node ? { id: host.node.id, name: host.node.name } : null,
          isActive: host.isActive,
          createdAt: host.createdAt.toISOString(),
        })),
      );
    },
  );

  app.post(
    '/database-hosts',
    {
      preHandler: app.requirePermission(Permission.DATABASE_HOSTS_MANAGE),
      schema: { tags: ['Admin'] },
    },
    async (request, reply) => {
      const input = body(request, createDatabaseHostSchema);

      const host = await app.prisma.databaseHost.create({
        data: {
          name: input.name,
          engine: input.engine,
          host: input.host,
          publicHost: input.publicHost ?? null,
          port: input.port,
          username: input.username,
          passwordEnc: app.encrypter.encrypt(input.password),
          maxDatabases: input.maxDatabases,
          nodeId: input.nodeId ?? null,
          isActive: input.isActive,
        },
      });

      // Surface a bad credential immediately rather than at first provision.
      const test = await app.databases.testConnection(host);
      await app.audit.log(request, {
        action: 'admin.database_host_created',
        targetType: 'database_host',
        targetId: host.id,
        targetLabel: host.name,
        metadata: { reachable: test.ok },
      });

      return reply.status(201).send(ok({ id: host.id, name: host.name, connection: test }));
    },
  );

  app.patch(
    '/database-hosts/:id',
    {
      preHandler: app.requirePermission(Permission.DATABASE_HOSTS_MANAGE),
      schema: { tags: ['Admin'] },
    },
    async (request) => {
      const { id } = params(request, idParam);
      const input = body(request, updateDatabaseHostSchema);

      const host = await app.prisma.databaseHost.update({
        where: { id },
        data: {
          ...(input.name ? { name: input.name } : {}),
          ...(input.engine ? { engine: input.engine } : {}),
          ...(input.host ? { host: input.host } : {}),
          ...(input.publicHost !== undefined ? { publicHost: input.publicHost ?? null } : {}),
          ...(input.port ? { port: input.port } : {}),
          ...(input.username ? { username: input.username } : {}),
          ...(input.password ? { passwordEnc: app.encrypter.encrypt(input.password) } : {}),
          ...(input.maxDatabases !== undefined ? { maxDatabases: input.maxDatabases } : {}),
          ...(input.nodeId !== undefined ? { nodeId: input.nodeId ?? null } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        },
      });

      await app.audit.log(request, {
        action: 'admin.database_host_updated',
        targetType: 'database_host',
        targetId: id,
        targetLabel: host.name,
      });
      return ok({ updated: true });
    },
  );

  app.post(
    '/database-hosts/:id/test',
    {
      preHandler: app.requirePermission(Permission.DATABASE_HOSTS_MANAGE),
      schema: { tags: ['Admin'] },
    },
    async (request) => {
      const { id } = params(request, idParam);
      const host = await app.prisma.databaseHost.findUnique({ where: { id } });
      if (!host) throw notFound('Database host was not found');
      return ok(await app.databases.testConnection(host));
    },
  );

  app.delete(
    '/database-hosts/:id',
    {
      preHandler: app.requirePermission(Permission.DATABASE_HOSTS_MANAGE),
      schema: { tags: ['Admin'] },
    },
    async (request) => {
      const { id } = params(request, idParam);
      const host = await app.prisma.databaseHost.findUnique({
        where: { id },
        include: { _count: { select: { databases: true } } },
      });
      if (!host) throw notFound('Database host was not found');
      if (host._count.databases > 0) throw conflict('Delete the databases on this host first');

      await app.prisma.databaseHost.delete({ where: { id } });
      return ok({ deleted: true });
    },
  );

  /* -------------------------------------------------------- webhooks -- */

  app.get(
    '/webhooks',
    { preHandler: app.requirePermission(Permission.WEBHOOKS_MANAGE), schema: { tags: ['Admin'] } },
    async () => {
      const hooks = await app.prisma.webhook.findMany({ orderBy: { createdAt: 'desc' } });
      return ok(
        hooks.map((hook) => ({
          id: hook.id,
          name: hook.name,
          url: hook.url,
          events: hook.events,
          isActive: hook.isActive,
          failureCount: hook.failureCount,
          lastStatus: hook.lastStatus,
          lastDeliveryAt: hook.lastDeliveryAt?.toISOString() ?? null,
          createdAt: hook.createdAt.toISOString(),
        })),
      );
    },
  );

  app.get(
    '/webhooks/events',
    { preHandler: app.requirePermission(Permission.WEBHOOKS_MANAGE), schema: { tags: ['Admin'] } },
    async () => ok(WEBHOOK_EVENTS),
  );

  app.post(
    '/webhooks',
    { preHandler: app.requirePermission(Permission.WEBHOOKS_MANAGE), schema: { tags: ['Admin'] } },
    async (request, reply) => {
      const user = request.currentUser();
      const input = body(request, createWebhookSchema);

      const unknown = input.events.filter((event) => !WEBHOOK_EVENTS.includes(event as never));
      if (unknown.length > 0) throw badRequest(`Unknown events: ${unknown.join(', ')}`);

      const secret = generateToken(32);
      const hook = await app.prisma.webhook.create({
        data: {
          name: input.name,
          url: input.url,
          events: input.events,
          isActive: input.isActive,
          secretEnc: app.encrypter.encrypt(secret),
          createdById: user.id,
        },
      });

      await app.audit.log(request, {
        action: 'admin.webhook_created',
        targetType: 'webhook',
        targetId: hook.id,
        targetLabel: hook.name,
      });

      // The signing secret is shown once so the receiver can verify deliveries.
      return reply.status(201).send(ok({ id: hook.id, name: hook.name, secret }));
    },
  );

  app.patch(
    '/webhooks/:id',
    { preHandler: app.requirePermission(Permission.WEBHOOKS_MANAGE), schema: { tags: ['Admin'] } },
    async (request) => {
      const { id } = params(request, idParam);
      const input = body(request, updateWebhookSchema);

      const hook = await app.prisma.webhook.update({
        where: { id },
        data: {
          ...(input.name ? { name: input.name } : {}),
          ...(input.url ? { url: input.url } : {}),
          ...(input.events ? { events: input.events } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive, failureCount: 0 } : {}),
        },
      });

      await app.audit.log(request, {
        action: 'admin.webhook_updated',
        targetType: 'webhook',
        targetId: id,
        targetLabel: hook.name,
      });
      return ok({ updated: true });
    },
  );

  app.get(
    '/webhooks/:id/deliveries',
    { preHandler: app.requirePermission(Permission.WEBHOOKS_MANAGE), schema: { tags: ['Admin'] } },
    async (request) => {
      const { id } = params(request, idParam);
      const q = query(request, paginationQuerySchema);

      const [items, total] = await Promise.all([
        app.prisma.webhookDelivery.findMany({
          where: { webhookId: id },
          orderBy: { createdAt: 'desc' },
          ...pageArgs(q.page, q.perPage),
        }),
        app.prisma.webhookDelivery.count({ where: { webhookId: id } }),
      ]);

      return paginated(
        items.map((delivery) => ({
          id: delivery.id,
          event: delivery.event,
          status: delivery.status,
          responseCode: delivery.responseCode,
          error: delivery.error,
          attempt: delivery.attempt,
          createdAt: delivery.createdAt.toISOString(),
        })),
        total,
        q.page,
        q.perPage,
      );
    },
  );

  app.delete(
    '/webhooks/:id',
    { preHandler: app.requirePermission(Permission.WEBHOOKS_MANAGE), schema: { tags: ['Admin'] } },
    async (request) => {
      const { id } = params(request, idParam);
      await app.prisma.webhook.delete({ where: { id } }).catch(() => {
        throw notFound('Webhook was not found', ErrorCode.NOT_FOUND);
      });
      await app.audit.log(request, {
        action: 'admin.webhook_deleted',
        targetType: 'webhook',
        targetId: id,
      });
      return ok({ deleted: true });
    },
  );
}
