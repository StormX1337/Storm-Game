import { toWalletDto } from '@storm-bet/betting-engine';
import {
  activeSelfExclusion,
  LIMIT_WINDOWS_MS,
  loadEffectiveLimits,
  planLimitChange,
  REMOVAL_MARKER,
  SELF_EXCLUSION_DURATIONS_MS,
  stakedSince,
} from '@storm-bet/compliance';
import {
  moneyToNumber,
  recordAudit,
  type AuditActor,
  type PrismaClient,
} from '@storm-bet/database';
import {
  AppError,
  LIMIT_TYPES,
  type AccountSummaryDto,
  type LimitDto,
  type LimitType,
  type ProfileDto,
  type SelfExclusionDto,
} from '@storm-bet/types';
import type { SelfExclusionInput, UpdateProfileInput } from '@storm-bet/validation';
import { toSessionUser } from './auth';

export class AccountService {
  constructor(
    private readonly db: PrismaClient,
    private readonly now: () => Date,
  ) {}

  async profile(userId: string): Promise<ProfileDto> {
    const user = await this.db.user.findUniqueOrThrow({ where: { id: userId } });
    return {
      ...toSessionUser(user),
      country: user.country,
      dateOfBirth: user.dateOfBirth?.toISOString().slice(0, 10) ?? null,
      kycStatus: user.kycStatus,
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    };
  }

  async updateProfile(
    userId: string,
    input: UpdateProfileInput,
    actor: AuditActor,
  ): Promise<ProfileDto> {
    await this.db.user.update({
      where: { id: userId },
      data: {
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.country !== undefined ? { country: input.country } : {}),
      },
    });
    await recordAudit(this.db, actor, {
      action: 'account.profile_updated',
      targetType: 'user',
      targetId: userId,
      metadata: { fields: Object.keys(input) },
    });
    return this.profile(userId);
  }

  async summary(userId: string): Promise<AccountSummaryDto> {
    const [wallet, grouped, totals] = await Promise.all([
      this.db.wallet.findUniqueOrThrow({ where: { userId } }),
      this.db.bet.groupBy({ by: ['status'], where: { userId }, _count: { _all: true } }),
      this.db.bet.aggregate({ where: { userId }, _sum: { stake: true } }),
    ]);
    const returns = await this.db.bet.aggregate({
      where: { userId, status: { not: 'PENDING' } },
      _sum: { payout: true },
    });
    const count = (status: string) => grouped.find((g) => g.status === status)?._count._all ?? 0;
    return {
      wallet: toWalletDto(wallet),
      openBets: count('PENDING'),
      settledBets: grouped.reduce(
        (sum, g) => sum + (g.status === 'PENDING' ? 0 : g._count._all),
        0,
      ),
      wonBets: count('WON'),
      lostBets: count('LOST'),
      totalStaked: moneyToNumber(totals._sum.stake ?? 0n),
      totalReturns: moneyToNumber(returns._sum.payout ?? 0n),
    };
  }

  async limits(userId: string): Promise<LimitDto[]> {
    const now = this.now();
    const limits = await loadEffectiveLimits(this.db, userId, now);
    const out: LimitDto[] = [];
    for (const type of LIMIT_TYPES) {
      const row = limits.get(type);
      if (!row) continue;
      const window = type === 'STAKE_PER_BET' ? null : LIMIT_WINDOWS_MS[type];
      const used = window
        ? await stakedSince(this.db, userId, new Date(now.getTime() - window))
        : 0n;
      out.push({
        type,
        amount: moneyToNumber(row.amount),
        effectiveFrom: row.effectiveFrom.toISOString(),
        pendingAmount:
          row.pendingAmount == null
            ? null
            : row.pendingAmount === REMOVAL_MARKER
              ? -1
              : moneyToNumber(row.pendingAmount),
        pendingEffectiveAt: row.pendingEffectiveAt?.toISOString() ?? null,
        used: moneyToNumber(used),
      });
    }
    return out;
  }

  async setLimit(
    userId: string,
    type: LimitType,
    amount: number | null,
    actor: AuditActor,
    options: { byStaff?: boolean; reason?: string } = {},
  ): Promise<{ appliesImmediately: boolean }> {
    const now = this.now();
    const current = (await loadEffectiveLimits(this.db, userId, now)).get(type) ?? null;
    const plan = planLimitChange(current, amount === null ? null : BigInt(amount), now, {
      byStaff: options.byStaff,
    });
    switch (plan.action) {
      case 'none':
        break;
      case 'create':
        await this.db.userLimit.create({
          data: {
            userId,
            type,
            amount: plan.amount!,
            effectiveFrom: now,
            setByStaff: !!options.byStaff,
          },
        });
        break;
      case 'delete':
        await this.db.userLimit.delete({ where: { userId_type: { userId, type } } });
        break;
      case 'update':
        await this.db.userLimit.update({
          where: { userId_type: { userId, type } },
          data: {
            amount: plan.amount!,
            pendingAmount: plan.pendingAmount ?? null,
            pendingEffectiveAt: plan.pendingEffectiveAt ?? null,
            ...(plan.appliesImmediately ? { effectiveFrom: now } : {}),
            setByStaff: !!options.byStaff,
          },
        });
        break;
    }
    await recordAudit(this.db, actor, {
      action: options.byStaff ? 'admin.user_limit_set' : 'account.limit_set',
      targetType: 'user',
      targetId: userId,
      metadata: {
        type,
        requested: amount,
        previous: current ? moneyToNumber(current.amount) : null,
        appliesImmediately: plan.appliesImmediately,
        ...(options.reason ? { reason: options.reason } : {}),
      },
    });
    return { appliesImmediately: plan.appliesImmediately };
  }

  async selfExclusion(userId: string): Promise<SelfExclusionDto> {
    const now = this.now();
    const active = await activeSelfExclusion(this.db, userId, now);
    if (!active) return { active: false, startsAt: null, endsAt: null };
    const row = await this.db.selfExclusion.findFirst({
      where: { userId, startsAt: { lte: now }, OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
      orderBy: { createdAt: 'desc' },
    });
    return {
      active: true,
      startsAt: row?.startsAt.toISOString() ?? null,
      endsAt: active.endsAt?.toISOString() ?? null,
    };
  }

  /**
   * Starts a self-exclusion. It cannot be shortened or lifted early — not by
   * the player and not through any API — which is the point of it.
   */
  async excludeSelf(
    userId: string,
    input: SelfExclusionInput,
    actor: AuditActor,
  ): Promise<SelfExclusionDto> {
    const now = this.now();
    const duration = SELF_EXCLUSION_DURATIONS_MS[input.period];
    const endsAt = duration === null ? null : new Date(now.getTime() + duration);
    const existing = await activeSelfExclusion(this.db, userId, now);
    if (existing && (existing.endsAt === null || (endsAt !== null && existing.endsAt >= endsAt))) {
      throw new AppError(
        'CONFLICT',
        'Es besteht bereits eine gleich lange oder längere Selbstsperre.',
      );
    }
    await this.db.selfExclusion.create({
      data: { userId, startsAt: now, endsAt, reason: input.reason ?? null },
    });
    await recordAudit(this.db, actor, {
      action: 'account.self_excluded',
      targetType: 'user',
      targetId: userId,
      metadata: { period: input.period, endsAt: endsAt?.toISOString() ?? null },
    });
    return this.selfExclusion(userId);
  }
}
