import type { FastifyInstance } from 'fastify';
import { generateToken, hashToken, safeCompare } from '@storm/security';

/** What a granted ticket lets its holder read, and nothing else. */
export interface TransferTicket {
  backupId: string;
  sourceNodeId: string;
  serverUuid: string;
  backupUuid: string;
}

/** As long as a presigned S3 URL lives, because it replaces one. */
const TICKET_TTL_SECONDS = 6 * 3600;

const key = (id: string): string => `storm:transfer-ticket:${id}`;

/**
 * The panel as a route between two nodes.
 *
 * A move normally goes through object storage: the old node uploads an
 * archive, the new one downloads it, and nothing large passes through the
 * panel. On a deployment with no bucket there is no such route, and the move
 * was simply refused — which meant running S3 to shift a server between two
 * machines you already own.
 *
 * So the panel offers itself as the route. The archive stays on the old node's
 * disk, the new node is handed a URL here, and the panel streams one to the
 * other. It costs the panel's bandwidth twice over, which is why it is the
 * fallback and not the default.
 *
 * A ticket is what makes that safe to expose. The destination has no user
 * session, so the endpoint cannot ask for one; instead it carries a secret
 * that grants exactly one backup, from exactly one node, for as long as a
 * presigned URL would have lived. The secret is stored hashed, so a dump of
 * Redis is not a set of working download links.
 */
export class TransferArchiveService {
  constructor(private readonly app: FastifyInstance) {}

  /** Issues a ticket and returns what the destination has to send back. */
  async issue(ticket: TransferTicket): Promise<{ id: string; secret: string }> {
    const id = generateToken(12);
    const secret = generateToken(32);

    await this.app.redis.set(
      key(id),
      JSON.stringify({ ...ticket, hash: hashToken(secret) }),
      'EX',
      TICKET_TTL_SECONDS,
    );

    return { id, secret };
  }

  /**
   * The ticket behind an id, if the secret matches.
   *
   * Returns null for every failure — expired, unknown, wrong secret — because
   * the caller is an unauthenticated endpoint and telling the difference
   * between "no such ticket" and "wrong secret" is telling a stranger which
   * ids exist.
   */
  async redeem(id: string, secret: string): Promise<TransferTicket | null> {
    const raw = await this.app.redis.get(key(id));
    if (!raw) return null;

    let stored: TransferTicket & { hash: string };
    try {
      stored = JSON.parse(raw) as TransferTicket & { hash: string };
    } catch {
      return null;
    }

    if (!safeCompare(stored.hash, hashToken(secret))) return null;

    return {
      backupId: stored.backupId,
      sourceNodeId: stored.sourceNodeId,
      serverUuid: stored.serverUuid,
      backupUuid: stored.backupUuid,
    };
  }

  /** Drops a ticket once the move it belonged to is over, win or lose. */
  async revoke(id: string): Promise<void> {
    await this.app.redis.del(key(id)).catch(() => undefined);
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    transferArchives: TransferArchiveService;
  }
}
