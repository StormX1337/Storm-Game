import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Prisma, User } from '@storm/database';
import {
  generateBackupCodes,
  generateToken,
  hashPassword,
  hashToken,
  needsRehash,
  verifyPassword,
  verifyTotp,
} from '@storm/security';
import { COOKIE_NAMES } from '@storm/config';
import { ErrorCode, NotificationType, type RoleName } from '@storm/types';
import { signJwt, parseTtl } from '../lib/jwt.js';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface LoginContext {
  ip: string;
  userAgent: string | null;
}

const JWT_ISSUER = 'storm-panel';

export class AuthService {
  constructor(private readonly app: FastifyInstance) {}

  private get prisma() {
    return this.app.prisma;
  }

  /* ------------------------------------------------------ brute force -- */

  private attemptKey(identifier: string, ip: string): string {
    return `storm:login:${identifier.toLowerCase()}:${ip}`;
  }

  /**
   * Login throttling is keyed on identifier+IP and stored in Redis so it holds
   * across API replicas. Lockout is exponential up to 15 minutes.
   */
  async assertNotLockedOut(identifier: string, ip: string): Promise<void> {
    const raw = await this.app.redis.get(this.attemptKey(identifier, ip));
    const attempts = raw ? Number(raw) : 0;
    if (attempts >= this.app.env.LOGIN_RATE_LIMIT_MAX) {
      const ttl = await this.app.redis.ttl(this.attemptKey(identifier, ip));
      throw new AppError(
        429,
        ErrorCode.RATE_LIMITED,
        `Too many failed sign-in attempts. Try again in ${Math.max(ttl, 1)} seconds.`,
      );
    }
  }

  async recordFailedLogin(identifier: string, ip: string): Promise<void> {
    const key = this.attemptKey(identifier, ip);
    const attempts = await this.app.redis.incr(key);
    // 30s, 60s, 120s ... capped at 15 minutes.
    const ttl = Math.min(30 * 2 ** Math.max(0, attempts - 1), 900);
    await this.app.redis.expire(key, ttl);
  }

  async clearLoginAttempts(identifier: string, ip: string): Promise<void> {
    await this.app.redis.del(this.attemptKey(identifier, ip));
  }

  /* ------------------------------------------------------------ login -- */

