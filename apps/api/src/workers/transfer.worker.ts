import type { FastifyInstance } from 'fastify';
import type { Node } from '@storm/database';
import { BackupStatus, NotificationType, ServerStatus, type AgentBackupResult } from '@storm/types';
import type { TransferJobData } from '../plugins/queues.js';

/**
 * Moves a server to another node.
 *
 * The route between the two hosts is a backup: the source node uploads an
 * archive to object storage and the destination downloads it. Nothing new
 * carries the bytes — no node-to-node channel to authenticate, no gigabytes
 * through the panel — and the thing in the middle is a real backup an operator
 * can inspect when a move goes wrong.
 *
 * The order below is chosen so that the point of no return comes last. Every
 * step up to the database flip leaves the source node untouched and complete,
 * so a failure means the server is still where it was and still works. The
 * destination is only adopted once its copy of the files is there.
 */
export async function runTransfer(app: FastifyInstance, data: TransferJobData): Promise<void> {
  const server = await app.prisma.server.findUnique({
    where: { id: data.serverId },
    include: { node: true, allocations: true },
  });
  if (!server) return;

  const source = server.node;
  const destination = await app.prisma.node.findUnique({
    where: { id: data.destinationNodeId },
  });
  if (!destination) return;

  const previousStatus = server.status;

  // Shared storage is the good route: the archive goes node -> bucket -> node
  // and nothing large touches the panel. Without one the panel puts itself in
  // the middle, which costs its bandwidth twice but means a deployment does
  // not have to run object storage to shift a server between two machines it
  // already owns.
  const storage = await app.prisma.backupStorage.findFirst({
    where: { isActive: true, driver: { not: 'LOCAL' } },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  });
  const local = storage
    ? null
    : await app.prisma.backupStorage.findFirst({
        where: { isActive: true, driver: 'LOCAL' },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      });
  const archiveStorage = storage ?? local;
  if (!archiveStorage) {
    await fail(app, server.id, previousStatus, 'No backup storage is configured any more.');
    return;
  }

  /** Ports claimed on the destination, released again if the move fails. */
  let claimedIds: string[] = [];
  let backupId: string | null = null;
  /** Issued only on the panel route; dropped either way once the move ends. */
  let ticket: { id: string; secret: string } | null = null;

  try {
    await app.servers.updateStatus(server.id, ServerStatus.TRANSFERRING);

    // 1. Stop it. A running server writes while it is being archived, and the
    //    copy that arrives would be a world saved half way through a tick.
    await app.agents
      .request(source, `/api/v1/servers/${server.uuid}/power`, {
        method: 'POST',
        body: { action: 'stop' },
        timeoutMs: 120_000,
      })
      .catch(() => undefined);
    await waitUntilStopped(app, source, server.uuid);

    // 2. Archive it, from the source node straight into the bucket.
    const backup = await app.prisma.backup.create({
      data: {
        serverId: server.id,
        storageId: archiveStorage.id,
        name: `Move to ${destination.name}`,
        status: BackupStatus.RUNNING,
        isAutomatic: true,
        createdById: data.userId,
      },
    });
    backupId = backup.id;

    const upload = await app.storage.uploadTarget(archiveStorage, server.uuid, backup.uuid);
    const result = await app.agents.request<AgentBackupResult>(
      source,
      `/api/v1/servers/${server.uuid}/backups`,
      {
        method: 'POST',
        body: { uuid: server.uuid, backupUuid: backup.uuid, ignore: [], upload },
        timeoutMs: 6 * 3600_000,
      },
    );
    await app.prisma.backup.update({
      where: { id: backup.id },
      data: {
        status: BackupStatus.COMPLETED,
        bytes: BigInt(result.bytes ?? 0),
        checksum: result.checksum ?? null,
        storageKey: upload.key,
        completedAt: new Date(),
      },
    });

    // 3. Claim ports on the destination before anything is written there, so a
    //    node that filled up in the meantime costs an archive and not a
    //    half-moved server.
    claimedIds = await claimOnDestination(app, server.id, destination.id, data.allocationId);

    // 4. Build the container on the destination and unpack the archive into
    //    it. Both calls address that node explicitly: the server row still
    //    says it lives on the source, and it stays that way until this works.
    // Built from the destination's ports, not the row's: during a move the
    // server holds ports on both nodes, and the old address must not end up in
    // SERVER_IP, the startup command or the config files written on arrival.
    const spec = await app.servers.buildAgentSpec(
      server.id,
      await allocationsById(app, claimedIds),
    );
    await app.agents.request(destination, '/api/v1/servers', { method: 'PUT', body: spec });

    // With a bucket the destination reads from it directly. Without one it
    // reads from the panel, which streams the archive off the old node's disk.
    // The ticket grants that one archive and nothing else.
    let download;
    if (storage) {
      download = await app.storage.downloadSource(storage, server.uuid, backup.uuid);
    } else {
      ticket = await app.transferArchives.issue({
        backupId: backup.id,
        sourceNodeId: source.id,
        serverUuid: server.uuid,
        backupUuid: backup.uuid,
      });
      download = {
        driver: 'PANEL' as const,
        url: `${app.env.APP_URL.replace(/\/+$/, '')}${app.env.API_PREFIX}/v1/internal/transfer-archive/${ticket.id}`,
        headers: { authorization: `Bearer ${ticket.secret}` },
        key: upload.key,
      };
    }
    await app.agents.request(
      destination,
      `/api/v1/servers/${server.uuid}/backups/${backup.uuid}/restore`,
      {
        method: 'POST',
        body: {
          uuid: server.uuid,
          backupUuid: backup.uuid,
          // The directory on a fresh node is empty, but say so explicitly:
          // a retried move must not merge two copies of a world.
          truncate: true,
          download,
        },
        timeoutMs: 6 * 3600_000,
      },
    );

    // 5. The point of no return. Both sides hold the files; from here the
    //    destination is the one the panel talks to.
    const oldAllocationIds = server.allocations.map((allocation) => allocation.id);
    await app.prisma.$transaction([
      app.prisma.serverAllocation.updateMany({
        where: { id: { in: oldAllocationIds } },
        data: { serverId: null, isPrimary: false },
      }),
      app.prisma.server.update({
        where: { id: server.id },
        data: { nodeId: destination.id, status: ServerStatus.OFFLINE },
      }),
    ]);

    // 6. Tidy the source. Failing here costs disk on the old node and nothing
    //    else, so it must not fail the move that already succeeded.
    await app.agents
      .request(source, `/api/v1/servers/${server.uuid}`, { method: 'DELETE', timeoutMs: 600_000 })
      .catch((error: unknown) => {
        app.log.warn(
          { err: error, serverId: server.id, node: source.name },
          'server moved, but its files could not be removed from the old node',
        );
      });

    if (!data.keepBackup && backupId) {
      // On the source node for a LOCAL archive, in the bucket otherwise. This
      // used to delete only from the bucket, so every move without one left a
      // full-size archive on the old node — and then deleted the row that knew
      // it was there.
      await app.storage
        .removeArchive(archiveStorage, {
          node: source,
          serverUuid: server.uuid,
          backupUuid: backup.uuid,
          key: upload.key,
        })
        .catch((error: unknown) => {
          app.log.warn(
            { err: error, serverId: server.id, node: source.name },
            'the move archive could not be removed from the old node',
          );
        });
      await app.prisma.backup.delete({ where: { id: backupId } }).catch(() => undefined);
    }

    await app.audit.system({
      action: 'admin.server_moved',
      targetType: 'server',
      targetId: server.id,
      targetLabel: server.name,
      metadata: { from: source.name, to: destination.name, userId: data.userId },
    });
    await app.notifications.push(server.ownerId, {
      type: NotificationType.SERVER_MOVED,
      title: 'Server moved',
      message: `${server.name} now runs on ${destination.name}. Its address changed, so update anything that connects to it.`,
      level: 'SUCCESS',
      link: `/servers/${server.shortId}/network`,
    });
  } catch (error) {
    // Nothing has been taken from the source at this point: it still holds the
    // container and every file. Give the destination's ports back and put the
    // server back the way it was.
    if (claimedIds.length > 0) {
      await app.prisma.serverAllocation
        .updateMany({
          where: { id: { in: claimedIds } },
          data: { serverId: null, isPrimary: false },
        })
        .catch(() => undefined);
      await app.agents
        .request(destination, `/api/v1/servers/${server.uuid}`, {
          method: 'DELETE',
          timeoutMs: 600_000,
        })
        .catch(() => undefined);
    }

    const message = error instanceof Error ? error.message : String(error);
    await fail(app, server.id, previousStatus, message);
    throw error;
  } finally {
    // The ticket outlives nothing. Whether the move landed or fell over, the
    // URL handed to the destination stops working here rather than in six
    // hours — a granted read of one server's whole directory should last
    // exactly as long as the move that needed it.
    if (ticket) await app.transferArchives.revoke(ticket.id);
  }
}

