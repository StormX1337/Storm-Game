import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { ErrorCode, Permission, createServerDatabaseSchema, type ServerDatabaseView } from '@storm/types';
import { generatePassword } from '@storm/security';
import { body, params } from '../lib/validation.js';
import { ok } from '../lib/response.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { ServerAccessService } from '../services/server-access.service.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const dbParam = idParam.extend({ databaseId: z.string().min(1).max(64) });

export default async function serverDatabaseRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  /**
   * Databases are always scoped to the server they belong to, and the server is
   * resolved through ServerAccessService first — a customer can never read a
   * row belonging to another tenant even by guessing its id.
   */
  app.get('/:id/databases', { schema: { tags: ['Databases'] } }, async (request) => {
    const user = request.currentUser();
    const { id } = params(request, idParam);
    const access = await app.serverAccess.require(user, id, Permission.SERVERS_DATABASES);

    const databases = await app.prisma.serverDatabase.findMany({
      where: { serverId: access.server.id },
      include: { host: true },
      orderBy: { createdAt: 'asc' },
    });

    return ok(databases.map((database) => this_view(app, database, false)));
  });

  app.post('/:id/databases', { schema: { tags: ['Databases'], summary: 'Create a database' } }, async (request, reply) => {
    const user = request.currentUser();
    const { id } = params(request, idParam);
    const input = body(request, createServerDatabaseSchema);
    const access = await app.serverAccess.require(user, id, Permission.SERVERS_DATABASES_CREATE);
    ServerAccessService.assertNotSuspended(access);

    const owner = await app.prisma.user.findUniqueOrThrow({ where: { id: access.server.ownerId } });
    const existing = await app.prisma.serverDatabase.count({ where: { serverId: access.server.id } });
    if (owner.databaseLimit > 0 && existing >= owner.databaseLimit) {
      throw new AppError(
        409,
        ErrorCode.RESOURCE_LIMIT_REACHED,
        `This server may have at most ${owner.databaseLimit} databases`,
      );
    }

    const host = input.hostId
      ? await app.prisma.databaseHost.findFirst({ where: { id: input.hostId, isActive: true } })
      : await app.prisma.databaseHost.findFirst({
          where: {
            isActive: true,
            OR: [{ nodeId: access.server.nodeId }, { nodeId: null }],
          },
          orderBy: { nodeId: 'desc' },
        });
    if (!host) throw badRequest('No database host is available for this server');

    if (host.maxDatabases > 0) {
      const used = await app.prisma.serverDatabase.count({ where: { hostId: host.id } });
      if (used >= host.maxDatabases) throw badRequest('That database host has reached its capacity');
    }

    // Prefixing with the server short id keeps names unique and traceable.
    const prefix = `s${access.server.shortId.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    const databaseName = `${prefix}_${input.name.toLowerCase()}`.slice(0, 62);
    const username = `${prefix}_${input.name.toLowerCase()}`.slice(0, 30);
    const password = generatePassword(28);

    const duplicate = await app.prisma.serverDatabase.findFirst({ where: { databaseName } });
    if (duplicate) throw badRequest('A database with that name already exists for this server');

    await app.databases.provision(host, databaseName, username, password, input.remoteAccess);

    let record;
    try {
      record = await app.prisma.serverDatabase.create({
        data: {
          serverId: access.server.id,
          hostId: host.id,
          databaseName,
          username,
          passwordEnc: app.encrypter.encrypt(password),
          remoteAccess: input.remoteAccess,
        },
        include: { host: true },
      });
    } catch (error) {
      // Never leave an orphaned database behind if the row cannot be written.
      await app.databases.destroy(host, databaseName, username, input.remoteAccess).catch(() => undefined);
      throw error;
    }

    await app.audit.activity(request, {
      serverId: access.server.id,
      event: 'database:created',
      metadata: { databaseName },
    });

    return reply.status(201).send(ok({ ...this_view(app, record, true), password }));
  });

  app.post('/:id/databases/:databaseId/rotate', { schema: { tags: ['Databases'], summary: 'Reset the password' } }, async (request) => {
    const user = request.currentUser();
    const { id, databaseId } = params(request, dbParam);
    const access = await app.serverAccess.require(user, id, Permission.SERVERS_DATABASES_CREATE);

    const record = await app.prisma.serverDatabase.findFirst({
      where: { id: databaseId, serverId: access.server.id },
      include: { host: true },
    });
    if (!record) throw notFound('Database was not found');

    const password = generatePassword(28);
    await app.databases.resetPassword(record.host, record.username, password, record.remoteAccess);
    await app.prisma.serverDatabase.update({
      where: { id: databaseId },
      data: { passwordEnc: app.encrypter.encrypt(password) },
    });

    await app.audit.activity(request, {
      serverId: access.server.id,
      event: 'database:password_reset',
      metadata: { databaseName: record.databaseName },
    });

    return ok({ ...this_view(app, record, false), password });
  });

  app.get('/:id/databases/:databaseId/credentials', { schema: { tags: ['Databases'] } }, async (request) => {
    const user = request.currentUser();
    const { id, databaseId } = params(request, dbParam);
    const access = await app.serverAccess.require(user, id, Permission.SERVERS_DATABASES);

    const record = await app.prisma.serverDatabase.findFirst({
      where: { id: databaseId, serverId: access.server.id },
      include: { host: true },
    });
    if (!record) throw notFound('Database was not found');

    await app.audit.activity(request, {
      serverId: access.server.id,
      event: 'database:credentials_viewed',
      metadata: { databaseName: record.databaseName },
    });

    return ok(this_view(app, record, true));
  });

  app.delete('/:id/databases/:databaseId', { schema: { tags: ['Databases'] } }, async (request) => {
    const user = request.currentUser();
    const { id, databaseId } = params(request, dbParam);
    const access = await app.serverAccess.require(user, id, Permission.SERVERS_DATABASES_DELETE);

    const record = await app.prisma.serverDatabase.findFirst({
      where: { id: databaseId, serverId: access.server.id },
      include: { host: true },
    });
    if (!record) throw notFound('Database was not found');

    await app.databases.destroy(record.host, record.databaseName, record.username, record.remoteAccess);
    await app.prisma.serverDatabase.delete({ where: { id: databaseId } });

    await app.audit.activity(request, {
      serverId: access.server.id,
      event: 'database:deleted',
      metadata: { databaseName: record.databaseName },
    });

    return ok({ deleted: true });
  });
}

/** Builds the customer-facing view, optionally including the password. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma include shape
function this_view(app: FastifyInstance, record: any, withSecret: boolean): ServerDatabaseView {
  const host = record.host.publicHost ?? record.host.host;
  const password = withSecret ? app.encrypter.tryDecrypt(record.passwordEnc) : null;
  const scheme = record.host.engine === 'POSTGRES' ? 'postgresql' : 'mysql';

  return {
    id: record.id,
    name: record.databaseName,
    username: record.username,
    engine: record.host.engine,
    host,
    port: record.host.port,
    remoteAccess: record.remoteAccess,
    connectionString: password
      ? `${scheme}://${record.username}:${encodeURIComponent(password)}@${host}:${record.host.port}/${record.databaseName}`
      : `${scheme}://${record.username}@${host}:${record.host.port}/${record.databaseName}`,
    ...(withSecret && password ? { password } : {}),
    createdAt: record.createdAt.toISOString(),
  };
}
