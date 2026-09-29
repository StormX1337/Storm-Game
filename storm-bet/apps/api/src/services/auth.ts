import { TOKEN_TTL } from '@storm-bet/config/constants';
import { openWallet } from '@storm-bet/betting-engine';
import {
  isUniqueViolation,
  recordAudit,
  withTransaction,
  type PrismaClient,
  type User,
} from '@storm-bet/database';
import type { Redis } from '@storm-bet/redis';
import {
  generateToken,
  hashPassword,
  hashToken,
  needsRehash,
  verifyAgainstDummy,
  verifyPassword,
} from '@storm-bet/security';
import {
  AppError,
  ROLE_PERMISSIONS,
  type AuthTokenType,
  type SessionUserDto,
} from '@storm-bet/types';
import type {
  ChangePasswordInput,
  LoginInput,
  RegisterInput,
  ResetPasswordInput,
} from '@storm-bet/validation';
import { REDIS_KEYS } from '@storm-bet/config/constants';
import { mailTemplates, type Mailer } from '../lib/mailer';
import type { SessionService } from './sessions';

export interface RequestInfo {
  ip: string | null;
  userAgent: string | null;
  /** IP as it may be written to the audit log (null where that is not permitted). */
  auditIp: string | null;
}

/** Consecutive failures per account before logins are refused for a while. */
const MAX_FAILURES = 5;
const LOCKOUT_SECONDS = 15 * 60;

export function toSessionUser(
  user: Pick<
    User,
    'id' | 'email' | 'displayName' | 'role' | 'status' | 'emailVerifiedAt' | 'createdAt'
  >,
): SessionUserDto {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    emailVerified: user.emailVerifiedAt !== null,
    permissions: [...ROLE_PERMISSIONS[user.role]],
    createdAt: user.createdAt.toISOString(),
  };
}

export class AuthService {
  constructor(
    private readonly db: PrismaClient,
    private readonly redis: Redis,
    private readonly sessions: SessionService,
    private readonly mailer: Mailer,
    private readonly options: { appUrl: string; startingBalance: bigint; now: () => Date },
  ) {}

  async register(input: RegisterInput, info: RequestInfo) {
    const passwordHash = await hashPassword(input.password);
    let user: User;
    try {
      user = await withTransaction(this.db, async (tx) => {
        const created = await tx.user.create({
          data: {
            email: input.email,
            displayName: input.displayName,
            passwordHash,
            country: input.country ?? null,
          },
        });
        await openWallet(tx, created.id, this.options.startingBalance);
        await recordAudit(
          tx,
          { id: created.id, role: created.role, ip: info.auditIp, userAgent: info.userAgent },
          {
            action: 'auth.registered',
            targetType: 'user',
            targetId: created.id,
            metadata: { country: input.country ?? null },
          },
        );
        return created;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError(
          'CONFLICT',
          'Mit dieser E-Mail-Adresse ist bereits ein Konto registriert. Melde dich an oder setze dein Passwort zurück.',
          { details: { fields: { email: 'E-Mail-Adresse bereits registriert' } } },
        );
      }
      throw error;
    }
    await this.sendVerification(user).catch(() => undefined);
    const { token, session } = await this.sessions.create(user.id, info);
    return { user, token, session };
  }

  async login(input: LoginInput, info: RequestInfo) {
    const failuresKey = REDIS_KEYS.loginFailures(input.email);
    const failures = Number((await this.redis.get(failuresKey).catch(() => null)) ?? 0);
    if (failures >= MAX_FAILURES) {
      const ttl = await this.redis.ttl(failuresKey).catch(() => LOCKOUT_SECONDS);
      throw new AppError(
        'RATE_LIMITED',
        'Zu viele fehlgeschlagene Anmeldeversuche. Bitte versuche es später erneut oder setze dein Passwort zurück.',
        { retryAfter: ttl > 0 ? ttl : LOCKOUT_SECONDS },
      );
    }

    const user = await this.db.user.findUnique({ where: { email: input.email } });
    const valid = user
      ? await verifyPassword(user.passwordHash, input.password)
      : await verifyAgainstDummy(input.password);
    if (!user || !valid) {
      const count = await this.redis.incr(failuresKey).catch(() => 0);
      if (count === 1) await this.redis.expire(failuresKey, LOCKOUT_SECONDS).catch(() => undefined);
      if (user) {
        await recordAudit(
          this.db,
          { id: user.id, role: user.role, ip: info.auditIp, userAgent: info.userAgent },
          {
            action: 'auth.login_failed',
            targetType: 'user',
            targetId: user.id,
            metadata: { consecutiveFailures: count },
          },
        );
      }
      throw new AppError('UNAUTHORIZED', 'E-Mail-Adresse oder Passwort ist falsch.');
    }
    if (user.status === 'LOCKED') {
      throw new AppError(
        'FORBIDDEN',
        'Dieses Konto ist gesperrt. Bitte wende dich an den Support.',
      );
    }
    if (user.status === 'CLOSED') {
      throw new AppError('FORBIDDEN', 'Dieses Konto wurde geschlossen.');
    }
    await this.redis.del(failuresKey).catch(() => undefined);

    const updates: { lastLoginAt: Date; passwordHash?: string } = {
      lastLoginAt: this.options.now(),
    };
    if (needsRehash(user.passwordHash)) updates.passwordHash = await hashPassword(input.password);
    await this.db.user.update({ where: { id: user.id }, data: updates });

    const { token, session } = await this.sessions.create(user.id, info);
    await recordAudit(
      this.db,
      { id: user.id, role: user.role, ip: info.auditIp, userAgent: info.userAgent },
      {
        action: 'auth.login',
        targetType: 'session',
        targetId: session.id,
      },
    );
    return { user, token, session };
  }

  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.db.user.findUnique({ where: { email } });
    if (!user || user.status === 'CLOSED') return; // Same answer either way: no account enumeration.
    const token = await this.issueToken(user.id, 'PASSWORD_RESET', TOKEN_TTL.passwordResetMinutes);
    await this.mailer.send({
      to: user.email,
      ...mailTemplates.resetPassword(this.options.appUrl, token),
    });
  }

