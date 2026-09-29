import { REDIS_KEYS } from '@storm-bet/config/constants';
import type { PrismaClient } from '@storm-bet/database';
import type { Redis } from '@storm-bet/redis';
import { generateToken, hashToken } from '@storm-bet/security';
import { isStaff, type UserRole, type UserStatus } from '@storm-bet/types';

export interface SessionRecord {
  sessionId: string;
  tokenHash: string;
  userId: string;
  role: UserRole;
  status: UserStatus;
  email: string;
  displayName: string;
  emailVerified: boolean;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
}

export interface SessionConfig {
  ttlHours: number;
  idleMinutes: number;
  staffIdleMinutes: number;
}

/** Session lookups are cached briefly; every revocation deletes the cache entry. */
const CACHE_SECONDS = 15;
/** lastSeenAt is written at most this often per session. */
const TOUCH_INTERVAL_MS = 60_000;

/**
 * Opaque server-side sessions. The cookie carries 256 random bits; the
 * database stores only their SHA-256, so neither a database nor a cache dump
 * yields a usable session.
 */
export class SessionService {
  constructor(
    private readonly db: PrismaClient,
    private readonly redis: Redis,
    private readonly config: SessionConfig,
    private readonly now: () => Date,
  ) {}

  async create(userId: string, meta: { ip: string | null; userAgent: string | null }) {
    const token = generateToken(32);
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.config.ttlHours * 3_600_000);
    const session = await this.db.session.create({
      data: {
        userId,
        tokenHash: hashToken(token),
        ip: meta.ip,
        userAgent: meta.userAgent?.slice(0, 400) ?? null,
        expiresAt,
        lastSeenAt: now,
      },
    });
    return { token, session };
  }

  /** Resolves a cookie token to a live session, or null. Expired and idle sessions are revoked. */
  async resolve(token: string): Promise<SessionRecord | null> {
    if (!token || token.length > 100) return null;
    const tokenHash = hashToken(token);
    const cacheKey = REDIS_KEYS.session(tokenHash);
    let record: SessionRecord | null = null;
    const cached = await this.redis.get(cacheKey).catch(() => null);
    if (cached) record = JSON.parse(cached) as SessionRecord;
    if (!record) {
      const row = await this.db.session.findUnique({
        where: { tokenHash },
        include: {
          user: {
            select: {
              id: true,
              role: true,
              status: true,
              email: true,
              displayName: true,
              emailVerifiedAt: true,
            },
          },
        },
      });
      if (!row || row.revokedAt) return null;
      record = {
        sessionId: row.id,
        tokenHash,
        userId: row.userId,
        role: row.user.role,
        status: row.user.status,
        email: row.user.email,
        displayName: row.user.displayName,
        emailVerified: row.user.emailVerifiedAt !== null,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        lastSeenAt: row.lastSeenAt.toISOString(),
      };
      await this.redis
        .set(cacheKey, JSON.stringify(record), 'EX', CACHE_SECONDS)
        .catch(() => undefined);
    }

    const now = this.now();
    const idleMinutes = isStaff(record.role)
      ? this.config.staffIdleMinutes
      : this.config.idleMinutes;
    if (Date.parse(record.expiresAt) <= now.getTime()) {
      await this.revoke(record.sessionId, 'expired');
      return null;
    }
    if (Date.parse(record.lastSeenAt) + idleMinutes * 60_000 <= now.getTime()) {
      await this.revoke(record.sessionId, 'idle');
      return null;
    }
    if (record.status !== 'ACTIVE' && record.status !== 'LOCKED') return null;
    if (record.status === 'LOCKED') {
      await this.revoke(record.sessionId, 'account locked');
      return null;
    }
    if (now.getTime() - Date.parse(record.lastSeenAt) > TOUCH_INTERVAL_MS) {
      record.lastSeenAt = now.toISOString();
      await this.db.session
        .update({ where: { id: record.sessionId }, data: { lastSeenAt: now } })
        .catch(() => undefined);
      await this.redis
        .set(cacheKey, JSON.stringify(record), 'EX', CACHE_SECONDS)
        .catch(() => undefined);
    }
    return record;
  }

  async revoke(sessionId: string, reason: string): Promise<void> {
    const row = await this.db.session.findUnique({
      where: { id: sessionId },
      select: { tokenHash: true, revokedAt: true },
    });
    if (!row) return;
    if (!row.revokedAt) {
      await this.db.session.update({
        where: { id: sessionId },
        data: { revokedAt: this.now(), revokedReason: reason },
      });
    }
    await this.redis.del(REDIS_KEYS.session(row.tokenHash)).catch(() => undefined);
  }

  /** Revokes every session of a user, optionally keeping one (the current). */
  async revokeAll(userId: string, reason: string, exceptSessionId?: string): Promise<number> {
    const sessions = await this.db.session.findMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
      },
      select: { id: true, tokenHash: true },
    });
    if (sessions.length === 0) return 0;
    await this.db.session.updateMany({
      where: { id: { in: sessions.map((s) => s.id) } },
      data: { revokedAt: this.now(), revokedReason: reason },
    });
    await this.redis
      .del(...sessions.map((s) => REDIS_KEYS.session(s.tokenHash)))
      .catch(() => undefined);
    return sessions.length;
  }

  /** Drops cached lookups so a role or status change applies on the next request. */
  async invalidateUser(userId: string): Promise<void> {
    const sessions = await this.db.session.findMany({
      where: { userId, revokedAt: null },
      select: { tokenHash: true },
    });
    if (sessions.length) {
      await this.redis
        .del(...sessions.map((s) => REDIS_KEYS.session(s.tokenHash)))
        .catch(() => undefined);
    }
  }
}
