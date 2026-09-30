import {
  recordAudit,
  withTransaction,
  type AuditActor,
  type PrismaClient,
} from '@storm-bet/database';
import {
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  otpauthUri,
  verifyPassword,
  verifyTotp,
} from '@storm-bet/security';
import { AppError, type TwoFactorStatusDto } from '@storm-bet/types';

/**
 * Two-factor login with an authenticator app (TOTP). The shared secret is
 * sealed at rest; recovery codes are stored as hashes and work once each.
 */
export class TwoFactorService {
  constructor(
    private readonly db: PrismaClient,
    private readonly options: { authSecret: string; issuer: string; now: () => Date },
  ) {}

  async status(userId: string): Promise<TwoFactorStatusDto> {
    const user = await this.db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { totpEnabledAt: true },
    });
    const left = await this.db.recoveryCode.count({ where: { userId, usedAt: null } });
    return {
      enabled: user.totpEnabledAt !== null,
      enabledAt: user.totpEnabledAt?.toISOString() ?? null,
      recoveryCodesLeft: user.totpEnabledAt ? left : 0,
    };
  }

  /** Starts the setup: a new secret, confirmed later with a first code. */
  async setup(userId: string, password: string): Promise<{ secret: string; uri: string }> {
    const user = await this.db.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.totpEnabledAt)
      throw new AppError('CONFLICT', 'Die Zwei-Faktor-Anmeldung ist bereits aktiv.');
    await this.checkPassword(user.passwordHash, password);
    const secret = generateTotpSecret();
    await this.db.user.update({
      where: { id: userId },
      data: { totpPendingSecret: encryptSecret(secret, this.options.authSecret) },
    });
    return { secret, uri: otpauthUri(secret, user.email, this.options.issuer) };
  }

  /** Confirms the setup with a code from the app; returns the recovery codes once. */
  async enable(
    userId: string,
    code: string,
    actor: AuditActor,
  ): Promise<{ recoveryCodes: string[] }> {
    const user = await this.db.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.totpEnabledAt)
      throw new AppError('CONFLICT', 'Die Zwei-Faktor-Anmeldung ist bereits aktiv.');
    if (!user.totpPendingSecret)
      throw new AppError('VALIDATION_ERROR', 'Bitte starte die Einrichtung erneut.');
    const secret = decryptSecret(user.totpPendingSecret, this.options.authSecret);
    const step = verifyTotp(secret, code, this.options.now());
    if (step === null) throw new AppError('VALIDATION_ERROR', 'Der Code stimmt nicht.');
    const recoveryCodes = generateRecoveryCodes();
    await withTransaction(this.db, async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          totpSecret: user.totpPendingSecret,
          totpPendingSecret: null,
          totpEnabledAt: this.options.now(),
          totpLastStep: step,
        },
      });
      await this.replaceCodes(tx, userId, recoveryCodes);
      await recordAudit(tx, actor, {
        action: 'auth.2fa_enabled',
        targetType: 'user',
        targetId: userId,
      });
    });
    return { recoveryCodes };
  }

  async disable(userId: string, password: string, code: string, actor: AuditActor): Promise<void> {
    const user = await this.db.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.totpEnabledAt) return;
    await this.checkPassword(user.passwordHash, password);
    if (!(await this.verify(userId, code)))
      throw new AppError('VALIDATION_ERROR', 'Der Code stimmt nicht.');
    await withTransaction(this.db, async (tx) => {
      await this.clear(tx, userId);
      await recordAudit(tx, actor, {
        action: 'auth.2fa_disabled',
        targetType: 'user',
        targetId: userId,
      });
    });
  }

  async regenerateRecoveryCodes(
    userId: string,
    code: string,
    actor: AuditActor,
  ): Promise<{ recoveryCodes: string[] }> {
    const user = await this.db.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.totpEnabledAt)
      throw new AppError('CONFLICT', 'Die Zwei-Faktor-Anmeldung ist nicht aktiv.');
    if (!(await this.verify(userId, code, { totpOnly: true })))
      throw new AppError('VALIDATION_ERROR', 'Der Code stimmt nicht.');
    const recoveryCodes = generateRecoveryCodes();
    await withTransaction(this.db, async (tx) => {
      await this.replaceCodes(tx, userId, recoveryCodes);
      await recordAudit(tx, actor, {
        action: 'auth.2fa_recovery_codes_renewed',
        targetType: 'user',
        targetId: userId,
      });
    });
    return { recoveryCodes };
  }

  /** Staff: removes the second factor of an account that lost its device (audited). */
  async resetByStaff(userId: string, actor: AuditActor, reason: string): Promise<void> {
    await withTransaction(this.db, async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new AppError('NOT_FOUND', 'Nutzer nicht gefunden.');
      if (!user.totpEnabledAt)
        throw new AppError('CONFLICT', 'Die Zwei-Faktor-Anmeldung ist nicht aktiv.');
      await this.clear(tx, userId);
      await recordAudit(tx, actor, {
        action: 'admin.user_2fa_reset',
        targetType: 'user',
        targetId: userId,
        metadata: { reason },
      });
    });
  }

  /**
   * Checks a login code: a TOTP code for a step not used before (the step is
   * claimed atomically, so a code works once), or an unused recovery code.
   */
  async verify(
    userId: string,
    code: string,
    options: { totpOnly?: boolean } = {},
  ): Promise<'totp' | 'recovery' | null> {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { totpSecret: true, totpLastStep: true },
    });
    if (!user?.totpSecret) return null;
    const clean = code.replace(/\s/g, '');
    if (/^\d{6}$/.test(clean)) {
      const secret = decryptSecret(user.totpSecret, this.options.authSecret);
      const step = verifyTotp(secret, clean, this.options.now(), user.totpLastStep);
      if (step === null) return null;
      const claimed = await this.db.user.updateMany({
        where: {
          id: userId,
          OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }],
        },
        data: { totpLastStep: step },
      });
      return claimed.count === 1 ? 'totp' : null;
    }
    if (options.totpOnly) return null;
    const used = await this.db.recoveryCode.updateMany({
      where: { userId, codeHash: hashRecoveryCode(clean), usedAt: null },
      data: { usedAt: this.options.now() },
    });
    return used.count === 1 ? 'recovery' : null;
  }

  private async checkPassword(hash: string, password: string): Promise<void> {
    if (!(await verifyPassword(hash, password)))
      throw new AppError('VALIDATION_ERROR', 'Das Passwort ist falsch.');
  }

  private async replaceCodes(
    tx: Parameters<Parameters<typeof withTransaction>[1]>[0],
    userId: string,
    codes: string[],
  ): Promise<void> {
    await tx.recoveryCode.deleteMany({ where: { userId } });
    await tx.recoveryCode.createMany({
      data: codes.map((c) => ({ userId, codeHash: hashRecoveryCode(c) })),
    });
  }

  private async clear(
    tx: Parameters<Parameters<typeof withTransaction>[1]>[0],
    userId: string,
  ): Promise<void> {
    await tx.user.update({
      where: { id: userId },
      data: {
        totpSecret: null,
        totpPendingSecret: null,
        totpEnabledAt: null,
        totpLastStep: null,
      },
    });
    await tx.recoveryCode.deleteMany({ where: { userId } });
  }
}
