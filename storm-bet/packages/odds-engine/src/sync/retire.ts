import {
  recordAudit,
  SYSTEM_ACTOR,
  withTransaction,
  type Prisma,
  type PrismaClient,
} from '@storm-bet/database';

/**
 * After switching the odds feed, events of the previous feed would stay open
 * forever: nobody updates or results them. They are cancelled instead, so
 * their open bets are voided (stakes returned) by the regular settlement run.
 * Manually created events are never touched.
 */
export async function retireInactiveProviderEvents(
  db: PrismaClient,
  activeProvider: string,
  options: { now?: Date; only?: string[] } = {},
): Promise<{ events: number; providers: string[] }> {
  const now = options.now ?? new Date();
  const where: Prisma.EventWhereInput = {
    provider: {
      notIn: [activeProvider, 'manual'],
      ...(options.only ? { in: options.only } : {}),
    },
    settledAt: null,
    OR: [
      { status: { in: ['SCHEDULED', 'LIVE', 'SUSPENDED', 'POSTPONED'] } },
      { status: 'FINISHED', resultConfirmedAt: null },
    ],
  };
  const stale = await db.event.findMany({ where, select: { id: true, provider: true } });
  if (stale.length === 0) return { events: 0, providers: [] };
  const ids = stale.map((e) => e.id);
  const providers = [...new Set(stale.map((e) => e.provider))];
  await withTransaction(db, async (tx) => {
    await tx.event.updateMany({
      where: { id: { in: ids } },
      data: { status: 'CANCELLED', resultConfirmedAt: now, isActive: false },
    });
    await tx.market.updateMany({
      where: { eventId: { in: ids }, status: { in: ['OPEN', 'SUSPENDED'] } },
      data: { status: 'CLOSED' },
    });
    await recordAudit(tx, SYSTEM_ACTOR, {
      action: 'events.provider_retired',
      targetType: 'odds_provider',
      targetId: providers.join(','),
      metadata: { activeProvider, events: ids.length },
    });
  });
  return { events: ids.length, providers };
}