async function fail(
  app: FastifyInstance,
  serverId: string,
  previousStatus: ServerStatus,
  message: string,
): Promise<void> {
  const server = await app.prisma.server.findUnique({ where: { id: serverId } });
  if (!server) return;

  await app.servers
    .updateStatus(
      serverId,
      previousStatus === ServerStatus.TRANSFERRING ? ServerStatus.OFFLINE : previousStatus,
    )
    .catch(() => undefined);
  await app.notifications.push(server.ownerId, {
    type: NotificationType.SERVER_MOVED,
    title: 'Move failed',
    message: `${server.name} could not be moved and is still on its old node: ${message.slice(0, 160)}`,
    level: 'ERROR',
    link: `/servers/${server.shortId}`,
  });
}

/**
 * Waits for the container to actually be down.
 *
 * A stop is a request, not an event: the agent asks the process to exit and
 * Docker gives it time. Archiving before it has finished writing is how a
 * moved world loses its last few minutes.
 */
async function waitUntilStopped(app: FastifyInstance, node: Node, uuid: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const state = await app.agents
      .request<{ status: string }>(node, `/api/v1/servers/${uuid}`, { timeoutMs: 15_000 })
      .catch(() => null);
    if (!state || state.status === 'OFFLINE' || state.status === 'CRASHED') return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  // Not fatal: the kill below is what a stuck server gets, and an archive of a
  // killed server is still the archive the customer had a moment ago.
  await app.agents
    .request(node, `/api/v1/servers/${uuid}/power`, {
      method: 'POST',
      body: { action: 'kill' },
      timeoutMs: 60_000,
    })
    .catch(() => undefined);
}

/** Claims ports on the destination with the same compare-and-swap as creation. */
async function claimOnDestination(
  app: FastifyInstance,
  serverId: string,
  nodeId: string,
  allocationId: string | null,
): Promise<string[]> {
  return app.prisma.$transaction(async (tx) => {
    const target = allocationId
      ? await tx.serverAllocation.findFirst({ where: { id: allocationId, nodeId, serverId: null } })
      : await tx.serverAllocation.findFirst({
          where: { nodeId, serverId: null },
          orderBy: { port: 'asc' },
        });
    if (!target) throw new Error('The destination node has no free port left.');

    // `serverId: null` in the predicate is the claim: a competing transaction
    // blocks on the row and then matches nothing, rather than both moves
    // landing on the same port.
    const claimed = await tx.serverAllocation.updateMany({
      where: { id: target.id, nodeId, serverId: null },
      data: { serverId, isPrimary: true },
    });
    if (claimed.count !== 1) throw new Error('That port was taken while the move was running.');

    return [target.id];
  });
}

async function allocationsById(app: FastifyInstance, ids: string[]) {
  return app.prisma.serverAllocation.findMany({ where: { id: { in: ids } } });
}
