import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  ErrorCode,
  Permission,
  ROLE_PRIORITY,
  WebhookEvent,
  createUserSchema,
  paginationQuerySchema,
  updateUserSchema,
  type RoleName,
} from '@storm/types';
import { generatePassword, hashPassword } from '@storm/security';
import { body, params, query } from '../../lib/validation.js';
import { ok, paginated, pageArgs } from '../../lib/response.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { assertOutranks } from '../../plugins/auth.js';
import {
  toServerSummary,
  toSessionSummary,
  toUserDetail,
  toUserSummary,
} from '../../lib/transformers.js';

const idParam = z.object({ id: z.string().min(1).max(64) });

export default async function adminUserRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.requirePermission(Permission.USERS_MANAGE));

  app.get('/', { schema: { tags: ['Admin: Users'], summary: 'List users' } }, async (request) => {
    const q = query(
      request,
      paginationQuerySchema.extend({
        role: z.string().max(32).optional(),
        suspended: z.coerce.boolean().optional(),
      }),
    );

    const where = {
      ...(q.role ? { role: { name: q.role as RoleName } } : {}),
      ...(q.suspended === true ? { suspendedAt: { not: null } } : {}),
      ...(q.suspended === false ? { suspendedAt: null } : {}),
      ...(q.search
        ? {
            OR: [
              { email: { contains: q.search, mode: 'insensitive' as const } },
              { username: { contains: q.search, mode: 'insensitive' as const } },
              { firstName: { contains: q.search, mode: 'insensitive' as const } },
              { lastName: { contains: q.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [users, total] = await Promise.all([
      app.prisma.user.findMany({
        where,
        include: { role: true, twoFactor: true, _count: { select: { servers: true } } },
        orderBy: { createdAt: 'desc' },
        ...pageArgs(q.page, q.perPage),
      }),
      app.prisma.user.count({ where }),
    ]);

    return paginated(
      users.map((user) => ({ ...toUserSummary(user), serverCount: user._count.servers })),
      total,
      q.page,
      q.perPage,
    );
  });

  app.post(
    '/',
    { schema: { tags: ['Admin: Users'], summary: 'Create a user' } },
    async (request, reply) => {
      const actor = request.currentUser();
      const input = body(request, createUserSchema);

      assertOutranks(actor, input.role);

      const existing = await app.prisma.user.findFirst({
        where: { OR: [{ email: input.email }, { username: input.username }] },
      });
      if (existing)
        throw conflict(
          'A user with that email or username already exists',
          ErrorCode.ALREADY_EXISTS,
        );

      const role = await app.prisma.role.findUnique({ where: { name: input.role } });
      if (!role) throw badRequest('That role does not exist');

      const password = input.password ?? generatePassword(20);
      const user = await app.prisma.user.create({
        data: {
          email: input.email,
          username: input.username,
          firstName: input.firstName ?? null,
          lastName: input.lastName ?? null,
          passwordHash: await hashPassword(password),
          roleId: role.id,
          emailVerifiedAt: input.emailVerified ? new Date() : null,
          extraPermissions: input.extraPermissions,
          deniedPermissions: input.deniedPermissions,
          ...(input.limits ?? {}),
        },
        include: { role: { include: { permissions: true } }, twoFactor: true },
      });

      await app.audit.log(request, {
        action: 'admin.user_created',
        targetType: 'user',
        targetId: user.id,
        targetLabel: user.username,
        metadata: { role: input.role },
      });
      await app.webhooks.dispatch(WebhookEvent.USER_CREATED, {
        userId: user.id,
        username: user.username,
      });

      return reply.status(201).send(
        ok({
          user: toUserDetail(user, 0),
          // Returned once so the operator can hand it over; never stored plaintext.
          generatedPassword: input.password ? undefined : password,
        }),
      );
    },
  );

  app.get('/:id', { schema: { tags: ['Admin: Users'] } }, async (request) => {
    const { id } = params(request, idParam);
    const user = await app.prisma.user.findUnique({
      where: { id },
      include: { role: { include: { permissions: true } }, twoFactor: true },
    });
    if (!user) throw notFound('User was not found', ErrorCode.USER_NOT_FOUND);

    const [serverCount, servers, sessions] = await Promise.all([
      app.prisma.server.count({ where: { ownerId: id } }),
      app.prisma.server.findMany({
        where: { ownerId: id },
        include: { node: true, allocations: true, template: true, owner: true },
        take: 25,
        orderBy: { createdAt: 'desc' },
      }),
      app.prisma.session.findMany({
        where: { userId: id, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { lastUsedAt: 'desc' },
        take: 25,
      }),
    ]);

    return ok({
      user: toUserDetail(user, serverCount),
      servers: servers.map(toServerSummary),
      sessions: sessions.map((session) => toSessionSummary(session, null)),
    });
  });

  app.patch('/:id', { schema: { tags: ['Admin: Users'] } }, async (request) => {
    const actor = request.currentUser();
    const { id } = params(request, idParam);
    const input = body(request, updateUserSchema);

    const target = await app.prisma.user.findUnique({ where: { id }, include: { role: true } });
    if (!target) throw notFound('User was not found', ErrorCode.USER_NOT_FOUND);

    assertOutranks(actor, target.role.name as RoleName);
    if (input.role) assertOutranks(actor, input.role);

    if (input.email || input.username) {
      const clash = await app.prisma.user.findFirst({
        where: {
          id: { not: id },
          OR: [
            ...(input.email ? [{ email: input.email }] : []),
            ...(input.username ? [{ username: input.username }] : []),
          ],
        },
      });
      if (clash) throw conflict('Another user already uses that email or username');
    }

    const role = input.role
      ? await app.prisma.role.findUnique({ where: { name: input.role } })
      : null;

    const user = await app.prisma.user.update({
      where: { id },
      data: {
        ...(input.email ? { email: input.email } : {}),
        ...(input.username ? { username: input.username } : {}),
        ...(input.firstName !== undefined ? { firstName: input.firstName ?? null } : {}),
        ...(input.lastName !== undefined ? { lastName: input.lastName ?? null } : {}),
        ...(role ? { roleId: role.id } : {}),
        ...(input.emailVerified !== undefined
          ? { emailVerifiedAt: input.emailVerified ? new Date() : null }
          : {}),
        ...(input.extraPermissions ? { extraPermissions: input.extraPermissions } : {}),
        ...(input.deniedPermissions ? { deniedPermissions: input.deniedPermissions } : {}),
        ...(input.password ? { passwordHash: await hashPassword(input.password) } : {}),
        ...(input.limits ?? {}),
      },
      include: { role: { include: { permissions: true } }, twoFactor: true },
    });

    // Changing a password or role must not leave stale sessions authorised.
    if (input.password || input.role) {
      await app.auth.revokeAllSessions(id);
    }

    await app.audit.log(request, {
      action: 'admin.user_updated',
      targetType: 'user',
      targetId: id,
      targetLabel: user.username,
      metadata: { fields: Object.keys(input) },
    });

    return ok(toUserDetail(user, 0));
  });

  app.post('/:id/suspend', { schema: { tags: ['Admin: Users'] } }, async (request) => {
    const actor = request.currentUser();
    const { id } = params(request, idParam);
    const input = body(request, z.object({ reason: z.string().max(500).optional() }).partial());

    const target = await app.prisma.user.findUnique({ where: { id }, include: { role: true } });
    if (!target) throw notFound('User was not found', ErrorCode.USER_NOT_FOUND);
    if (target.id === actor.id) throw badRequest('You cannot suspend your own account');
    assertOutranks(actor, target.role.name as RoleName);

    await app.prisma.user.update({ where: { id }, data: { suspendedAt: new Date() } });
    await app.auth.revokeAllSessions(id);

    await app.audit.log(request, {
      action: 'admin.user_suspended',
      targetType: 'user',
      targetId: id,
      targetLabel: target.username,
      metadata: { reason: input.reason ?? null },
    });

    return ok({ suspended: true });
  });

  app.post('/:id/unsuspend', { schema: { tags: ['Admin: Users'] } }, async (request) => {
    const actor = request.currentUser();
    const { id } = params(request, idParam);

    const target = await app.prisma.user.findUnique({ where: { id }, include: { role: true } });
    if (!target) throw notFound('User was not found', ErrorCode.USER_NOT_FOUND);
    assertOutranks(actor, target.role.name as RoleName);

    await app.prisma.user.update({ where: { id }, data: { suspendedAt: null } });
    await app.audit.log(request, {
      action: 'admin.user_unsuspended',
      targetType: 'user',
      targetId: id,
      targetLabel: target.username,
    });

    return ok({ suspended: false });
  });

  app.post('/:id/reset-password', { schema: { tags: ['Admin: Users'] } }, async (request) => {
    const actor = request.currentUser();
    const { id } = params(request, idParam);

    const target = await app.prisma.user.findUnique({ where: { id }, include: { role: true } });
    if (!target) throw notFound('User was not found', ErrorCode.USER_NOT_FOUND);
    assertOutranks(actor, target.role.name as RoleName);

    const password = generatePassword(20);
    await app.prisma.user.update({
      where: { id },
      data: { passwordHash: await hashPassword(password) },
    });
    await app.auth.revokeAllSessions(id);

    await app.audit.log(request, {
      action: 'admin.user_password_reset',
      targetType: 'user',
      targetId: id,
      targetLabel: target.username,
    });

    return ok({ password });
  });

  app.post(
    '/:id/disable-2fa',
    { schema: { tags: ['Admin: Users'], summary: 'Remove two-factor from a locked-out account' } },
    async (request) => {
      const actor = request.currentUser();
      const { id } = params(request, idParam);

      const target = await app.prisma.user.findUnique({ where: { id }, include: { role: true } });
      if (!target) throw notFound('User was not found', ErrorCode.USER_NOT_FOUND);
      assertOutranks(actor, target.role.name as RoleName);

      await app.auth.disableTwoFactor(id);
      await app.audit.log(request, {
        action: 'admin.user_2fa_disabled',
        targetType: 'user',
        targetId: id,
        targetLabel: target.username,
      });

      return ok({ disabled: true });
    },
  );

  app.delete('/:id', { schema: { tags: ['Admin: Users'] } }, async (request) => {
    const actor = request.currentUser();
    const { id } = params(request, idParam);

    const target = await app.prisma.user.findUnique({
      where: { id },
      include: { role: true, _count: { select: { servers: true } } },
    });
    if (!target) throw notFound('User was not found', ErrorCode.USER_NOT_FOUND);
    if (target.id === actor.id) throw badRequest('You cannot delete your own account');
    assertOutranks(actor, target.role.name as RoleName);

    if (target._count.servers > 0) {
      throw new AppError(
        409,
        ErrorCode.CONFLICT,
        'Transfer or delete this user’s servers before deleting the account',
      );
    }
    if (target.role.name === 'OWNER') {
      const owners = await app.prisma.user.count({ where: { role: { name: 'OWNER' } } });
      if (owners <= 1) throw forbidden('The last owner account cannot be deleted');
    }

    await app.prisma.user.delete({ where: { id } });
    await app.audit.log(request, {
      action: 'admin.user_deleted',
      targetType: 'user',
      targetId: id,
      targetLabel: target.username,
    });
    await app.webhooks.dispatch(WebhookEvent.USER_DELETED, {
      userId: id,
      username: target.username,
    });

    return ok({ deleted: true });
  });

  app.get(
    '/meta/roles',
    { schema: { tags: ['Admin: Users'], summary: 'Roles and their permissions' } },
    async () => {
      const roles = await app.prisma.role.findMany({
        include: { permissions: true, _count: { select: { users: true } } },
        orderBy: { priority: 'desc' },
      });
      return ok(
        roles.map((role) => ({
          id: role.id,
          name: role.name,
          displayName: role.displayName,
          description: role.description,
          priority: ROLE_PRIORITY[role.name as RoleName] ?? role.priority,
          userCount: role._count.users,
          permissions: role.permissions.map((permission) => permission.key),
        })),
      );
    },
  );

  app.get('/meta/permissions', { schema: { tags: ['Admin: Users'] } }, async () => {
    const permissions = await app.prisma.permission.findMany({
      orderBy: [{ category: 'asc' }, { key: 'asc' }],
    });
    return ok(
      permissions.map((permission) => ({
        key: permission.key,
        category: permission.category,
        description: permission.description,
      })),
    );
  });
}
