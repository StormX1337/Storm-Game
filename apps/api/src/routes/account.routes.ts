import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  disableTwoFactorSchema,
  enableTwoFactorSchema,
  emailSchema,
  paginationQuerySchema,
  permissionEnum,
  NotificationType,
  PERMISSION_DEFINITIONS,
} from '@storm/types';
import { buildTotpUri, generateToken, generateTotpSecret, hashToken } from '@storm/security';
import { body, params, query } from '../lib/validation.js';
import { ok, paginated, pageArgs } from '../lib/response.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { toNotification, toSessionSummary, toUserDetail } from '../lib/transformers.js';

const updateProfileSchema = z.object({
  firstName: z.string().trim().max(64).nullable().optional(),
  lastName: z.string().trim().max(64).nullable().optional(),
  email: emailSchema.optional(),
  avatarUrl: z.string().url().max(500).nullable().optional(),
});

const createApiKeySchema = z.object({
  name: z.string().trim().min(1).max(100),
  /**
   * What the key may do. Empty means everything its owner may do, which is
   * why the panel makes that a choice rather than the shape of an untouched
   * form: a key with no boxes ticked is the most powerful one there is.
   *
   * Validated against the real catalogue rather than accepted as free text —
   * a typo used to be dropped silently, leaving a key narrower than the person
   * who made it believed, which is the failure you find out about at 3am.
   */
  permissions: z.array(permissionEnum).max(200).default([]),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});

