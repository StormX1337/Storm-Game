import type { FastifyInstance } from 'fastify';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  ErrorCode,
  NotificationType,
} from '@storm/types';
import { generateToken, hashPassword, hashToken } from '@storm/security';
import { COOKIE_NAMES } from '@storm/config';
import { body } from '../lib/validation.js';
import { ok } from '../lib/response.js';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';
import { AuthService } from '../services/auth.service.js';
import { toUserDetail } from '../lib/transformers.js';
import { renderMail } from '../services/mail.service.js';

const VERIFICATION_TTL_HOURS = 24;
const RESET_TTL_MINUTES = 60;

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  /* -------------------------------------------------------- register -- */

  app.post(
    '/register',
    {
      config: { rateLimit: { max: 5, timeWindow: '10 minutes' } },
      schema: {
        tags: ['Authentication'],
        summary: 'Create a new customer account',
        body: {
          type: 'object',
          required: ['email', 'username', 'password'],
          properties: {
            email: { type: 'string', format: 'email' },
            username: { type: 'string' },
            firstName: { type: 'string' },
            lastName: { type: 'string' },
            password: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const input = body(request, registerSchema);
      const settings = await app.settings.read();

      if (!settings.registrationEnabled) {
        throw forbidden('Registration is currently closed');
      }
      // The maintenance guard exempts the whole auth surface so administrators
      // can sign in and existing sessions can refresh. Signing *up* is not part
      // of that: a new account created mid-maintenance could not use the panel
      // anyway, and would be left holding an unverified address.
      if (settings.maintenanceMode) {
        throw new AppError(
          503,
          ErrorCode.MAINTENANCE_MODE,
          settings.maintenanceMessage || 'The panel is undergoing maintenance.',
        );
      }

      const existing = await app.prisma.user.findFirst({
        where: { OR: [{ email: input.email }, { username: input.username }] },
      });
      if (existing) {
        throw new AppError(
          409,
          ErrorCode.ALREADY_EXISTS,
          existing.email === input.email
            ? 'An account with that email address already exists'
            : 'That username is already taken',
        );
      }

      const role = await app.prisma.role.findUniqueOrThrow({ where: { name: 'CUSTOMER' } });
      const user = await app.prisma.user.create({
        data: {
          email: input.email,
          username: input.username,
          firstName: input.firstName ?? null,
          lastName: input.lastName ?? null,
          passwordHash: await hashPassword(input.password),
          roleId: role.id,
          emailVerifiedAt: settings.requireEmailVerification ? null : new Date(),
          serverLimit: settings.defaultServerLimit,
          memoryLimit: settings.defaultMemoryLimit,
          diskLimit: settings.defaultDiskLimit,
          backupLimit: settings.defaultBackupLimit,
          databaseLimit: settings.defaultDatabaseLimit,
          allocationLimit: settings.defaultAllocationLimit,
        },
        include: { role: { include: { permissions: true } } },
      });

      await app.audit.log(
        request,
        {
          action: 'auth.registered',
          targetType: 'user',
          targetId: user.id,
          targetLabel: user.username,
        },
        user.id,
      );

      if (settings.requireEmailVerification) {
        await sendVerificationEmail(app, user.id, user.email, settings.panelUrl);
      }

      const context = AuthService.requestContext(request);
      const tokens = await app.auth.issueSession(user, context);
      app.auth.setAuthCookies(reply, tokens);

      return reply.status(201).send(
        ok({
          user: toUserDetail(user, 0),
          accessToken: tokens.accessToken,
          expiresIn: tokens.expiresIn,
          emailVerificationRequired: settings.requireEmailVerification,
        }),
      );
    },
  );

  /* ----------------------------------------------------------- login -- */

  app.post(
    '/login',
    {
      config: { rateLimit: { max: 15, timeWindow: '5 minutes' } },
      schema: {
        tags: ['Authentication'],
        summary: 'Sign in with a password and optional second factor',
      },
    },
    async (request, reply) => {
      const input = body(request, loginSchema);
      const context = AuthService.requestContext(request);

      const user = await app.auth.authenticate(
        input.identifier,
        input.password,
        input.totp,
        context,
      );

      const tokens = await app.auth.issueSession(user, context, input.rememberMe);
      app.auth.setAuthCookies(reply, tokens, input.rememberMe);

      const isNewDevice = await isUnrecognisedDevice(app, user.id, context.ip);
      await app.prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date(), lastLoginIp: context.ip },
      });

      await app.audit.log(
        request,
        {
          action: 'auth.login',
          targetType: 'user',
          targetId: user.id,
          targetLabel: user.username,
        },
        user.id,
      );

      if (isNewDevice) {
        await app.notifications.push(user.id, {
          type: NotificationType.NEW_LOGIN,
          title: 'New sign-in',
          message: `Your account was accessed from ${context.ip}.`,
          level: 'WARNING',
          link: '/account/security',
        });
      }

      const full = await app.prisma.user.findUniqueOrThrow({
        where: { id: user.id },
        include: { role: { include: { permissions: true } }, twoFactor: true },
      });
      const serverCount = await app.prisma.server.count({ where: { ownerId: user.id } });

      return reply.send(
        ok({
          user: toUserDetail(full, serverCount),
          accessToken: tokens.accessToken,
          expiresIn: tokens.expiresIn,
        }),
      );
    },
  );

  /* --------------------------------------------------------- refresh -- */

  app.post(
    '/refresh',
    {
      schema: {
        tags: ['Authentication'],
        summary: 'Exchange a refresh token for a new access token',
      },
    },
    async (request, reply) => {
      const cookieToken = request.cookies[COOKIE_NAMES.refreshToken];
      const bodyToken = (request.body as { refreshToken?: string } | undefined)?.refreshToken;
      const token = cookieToken ?? bodyToken;
      if (!token) throw unauthorized('No refresh token was supplied');

      const tokens = await app.auth.rotateSession(token, AuthService.requestContext(request));
      app.auth.setAuthCookies(reply, tokens, true);

      return reply.send(ok({ accessToken: tokens.accessToken, expiresIn: tokens.expiresIn }));
    },
  );

  /* ---------------------------------------------------------- logout -- */

  app.post(
    '/logout',
    { schema: { tags: ['Authentication'], summary: 'Sign out of the current session' } },
    async (request, reply) => {
      const token = request.cookies[COOKIE_NAMES.refreshToken];
      if (token) {
        const session = await app.prisma.session.findUnique({
          where: { tokenHash: hashToken(token) },
        });
        if (session) await app.auth.revokeSession(session.id);
      } else if (request.user?.sessionId) {
        await app.auth.revokeSession(request.user.sessionId);
      }

      app.auth.clearAuthCookies(reply);
      return reply.send(ok({ signedOut: true }));
    },
  );

  /* ------------------------------------------------------------- /me -- */

  app.get(
    '/me',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Authentication'],
        summary: 'Current user profile and effective permissions',
      },
    },
    async (request) => {
      const current = request.currentUser();
      const user = await app.prisma.user.findUniqueOrThrow({
        where: { id: current.id },
        include: { role: { include: { permissions: true } }, twoFactor: true },
      });
      const serverCount = await app.prisma.server.count({ where: { ownerId: current.id } });
      return ok({ user: toUserDetail(user, serverCount), permissions: [...current.permissions] });
    },
  );

  /* -------------------------------------------------- password reset -- */

  app.post(
    '/forgot-password',
    {
      config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
      schema: { tags: ['Authentication'] },
    },
    async (request) => {
      const { email } = body(request, forgotPasswordSchema);
      const user = await app.prisma.user.findUnique({ where: { email } });

      // Always report success so the endpoint cannot be used to enumerate accounts.
      if (user && !user.suspendedAt) {
        const token = generateToken(32);
        await app.prisma.verificationToken.create({
          data: {
            userId: user.id,
            type: 'PASSWORD_RESET',
            tokenHash: hashToken(token),
            expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60_000),
          },
        });

        const settings = await app.settings.read();
        const url = `${settings.panelUrl}/reset-password?token=${token}`;
        const mail = renderMail(
          'Reset your password',
          [
            `Hi ${user.username},`,
            `We received a request to reset the password for your ${settings.panelName} account.`,
            `This link expires in ${RESET_TTL_MINUTES} minutes.`,
          ],
          { label: 'Choose a new password', url },
        );
        await app.queues.enqueueMail({ to: user.email, subject: 'Reset your password', ...mail });
        await app.audit.log(
          request,
          { action: 'auth.password_reset_requested', targetType: 'user', targetId: user.id },
          user.id,
        );
      }

      return ok({ sent: true });
    },
  );

  app.post(
    '/reset-password',
    {
      config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
      schema: { tags: ['Authentication'] },
    },
    async (request) => {
      const input = body(request, resetPasswordSchema);
      const record = await app.prisma.verificationToken.findUnique({
        where: { tokenHash: hashToken(input.token) },
        include: { user: true },
      });

      if (
        !record ||
        record.type !== 'PASSWORD_RESET' ||
        record.usedAt ||
        record.expiresAt < new Date()
      ) {
        throw new AppError(
          400,
          ErrorCode.VALIDATION_ERROR,
          'That reset link is invalid or has expired',
        );
      }

      await app.prisma.$transaction([
        app.prisma.user.update({
          where: { id: record.userId },
          data: { passwordHash: await hashPassword(input.password) },
        }),
        app.prisma.verificationToken.update({
          where: { id: record.id },
          data: { usedAt: new Date() },
        }),
        // A password reset invalidates every existing session.
        app.prisma.session.updateMany({
          where: { userId: record.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
      ]);

      await app.notifications.push(record.userId, {
        type: NotificationType.PASSWORD_CHANGED,
        title: 'Password changed',
        message: 'Your password was reset and all sessions were signed out.',
        level: 'WARNING',
      });
      await app.audit.log(
        request,
        { action: 'auth.password_reset', targetType: 'user', targetId: record.userId },
        record.userId,
      );

      return ok({ reset: true });
    },
  );

  app.post(
    '/change-password',
    { preHandler: app.authenticate, schema: { tags: ['Authentication'] } },
    async (request) => {
      const user = request.currentUser();
      const input = body(request, changePasswordSchema);

      await app.auth.assertPassword(user.id, input.currentPassword);
      await app.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await hashPassword(input.newPassword) },
      });

      const revoked = await app.auth.revokeAllSessions(user.id, user.sessionId ?? undefined);
      await app.notifications.push(user.id, {
        type: NotificationType.PASSWORD_CHANGED,
        title: 'Password changed',
        message: `Your password was changed. ${revoked} other session(s) were signed out.`,
        level: 'WARNING',
      });
      await app.audit.log(request, {
        action: 'auth.password_changed',
        targetType: 'user',
        targetId: user.id,
      });

      return ok({ changed: true, sessionsRevoked: revoked });
    },
  );

  /* ---------------------------------------------- email verification -- */

  app.post(
    '/verify-email',
    {
      config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
      schema: { tags: ['Authentication'] },
    },
    async (request) => {
      const { token } = body(request, verifyEmailSchema);
      const record = await app.prisma.verificationToken.findUnique({
        where: { tokenHash: hashToken(token) },
      });

      if (
        !record ||
        record.type !== 'EMAIL_VERIFICATION' ||
        record.usedAt ||
        record.expiresAt < new Date()
      ) {
        throw new AppError(
          400,
          ErrorCode.VALIDATION_ERROR,
          'That verification link is invalid or has expired',
        );
      }

      await app.prisma.$transaction([
        app.prisma.user.update({
          where: { id: record.userId },
          data: { emailVerifiedAt: new Date() },
        }),
        app.prisma.verificationToken.update({
          where: { id: record.id },
          data: { usedAt: new Date() },
        }),
      ]);
      await app.audit.log(
        request,
        { action: 'auth.email_verified', targetType: 'user', targetId: record.userId },
        record.userId,
      );

      return ok({ verified: true });
    },
  );

  app.post(
    '/resend-verification',
    {
      preHandler: app.authenticate,
      config: { rateLimit: { max: 3, timeWindow: '15 minutes' } },
      schema: { tags: ['Authentication'] },
    },
    async (request) => {
      const user = request.currentUser();
      if (user.emailVerified) return ok({ sent: false, alreadyVerified: true });

      const settings = await app.settings.read();
      await sendVerificationEmail(app, user.id, user.email, settings.panelUrl);
      return ok({ sent: true });
    },
  );
}

async function sendVerificationEmail(
  app: FastifyInstance,
  userId: string,
  email: string,
  panelUrl: string,
): Promise<void> {
  const token = generateToken(32);
  await app.prisma.verificationToken.create({
    data: {
      userId,
      type: 'EMAIL_VERIFICATION',
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + VERIFICATION_TTL_HOURS * 3600_000),
    },
  });

  const url = `${panelUrl}/verify-email?token=${token}`;
  const mail = renderMail(
    'Confirm your email address',
    [
      'Thanks for creating a Storm Panel account.',
      `Confirm your address to unlock every feature. This link expires in ${VERIFICATION_TTL_HOURS} hours.`,
    ],
    { label: 'Verify email address', url },
  );
  await app.queues.enqueueMail({ to: email, subject: 'Confirm your email address', ...mail });
}

/** True when this IP has not been seen on a previous session for the user. */
async function isUnrecognisedDevice(
  app: FastifyInstance,
  userId: string,
  ip: string,
): Promise<boolean> {
  const seen = await app.prisma.session.findFirst({
    where: { userId, ip },
    select: { id: true },
  });
  return seen === null;
}
