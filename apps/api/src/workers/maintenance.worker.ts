import { Worker, Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { QUEUE_NAMES } from '@storm/config';
import { BackupStatus, NodeStatus, NotificationType, WebhookEvent } from '@storm/types';
import { nextRunAt } from '../lib/cron.js';
import { concurrency } from './concurrency.js';

/**
 * Periodic housekeeping, driven by a repeatable job that fires every minute:
 *
 *   - dispatch schedules that are due
 *   - mark nodes offline when their heartbeat lapses
 *   - apply backup retention policies
 *   - prune the stats time-series so the tables stay small
 */
export function createMaintenanceWorker(app: FastifyInstance): Worker {
  return new Worker(
    QUEUE_NAMES.maintenance,
    async (job) => {
      switch (job.name) {
        case 'tick':
          await dispatchDueSchedules(app);
          await reconcileNodeHealth(app);
          break;
        case 'housekeeping':
          await applyBackupRetention(app);
          await pruneStats(app);
          await pruneExpiredSessions(app);
          break;
        default:
          break;
      }
    },
    { connection: { url: app.env.REDIS_URL }, concurrency: concurrency(app, 1) },
  );
}

/** Registers the repeatable jobs. Safe to call on every boot. */
export async function scheduleMaintenanceJobs(queue: Queue): Promise<void> {
  await queue.add(
    'tick',
    {},
    {
      repeat: { pattern: '* * * * *' },
      jobId: 'storm-tick',
      removeOnComplete: 10,
      removeOnFail: 20,
    },
  );
  await queue.add(
    'housekeeping',
    {},
    {
      repeat: { pattern: '17 * * * *' },
      jobId: 'storm-housekeeping',
      removeOnComplete: 10,
      removeOnFail: 20,
    },
  );
}

/**
 * How long a claim may outlive the run it belongs to before that run is taken
 * to be gone. Added to the schedule's own worst case, not used on its own.
 */
const CLAIM_GRACE_MS = 10 * 60_000;

/** Exported so a test can drive a tick directly; the worker is its only caller. */
export async function dispatchDueSchedules(app: FastifyInstance): Promise<void> {
  await releaseLostClaims(app);

  const now = new Date();
  const due = await app.prisma.schedule.findMany({
    where: { isActive: true, isProcessing: false, nextRunAt: { lte: now } },
    take: 200,
  });

  for (const schedule of due) {
    // Claim the schedule before queueing so a second API replica running the
    // same tick cannot dispatch it twice.
    const claimed = await app.prisma.schedule.updateMany({
      where: { id: schedule.id, isProcessing: false },
      data: { isProcessing: true, claimedAt: new Date() },
    });
    if (claimed.count === 0) continue;
    await app.queues.enqueueSchedule(schedule.id);
  }

  // Backfill schedules that have never had a next run computed.
  const uninitialised = await app.prisma.schedule.findMany({
    where: { isActive: true, nextRunAt: null },
    take: 200,
  });
  for (const schedule of uninitialised) {
    await app.prisma.schedule.update({
      where: { id: schedule.id },
      data: { nextRunAt: nextRunAt(schedule) },
    });
  }
}

/**
 * Hands back claims whose run is never coming.
 *
 * A run gives its own claim back now, whichever way it ends — but it has to be
 * running to do that. The panel's update button restarts the API on purpose,
 * and a schedule claimed in that second has nothing left to release it. Before
 * this, that schedule was finished: every later tick filtered it out, while it
 * still read "active" with a next run in the past.
 */
async function releaseLostClaims(app: FastifyInstance): Promise<void> {
  const claimed = await app.prisma.schedule.findMany({
    where: { isProcessing: true },
    include: { tasks: { select: { timeOffsetSec: true } } },
    take: 200,
  });

  for (const schedule of claimed) {
    // A run may legitimately take as long as its own offsets add up to —
    // "stop, wait half an hour, start" is an ordinary maintenance window — so
    // the schedule's own tasks set the deadline. A flat timeout would reclaim
    // a run still in progress and then start a second one on top of it.
    const budget =
      schedule.tasks.reduce((total, task) => total + Math.max(0, task.timeOffsetSec), 0) * 1000 +
      CLAIM_GRACE_MS;
    if (Date.now() - (schedule.claimedAt?.getTime() ?? 0) < budget) continue;

    // Compare-and-swap on the timestamp: if the run claimed it again between
    // the read above and here, it is alive and keeps what it holds.
    const released = await app.prisma.schedule.updateMany({
      where: { id: schedule.id, isProcessing: true, claimedAt: schedule.claimedAt },
      data: { isProcessing: false, claimedAt: null },
    });
    if (released.count > 0) {
      app.log.warn(
        { scheduleId: schedule.id, since: schedule.claimedAt?.toISOString() ?? null },
        'released a schedule claim with no run behind it',
      );
    }
  }
}

async function reconcileNodeHealth(app: FastifyInstance): Promise<void> {
  const cutoff = new Date(Date.now() - app.env.NODE_HEARTBEAT_TIMEOUT * 1000);
  const stale = await app.prisma.node.findMany({
    where: {
      status: { in: [NodeStatus.ONLINE, NodeStatus.DEGRADED] },
      OR: [{ lastHeartbeatAt: null }, { lastHeartbeatAt: { lt: cutoff } }],
    },
  });

  for (const node of stale) {
    await app.prisma.node.update({ where: { id: node.id }, data: { status: NodeStatus.OFFLINE } });
    await app.notifications.broadcastNodeStatus(node.id, NodeStatus.OFFLINE);
    await app.audit.system({
      action: 'node.offline',
      targetType: 'node',
      targetId: node.id,
      targetLabel: node.name,
      metadata: { lastHeartbeatAt: node.lastHeartbeatAt?.toISOString() ?? null },
    });
    await app.webhooks.dispatch(WebhookEvent.NODE_OFFLINE, { nodeId: node.id, name: node.name });

    // Tell every admin, not just one — an offline node affects the whole panel.
    const admins = await app.prisma.user.findMany({
      where: { role: { name: { in: ['OWNER', 'ADMIN'] } }, suspendedAt: null },
      select: { id: true },
    });
    for (const admin of admins) {
      await app.notifications.push(admin.id, {
        type: NotificationType.NODE_OFFLINE,
        title: 'Node offline',
        message: `Node "${node.name}" stopped sending heartbeats.`,
        level: 'ERROR',
        link: `/admin/nodes/${node.id}`,
      });
    }
  }
}

/** Exported so a test can drive it directly; the worker is its only caller. */
export async function applyBackupRetention(app: FastifyInstance): Promise<void> {
  // Two settings looked like they controlled this and only one did. Admin →
  // Settings → Backups → Retention had no reader at all, so an administrator
  // could set thirty days there and watch backups accumulate forever, while
  // the retention that actually ran lived on each storage. It is now the
  // panel-wide default: a storage with its own number keeps it, one left at
  // zero follows the panel.
  const fallback = (await app.settings.read()).backupRetentionDays;
  const storages = await app.prisma.backupStorage.findMany();

  for (const storage of storages) {
    const retentionDays = storage.retentionDays > 0 ? storage.retentionDays : fallback;
    // Zero on both means keep forever, which is what the settings page says.
    if (retentionDays <= 0) continue;

    const cutoff = new Date(Date.now() - retentionDays * 86400 * 1000);
    const expired = await app.prisma.backup.findMany({
      where: {
        storageId: storage.id,
        isLocked: false,
        status: BackupStatus.COMPLETED,
        createdAt: { lt: cutoff },
      },
      include: { server: { include: { node: true } } },
      take: 100,
    });

    for (const backup of expired) {
      try {
        if (backup.storageKey) {
          if (app.storage.isLocal(storage)) {
            await app.agents
              .request(
                backup.server.node,
                `/api/v1/servers/${backup.server.uuid}/backups/${backup.uuid}`,
                {
                  method: 'DELETE',
                },
              )
              .catch(() => undefined);
          } else {
            await app.storage.remove(storage, backup.storageKey);
          }
        }
        await app.prisma.backup.delete({ where: { id: backup.id } });
        app.log.info({ backupId: backup.id }, 'pruned expired backup');
      } catch (error) {
        app.log.warn({ err: error, backupId: backup.id }, 'failed to prune backup');
      }
    }
  }
}

async function pruneStats(app: FastifyInstance): Promise<void> {
  const cutoff = new Date(Date.now() - 7 * 86400 * 1000);
  const [servers, nodes] = await Promise.all([
    app.prisma.serverStat.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    app.prisma.nodeStat.deleteMany({ where: { createdAt: { lt: cutoff } } }),
  ]);
  if (servers.count + nodes.count > 0) {
    app.log.debug({ servers: servers.count, nodes: nodes.count }, 'pruned stats');
  }
}

async function pruneExpiredSessions(app: FastifyInstance): Promise<void> {
  await app.prisma.session.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: new Date() } },
        { revokedAt: { lt: new Date(Date.now() - 30 * 86400 * 1000) } },
      ],
    },
  });
  await app.prisma.verificationToken.deleteMany({ where: { expiresAt: { lt: new Date() } } });
}