  async resetPassword(input: ResetPasswordInput, info: RequestInfo): Promise<void> {
    const record = await this.consumeToken(input.token, 'PASSWORD_RESET');
    const passwordHash = await hashPassword(input.password);
    const user = await this.db.user.update({
      where: { id: record.userId },
      data: { passwordHash, passwordChangedAt: this.options.now() },
    });
    await this.sessions.revokeAll(user.id, 'password reset');
    await this.redis.del(REDIS_KEYS.loginFailures(user.email)).catch(() => undefined);
    await recordAudit(
      this.db,
      { id: user.id, role: user.role, ip: info.auditIp, userAgent: info.userAgent },
      {
        action: 'auth.password_reset',
        targetType: 'user',
        targetId: user.id,
      },
    );
  }

  async verifyEmail(token: string): Promise<void> {
    const record = await this.consumeToken(token, 'EMAIL_VERIFICATION');
    const user = await this.db.user.update({
      where: { id: record.userId },
      data: { emailVerifiedAt: this.options.now() },
    });
    await this.sessions.invalidateUser(user.id);
    await recordAudit(
      this.db,
      { id: user.id, role: user.role },
      {
        action: 'auth.email_verified',
        targetType: 'user',
        targetId: user.id,
      },
    );
  }

  async sendVerification(
    user: Pick<User, 'id' | 'email' | 'displayName' | 'emailVerifiedAt'>,
  ): Promise<void> {
    if (user.emailVerifiedAt) return;
    const token = await this.issueToken(
      user.id,
      'EMAIL_VERIFICATION',
      TOKEN_TTL.emailVerificationMinutes,
    );
    await this.mailer.send({
      to: user.email,
      ...mailTemplates.verifyEmail(this.options.appUrl, token, user.displayName),
    });
  }

  async changePassword(
    userId: string,
    sessionId: string,
    input: ChangePasswordInput,
    info: RequestInfo,
  ): Promise<number> {
    const user = await this.db.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
      throw new AppError('VALIDATION_ERROR', 'Das aktuelle Passwort ist falsch.', {
        details: { fields: { currentPassword: 'Das aktuelle Passwort ist falsch.' } },
      });
    }
    await this.db.user.update({
      where: { id: userId },
      data: {
        passwordHash: await hashPassword(input.newPassword),
        passwordChangedAt: this.options.now(),
      },
    });
    const revoked = await this.sessions.revokeAll(userId, 'password changed', sessionId);
    await recordAudit(
      this.db,
      { id: userId, role: user.role, ip: info.auditIp, userAgent: info.userAgent },
      {
        action: 'auth.password_changed',
        targetType: 'user',
        targetId: userId,
        metadata: { otherSessionsRevoked: revoked },
      },
    );
    return revoked;
  }

  private async issueToken(
    userId: string,
    type: AuthTokenType,
    ttlMinutes: number,
  ): Promise<string> {
    const token = generateToken(32);
    const now = this.options.now();
    // A new link invalidates the previous ones of the same kind.
    await this.db.authToken.updateMany({
      where: { userId, type, usedAt: null },
      data: { usedAt: now },
    });
    await this.db.authToken.create({
      data: {
        userId,
        type,
        tokenHash: hashToken(token),
        expiresAt: new Date(now.getTime() + ttlMinutes * 60_000),
      },
    });
    return token;
  }

  private async consumeToken(token: string, type: AuthTokenType) {
    const now = this.options.now();
    const record = await this.db.authToken.findUnique({ where: { tokenHash: hashToken(token) } });
    const invalid = new AppError(
      'VALIDATION_ERROR',
      'Der Link ist ungültig oder abgelaufen. Bitte fordere einen neuen an.',
    );
    if (!record || record.type !== type || record.usedAt || record.expiresAt <= now) throw invalid;
    // Conditional update: two concurrent uses of one token cannot both succeed.
    const used = await this.db.authToken.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: now },
    });
    if (used.count !== 1) throw invalid;
    return record;
  }
}