export default async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  /* --------------------------------------------------------- profile -- */

  app.get(
    '/',
    { schema: { tags: ['Account'], summary: 'Get the current profile' } },
    async (request) => {
      const current = request.currentUser();
      const user = await app.prisma.user.findUniqueOrThrow({
        where: { id: current.id },
        include: { role: { include: { permissions: true } }, twoFactor: true },
      });
      const serverCount = await app.prisma.server.count({ where: { ownerId: current.id } });
      return ok(toUserDetail(user, serverCount));
    },
  );

  app.patch(
    '/',
    { schema: { tags: ['Account'], summary: 'Update the current profile' } },
    async (request) => {
      const current = request.currentUser();
      const input = body(request, updateProfileSchema);

      if (input.email && input.email !== current.email) {
        const taken = await app.prisma.user.findUnique({ where: { email: input.email } });
        if (taken) throw badRequest('That email address is already in use');
      }

      const settings = await app.settings.read();
      const emailChanged = Boolean(input.email && input.email !== current.email);

      const user = await app.prisma.user.update({
        where: { id: current.id },
        data: {
          ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
          ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
          ...(input.avatarUrl !== undefined ? { avatarUrl: input.avatarUrl } : {}),
          ...(input.email ? { email: input.email } : {}),
          // Changing the address always re-opens verification.
          ...(emailChanged && settings.requireEmailVerification ? { emailVerifiedAt: null } : {}),
        },
        include: { role: { include: { permissions: true } }, twoFactor: true },
      });

      await app.audit.log(request, {
        action: 'account.updated',
        targetType: 'user',
        targetId: current.id,
      });
      return ok(toUserDetail(user, 0));
    },
  );

  /* -------------------------------------------------------- sessions -- */

  app.get(
    '/sessions',
    { schema: { tags: ['Account'], summary: 'List active sessions' } },
    async (request) => {
      const current = request.currentUser();
      const sessions = await app.prisma.session.findMany({
        where: { userId: current.id, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { lastUsedAt: 'desc' },
      });
      return ok(sessions.map((session) => toSessionSummary(session, current.sessionId)));
    },
  );

  app.delete('/sessions/:id', { schema: { tags: ['Account'] } }, async (request) => {
    const current = request.currentUser();
    const { id } = params(request, z.object({ id: z.string().min(1) }));

    const session = await app.prisma.session.findUnique({ where: { id } });
    if (!session || session.userId !== current.id) throw notFound('Session was not found');

    await app.auth.revokeSession(id);
    await app.audit.log(request, {
      action: 'account.session_revoked',
      targetType: 'session',
      targetId: id,
    });
    return ok({ revoked: true });
  });

  app.delete(
    '/sessions',
    { schema: { tags: ['Account'], summary: 'Sign out everywhere else' } },
    async (request) => {
      const current = request.currentUser();
      const count = await app.auth.revokeAllSessions(current.id, current.sessionId ?? undefined);
      await app.audit.log(request, { action: 'account.sessions_revoked', metadata: { count } });
      return ok({ revoked: count });
    },
  );

  /* ------------------------------------------------------------- 2FA -- */

  app.post(
    '/2fa/setup',
    { schema: { tags: ['Account'], summary: 'Begin TOTP enrolment' } },
    async (request) => {
      const current = request.currentUser();
      const existing = await app.prisma.twoFactorAuth.findUnique({ where: { userId: current.id } });
      if (existing?.enabled) throw badRequest('Two-factor authentication is already enabled');

      const settings = await app.settings.read();
      const secret = generateTotpSecret();
      await app.auth.beginTwoFactorEnrolment(current.id, secret);

      return ok({
        secret,
        otpauthUrl: buildTotpUri(secret, current.email, settings.panelName),
      });
    },
  );

  app.post(
    '/2fa/enable',
    { schema: { tags: ['Account'], summary: 'Confirm and enable TOTP' } },
    async (request) => {
      const current = request.currentUser();
      const input = body(request, enableTwoFactorSchema);

      await app.auth.assertPassword(current.id, input.password);

      const record = await app.prisma.twoFactorAuth.findUnique({ where: { userId: current.id } });
      if (!record)
        throw badRequest('Start the setup flow before enabling two-factor authentication');
      if (record.enabled) throw badRequest('Two-factor authentication is already enabled');

      const secret = app.encrypter.tryDecrypt(record.secretEnc);
      const enrolment = secret
        ? await app.auth.acceptEnrolmentCode(current.id, secret, input.code)
        : 'rejected';
      if (enrolment === 'reused') {
        throw badRequest('That code has already been used. Wait for the next one.');
      }
      if (enrolment !== 'accepted') {
        throw badRequest('That code is not valid. Check your device clock and try again.');
      }

      const backupCodes = await app.auth.completeTwoFactorEnrolment(current.id);
      await app.notifications.push(current.id, {
        type: NotificationType.SECURITY_EVENT,
        title: 'Two-factor authentication enabled',
        message: 'Your account is now protected with an authenticator app.',
        level: 'SUCCESS',
      });
      await app.audit.log(request, {
        action: 'account.2fa_enabled',
        targetType: 'user',
        targetId: current.id,
      });

      // Backup codes are shown exactly once — only their hashes are stored.
      return ok({ enabled: true, backupCodes });
    },
  );

  app.post('/2fa/disable', { schema: { tags: ['Account'] } }, async (request) => {
    const current = request.currentUser();
    const input = body(request, disableTwoFactorSchema);

    await app.auth.assertPassword(current.id, input.password);
    const accepted = await app.auth.verifySecondFactor(current.id, input.code);
    if (accepted === 'reused') {
      throw badRequest('That code has already been used. Wait for the next one.');
    }
    if (accepted !== 'accepted') throw badRequest('That two-factor code is not valid');

    await app.auth.disableTwoFactor(current.id);
    await app.notifications.push(current.id, {
      type: NotificationType.SECURITY_EVENT,
      title: 'Two-factor authentication disabled',
      message: 'Two-factor authentication was turned off for your account.',
      level: 'WARNING',
    });
    await app.audit.log(request, {
      action: 'account.2fa_disabled',
      targetType: 'user',
      targetId: current.id,
    });

    return ok({ enabled: false });
  });

  app.post(
    '/2fa/backup-codes',
    { schema: { tags: ['Account'], summary: 'Regenerate backup codes' } },
    async (request) => {
      const current = request.currentUser();
      const input = body(request, z.object({ password: z.string().min(1).max(256) }));
      await app.auth.assertPassword(current.id, input.password);

      const record = await app.prisma.twoFactorAuth.findUnique({ where: { userId: current.id } });
      if (!record?.enabled) throw badRequest('Two-factor authentication is not enabled');

      const backupCodes = await app.auth.completeTwoFactorEnrolment(current.id);
      await app.audit.log(request, { action: 'account.2fa_backup_codes_regenerated' });
      return ok({ backupCodes });
    },
  );

  /* -------------------------------------------------------- api keys -- */

  app.get(
    '/permissions',
    { schema: { tags: ['Account'], summary: 'What this account may do' } },
    async (request) => {
      const current = request.currentUser();
      // Only what the caller holds. A key can never exceed its owner, so
      // offering them the whole catalogue would be offering them a list of
      // things that get silently dropped.
      return ok(
        PERMISSION_DEFINITIONS.filter((definition) => current.permissions.has(definition.key)),
      );
    },
  );

  app.get('/api-keys', { schema: { tags: ['Account'] } }, async (request) => {
    const current = request.currentUser();
    const keys = await app.prisma.apiKey.findMany({
      where: { userId: current.id, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return ok(
      keys.map((key) => ({
        id: key.id,
        name: key.name,
        keyId: key.keyId,
        permissions: key.permissions,
        lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
        expiresAt: key.expiresAt?.toISOString() ?? null,
        createdAt: key.createdAt.toISOString(),
      })),
    );
  });

  app.post(
    '/api-keys',
    { schema: { tags: ['Account'], summary: 'Create a personal API key' } },
    async (request) => {
      const current = request.currentUser();
      const input = body(request, createApiKeySchema);

      // A key can never grant more than the user already holds.
      const permissions = input.permissions.filter((permission) =>
        current.permissions.has(permission),
      );
      if (input.permissions.length > 0 && permissions.length === 0) {
        throw forbidden('None of those permissions are available on your account');
      }

      const keyId = generateToken(8).slice(0, 12);
      const secret = generateToken(32);
      const expiresAt = input.expiresInDays
        ? new Date(Date.now() + input.expiresInDays * 86400_000)
        : null;

      await app.prisma.apiKey.create({
        data: {
          userId: current.id,
          name: input.name,
          keyId,
          keyHash: hashToken(secret),
          permissions,
          expiresAt,
        },
      });

      await app.audit.log(request, {
        action: 'account.api_key_created',
        targetType: 'api_key',
        targetLabel: input.name,
      });
      // The full token is returned once and never stored in plaintext.
      return ok({
        token: `storm_${keyId}.${secret}`,
        keyId,
        name: input.name,
        permissions,
        expiresAt: expiresAt?.toISOString() ?? null,
      });
    },
  );

  app.delete('/api-keys/:id', { schema: { tags: ['Account'] } }, async (request) => {
    const current = request.currentUser();
    const { id } = params(request, z.object({ id: z.string().min(1) }));

    const key = await app.prisma.apiKey.findUnique({ where: { id } });
    if (!key || key.userId !== current.id) throw notFound('API key was not found');

    await app.prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
    await app.audit.log(request, {
      action: 'account.api_key_revoked',
      targetType: 'api_key',
      targetId: id,
    });
    return ok({ revoked: true });
  });

  /* --------------------------------------------------- notifications -- */

  app.get('/notifications', { schema: { tags: ['Account'] } }, async (request) => {
    const current = request.currentUser();
    const q = query(
      request,
      paginationQuerySchema.extend({ unreadOnly: z.coerce.boolean().default(false) }),
    );

    const where = { userId: current.id, ...(q.unreadOnly ? { readAt: null } : {}) };
    const [items, total, unread] = await Promise.all([
      app.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...pageArgs(q.page, q.perPage),
      }),
      app.prisma.notification.count({ where }),
      app.prisma.notification.count({ where: { userId: current.id, readAt: null } }),
    ]);

    // Pagination metadata is nested inside `data` so a single typed payload
    // carries the list, the unread badge count and the page info together.
    return ok({
      items: items.map(toNotification),
      unread,
      total,
      page: q.page,
      perPage: q.perPage,
      totalPages: Math.max(1, Math.ceil(total / q.perPage)),
    });
  });

  app.post('/notifications/read', { schema: { tags: ['Account'] } }, async (request) => {
    const current = request.currentUser();
    const input = body(request, z.object({ ids: z.array(z.string().min(1)).max(200).optional() }));

    const result = await app.prisma.notification.updateMany({
      where: {
        userId: current.id,
        readAt: null,
        ...(input.ids ? { id: { in: input.ids } } : {}),
      },
      data: { readAt: new Date() },
    });
    return ok({ marked: result.count });
  });

  app.delete('/notifications/:id', { schema: { tags: ['Account'] } }, async (request) => {
    const current = request.currentUser();
    const { id } = params(request, z.object({ id: z.string().min(1) }));
    await app.prisma.notification.deleteMany({ where: { id, userId: current.id } });
    return ok({ deleted: true });
  });

  /* -------------------------------------------------------- activity -- */

  app.get(
    '/activity',
    { schema: { tags: ['Account'], summary: 'Recent account activity' } },
    async (request) => {
      const current = request.currentUser();
      const q = query(request, paginationQuerySchema);

      const [items, total] = await Promise.all([
        app.prisma.auditLog.findMany({
          where: { actorId: current.id },
          orderBy: { createdAt: 'desc' },
          ...pageArgs(q.page, q.perPage),
        }),
        app.prisma.auditLog.count({ where: { actorId: current.id } }),
      ]);

      return paginated(
        items.map((log) => ({
          id: log.id,
          action: log.action,
          ip: log.ip,
          targetType: log.targetType,
          targetLabel: log.targetLabel,
          createdAt: log.createdAt.toISOString(),
        })),
        total,
        q.page,
        q.perPage,
      );
    },
  );
}