  async authenticate(
    identifier: string,
    password: string,
    totp: string | undefined,
    context: LoginContext,
  ): Promise<User> {
    await this.assertNotLockedOut(identifier, context.ip);

    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: identifier.toLowerCase() }, { username: identifier }],
      },
      include: { twoFactor: true, role: true },
    });

    if (!user) {
      // Burn comparable time so a missing account is not distinguishable.
      await verifyPassword(
        '$argon2id$v=19$m=19456,t=2,p=1$c3RvcmA$AAAAAAAAAAAAAAAAAAAAAA',
        password,
      );
      await this.recordFailedLogin(identifier, context.ip);
      throw unauthorized(
        'Those credentials do not match our records',
        ErrorCode.INVALID_CREDENTIALS,
      );
    }

    const valid = await verifyPassword(user.passwordHash, password);
    if (!valid) {
      await this.recordFailedLogin(identifier, context.ip);
      throw unauthorized(
        'Those credentials do not match our records',
        ErrorCode.INVALID_CREDENTIALS,
      );
    }

    if (user.suspendedAt) {
      throw new AppError(403, ErrorCode.ACCOUNT_SUSPENDED, 'This account has been suspended');
    }

    if (user.twoFactor?.enabled) {
      if (!totp) {
        throw new AppError(401, ErrorCode.TWO_FACTOR_REQUIRED, 'A two-factor code is required');
      }
      const accepted = await this.verifySecondFactor(user.id, totp);
      if (!accepted) {
        await this.recordFailedLogin(identifier, context.ip);
        throw new AppError(401, ErrorCode.TWO_FACTOR_INVALID, 'That two-factor code is not valid');
      }
    }

    // Transparent parameter upgrade when the hashing cost has been raised.
    if (needsRehash(user.passwordHash)) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await hashPassword(password) },
      });
    }

    await this.clearLoginAttempts(identifier, context.ip);
    return user;
  }

  /** Accepts either a live TOTP code or an unused backup code. */
  async verifySecondFactor(userId: string, code: string): Promise<boolean> {
    const record = await this.prisma.twoFactorAuth.findUnique({ where: { userId } });
    if (!record || !record.enabled) return false;

    const secret = this.app.encrypter.tryDecrypt(record.secretEnc);
    if (secret && verifyTotp(secret, code)) return true;

    const digest = hashToken(code.trim().toLowerCase());
    if (record.backupCodes.includes(digest)) {
      await this.prisma.twoFactorAuth.update({
        where: { userId },
        data: { backupCodes: record.backupCodes.filter((c) => c !== digest) },
      });
      await this.app.notifications.push(userId, {
        type: NotificationType.SECURITY_EVENT,
        title: 'Backup code used',
        message: 'A two-factor backup code was used to sign in to your account.',
        level: 'WARNING',
      });
      return true;
    }
    return false;
  }

  /* --------------------------------------------------------- sessions -- */

  async issueSession(
    user: User & { role?: { name: RoleName } },
    context: LoginContext,
    rememberMe = false,
  ): Promise<AuthTokens> {
    const refreshToken = generateToken(48);
    const ttlDays = rememberMe ? this.app.env.JWT_REFRESH_TTL_DAYS : 1;
    const expiresAt = new Date(Date.now() + ttlDays * 86400 * 1000);

    const session = await this.prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        ip: context.ip,
        userAgent: context.userAgent?.slice(0, 512) ?? null,
        deviceLabel: describeDevice(context.userAgent),
        expiresAt,
      },
    });

    const accessTtl = parseTtl(this.app.env.JWT_ACCESS_TTL);
    const roleName = user.role?.name ?? (await this.roleNameFor(user.roleId));

    const accessToken = signJwt(
      this.app.env.JWT_SECRET,
      { sub: user.id, sid: session.id, role: roleName, iss: JWT_ISSUER, typ: 'access' },
      accessTtl,
    );

    return { accessToken, refreshToken, expiresIn: accessTtl };
  }

  private async roleNameFor(roleId: string): Promise<string> {
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    return role?.name ?? 'CUSTOMER';
  }

  /**
   * Refresh rotation: the presented token is invalidated and replaced. Re-use of
   * an already-rotated token means the cookie leaked, so every session for the
   * user is revoked and a security notification is raised.
   */
  async rotateSession(refreshToken: string, context: LoginContext): Promise<AuthTokens> {
    const tokenHash = hashToken(refreshToken);

    const session = await this.prisma.session.findUnique({
      where: { tokenHash },
      include: { user: { include: { role: true } } },
    });

    if (!session) {
      // Not the current token. If it is the one this session held before its
      // last rotation, the old token leaked: revoke the whole family.
      await this.handleTokenReuse(tokenHash);
      throw unauthorized('Your session has expired, please sign in again');
    }

    if (session.revokedAt) {
      await this.revokeAllSessions(session.userId);
      await this.notifyTokenReuse(session.userId);
      throw unauthorized('Your session is no longer valid, please sign in again');
    }

    if (session.expiresAt.getTime() < Date.now()) {
      await this.prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
      throw unauthorized('Your session has expired, please sign in again');
    }

    if (session.user.suspendedAt) {
      throw new AppError(403, ErrorCode.ACCOUNT_SUSPENDED, 'This account has been suspended');
    }

    const newRefresh = generateToken(48);
    const accessTtl = parseTtl(this.app.env.JWT_ACCESS_TTL);

    await this.prisma.session.update({
      where: { id: session.id },
      data: {
        tokenHash: hashToken(newRefresh),
        // Keep the outgoing hash so a replay of it is recognisable.
        previousTokenHash: tokenHash,
        lastUsedAt: new Date(),
        ip: context.ip,
        userAgent: context.userAgent?.slice(0, 512) ?? session.userAgent,
      },
    });

    const accessToken = signJwt(
      this.app.env.JWT_SECRET,
      {
        sub: session.userId,
        sid: session.id,
        role: session.user.role.name,
        iss: JWT_ISSUER,
        typ: 'access',
      },
      accessTtl,
    );

    return { accessToken, refreshToken: newRefresh, expiresIn: accessTtl };
  }

  /**
   * A token that is no longer current but was current one rotation ago can
   * only be presented by someone who captured it — the legitimate client
   * already swapped it. Revoking every session is the conservative response.
   */
  private async handleTokenReuse(tokenHash: string): Promise<void> {
    const replayed = await this.prisma.session.findUnique({
      where: { previousTokenHash: tokenHash },
    });
    if (!replayed) return;

    await this.revokeAllSessions(replayed.userId);
    await this.notifyTokenReuse(replayed.userId);
  }

  private async notifyTokenReuse(userId: string): Promise<void> {
    await this.app.notifications.push(userId, {
      type: NotificationType.SECURITY_EVENT,
      title: 'Session reuse detected',
      message:
        'A previously used sign-in token was replayed, so every active session was signed out as a precaution.',
      level: 'ERROR',
    });
    await this.app.audit.system({
      action: 'auth.token_reuse_detected',
      targetType: 'user',
      targetId: userId,
    });
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.prisma.session
      .update({ where: { id: sessionId }, data: { revokedAt: new Date() } })
      .catch(() => undefined);
  }

  async revokeAllSessions(userId: string, exceptSessionId?: string): Promise<number> {
    const result = await this.prisma.session.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptSessionId ? { NOT: { id: exceptSessionId } } : {}),
      },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  /* ---------------------------------------------------------- cookies -- */

  private cookieOptions(maxAgeSeconds: number): Record<string, unknown> {
    return {
      httpOnly: true,
      secure: this.app.env.COOKIE_SECURE,
      sameSite: 'lax' as const,
      path: '/',
      maxAge: maxAgeSeconds,
      signed: false,
      ...(this.app.env.COOKIE_DOMAIN ? { domain: this.app.env.COOKIE_DOMAIN } : {}),
    };
  }

  setAuthCookies(reply: FastifyReply, tokens: AuthTokens, rememberMe = false): void {
    const refreshMaxAge = (rememberMe ? this.app.env.JWT_REFRESH_TTL_DAYS : 1) * 86400;
    reply.setCookie(
      COOKIE_NAMES.accessToken,
      tokens.accessToken,
      this.cookieOptions(tokens.expiresIn),
    );
    reply.setCookie(COOKIE_NAMES.refreshToken, tokens.refreshToken, {
      ...this.cookieOptions(refreshMaxAge),
      path: '/',
    });
  }

  clearAuthCookies(reply: FastifyReply): void {
    const base = {
      path: '/',
      ...(this.app.env.COOKIE_DOMAIN ? { domain: this.app.env.COOKIE_DOMAIN } : {}),
    };
    reply.clearCookie(COOKIE_NAMES.accessToken, base);
    reply.clearCookie(COOKIE_NAMES.refreshToken, base);
  }

  /* --------------------------------------------------- 2FA management -- */

  async beginTwoFactorEnrolment(userId: string, secret: string): Promise<void> {
    await this.prisma.twoFactorAuth.upsert({
      where: { userId },
      create: { userId, secretEnc: this.app.encrypter.encrypt(secret), enabled: false },
      update: { secretEnc: this.app.encrypter.encrypt(secret), enabled: false, confirmedAt: null },
    });
  }

  async completeTwoFactorEnrolment(userId: string): Promise<string[]> {
    const codes = generateBackupCodes(10);
    await this.prisma.twoFactorAuth.update({
      where: { userId },
      data: {
        enabled: true,
        confirmedAt: new Date(),
        backupCodes: codes.map((code) => hashToken(code)),
      },
    });
    return codes;
  }

  async disableTwoFactor(userId: string): Promise<void> {
    await this.prisma.twoFactorAuth.deleteMany({ where: { userId } });
  }

  /* --------------------------------------------------------- helpers -- */

  static requestContext(request: FastifyRequest): LoginContext {
    return {
      ip: request.ip,
      userAgent: (request.headers['user-agent'] as string | undefined) ?? null,
    };
  }

  async assertPassword(userId: string, password: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !(await verifyPassword(user.passwordHash, password))) {
      throw forbidden('Your current password is not correct');
    }
  }
}

/** Best-effort device label for the session list. */
export function describeDevice(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  const ua = userAgent.toLowerCase();
  const browser = ua.includes('firefox')
    ? 'Firefox'
    : ua.includes('edg/')
      ? 'Edge'
      : ua.includes('chrome')
        ? 'Chrome'
        : ua.includes('safari')
          ? 'Safari'
          : 'Browser';
  const os = ua.includes('windows')
    ? 'Windows'
    : ua.includes('android')
      ? 'Android'
      : ua.includes('iphone') || ua.includes('ipad')
        ? 'iOS'
        : ua.includes('mac os')
          ? 'macOS'
          : ua.includes('linux')
            ? 'Linux'
            : 'Unknown OS';
  return `${browser} on ${os}`;
}

export type SessionWhere = Prisma.SessionWhereInput;
