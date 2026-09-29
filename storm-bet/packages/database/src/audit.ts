import type { Prisma } from '@prisma/client';
import type { UserRole } from '@storm-bet/types';
import type { DbOrTx } from './client';

export interface AuditActor {
  id: string | null;
  role: UserRole | null;
  ip?: string | null;
  userAgent?: string | null;
}

/** The system itself (worker, settlement) when no person acted. */
export const SYSTEM_ACTOR: AuditActor = { id: null, role: null };

export interface AuditEntry {
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Appends to the audit log. Written inside the same transaction as the change
 * it records, so an action and its trail commit or roll back together. The
 * table rejects UPDATE and DELETE at the database level.
 */
export async function recordAudit(db: DbOrTx, actor: AuditActor, entry: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      actorId: actor.id,
      actorRole: actor.role,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId ?? null,
      ip: actor.ip ?? null,
      userAgent: actor.userAgent?.slice(0, 400) ?? null,
      metadata: (entry.metadata ?? {}) as Prisma.InputJsonValue,
    },
  });
}
