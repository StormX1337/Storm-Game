import { Worker, Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { QUEUE_NAMES } from '@storm/config';
import {
  BackupStatus,
  NodeStatus,
  NotificationType,
  RESOURCE_CEILING_RATIO,
  ServerStatus,
  WebhookEvent,
} from '@storm/types';
import { nextRunAt } from '../lib/cron.js';
import { concurrency } from './concurrency.js';

/**
 * Periodic housekeeping, driven by a repeatable job that fires every minute:
 *
 *   - dispatch schedules that are due
 *   - mark nodes offline when their heartbeat lapses
 *   - warn an owner whose server is running into its own limits
 *   - hand back servers left mid-install by a run that never came back
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
          await warnAboutCeilings(app);
          break;
        case 'housekeeping':
          await failStalledInstalls(app);
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

/**
 * How long one install attempt may run before the panel stops waiting for it.
 *
 * The agent gives an install three hours — a Steam download over a slow link
 * genuinely takes that — so anything past four is not slow, it is gone.
 */
const STALLED_INSTALL_MS = 4 * 3600_000;

/**
 * Frees servers left mid-install by a run that never came back.
 *
 * An install worker that is killed between attempts takes the job with it, and
 * the row keeps saying INSTALLING for ever: the reinstall button refuses to
 * touch a server that is already installing, so the one action that would fix
 * it is the one action the customer cannot take. Marking it failed is not a
 * cosmetic tidy-up — it is what hands the server back.
 *
 * Exported so a test can drive it directly; the worker is its only caller.
 */
export async function failStalledInstalls(app: FastifyInstance): Promise<void> {
  const cutoff = new Date(Date.now() - STALLED_INSTALL_MS);
  const stalled = await app.prisma.server.findMany({
    where: {
      status: { in: [ServerStatus.INSTALLING, ServerStatus.REINSTALLING] },
      installStartedAt: { lt: cutoff },
    },
    select: { id: true, name: true, shortId: true, ownerId: true, installStartedAt: true },
    take: 100,
  });

  for (const server of stalled) {
    // Compare-and-swap on the stamp: an attempt that started again between the
    // read and here is alive, and gets left alone.
    const claimed = await app.prisma.server.updateMany({
      where: {
        id: server.id,
        installStartedAt: server.installStartedAt,
        status: { in: [ServerStatus.INSTALLING, ServerStatus.REINSTALLING] },
      },
      data: { status: ServerStatus.INSTALL_FAILED },
    });
    if (claimed.count === 0) continue;

    app.log.warn(
      { serverId: server.id, since: server.installStartedAt?.toISOString() ?? null },
      'install abandoned; marking it failed so it can be retried',
    );
    await app.notifications.broadcastServerStatus(
      server.id,
      server.ownerId,
      ServerStatus.INSTALL_FAILED,
    );
    await app.audit.system({
      action: 'server.install_failed',
      targetType: 'server',
      targetId: server.id,
      targetLabel: server.name,
      metadata: { error: 'The install did not report back and was given up on.' },
    });
    await app.notifications.push(server.ownerId, {
      type: NotificationType.SERVER_CRASHED,
      title: 'Installation failed',
      message: `${server.name} stopped installing without finishing. Reinstall it to try again.`,
      level: 'ERROR',
      link: `/servers/${server.shortId}`,
    });
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

/** How far back the memory reading looks, so one spike is not a warning. */
const CEILING_WINDOW_MS = 5 * 60_000;

/** Below this many readings in the window there is not enough to judge. */
const MIN_CEILING_SAMPLES = 3;

/** How long the same warning stays quiet after it has been given once. */
const CEILING_COOLDOWN_SECONDS = 6 * 3600;

const MIB = 1024 * 1024;

/**
 * Tells an owner their server is running into its own limits, before it dies
 * of them.
 *
 * The panel already says what happened afterwards — a crash notification that
 * names an out-of-memory kill, and a file manager that refuses a write past
 * the disk limit. Both arrive after the fact, and the minute-by-minute stats
 * that would have seen either coming were written, charted and pruned without
 * anything ever reading them.
 *
 * Memory is judged over a window, because a Java server touching its ceiling
 * for one minute during world generation is not news; sitting there is. Disk
 * is judged on the high-water mark, because it does not come back down on its
 * own and the write that fails is the one that matters.
 *
 * Exported so a test can drive it directly; the worker is its only caller.
 */
export async function warnAboutCeilings(app: FastifyInstance): Promise<void> {
  const servers = await app.prisma.server.findMany({
    where: {
      suspendedAt: null,
      status: ServerStatus.ONLINE,
      // A narrowing, not the guard: each resource is checked for a ceiling of
      // its own below, because a server can be sold unmetered memory on a
      // metered disk.
      OR: [{ memoryLimit: { gt: 0 } }, { diskLimit: { gt: 0 } }],
    },
    select: {
      id: true,
      name: true,
      shortId: true,
      ownerId: true,
      memoryLimit: true,
      diskLimit: true,
    },
    take: 500,
  });
  if (servers.length === 0) return;

  const samples = await app.prisma.serverStat.findMany({
    where: {
      serverId: { in: servers.map((server) => server.id) },
      createdAt: { gte: new Date(Date.now() - CEILING_WINDOW_MS) },
    },
    select: { serverId: true, memoryBytes: true, diskBytes: true },
  });

  const byServer = new Map<string, { memoryBytes: bigint; diskBytes: bigint }[]>();
  for (const sample of samples) {
    const list = byServer.get(sample.serverId);
    if (list) list.push(sample);
    else byServer.set(sample.serverId, [sample]);
  }

  for (const server of servers) {
    const readings = byServer.get(server.id) ?? [];
    if (readings.length < MIN_CEILING_SAMPLES) continue;

    if (server.memoryLimit > 0) {
      const ceiling = server.memoryLimit * MIB * RESOURCE_CEILING_RATIO;
      // Every reading, not the average: a server that dips is coping.
      if (readings.every((reading) => Number(reading.memoryBytes) >= ceiling)) {
        const peak = readings.reduce(
          (most, reading) => (reading.memoryBytes > most ? reading.memoryBytes : most),
          0n,
        );
        await warnOnce(app, server, 'memory', {
          title: 'Server is running out of memory',
          message:
            `${server.name} has been using ${percentOf(peak, server.memoryLimit)}% of its ` +
            `${server.memoryLimit} MiB for several minutes. Servers that stay here get killed ` +
            'by the kernel — give it more memory, or lower what it loads.',
          usedBytes: peak,
          limitMib: server.memoryLimit,
        });
      }
    }

    if (server.diskLimit > 0) {
      const ceiling = server.diskLimit * MIB * RESOURCE_CEILING_RATIO;
      // The high-water mark: disk does not fall on its own, and the write that
      // fails is the one at the peak.
      const peak = readings.reduce(
        (most, reading) => (reading.diskBytes > most ? reading.diskBytes : most),
        0n,
      );
      if (Number(peak) >= ceiling) {
        await warnOnce(app, server, 'disk', {
          title: 'Server is running out of disk',
          message:
            `${server.name} is using ${percentOf(peak, server.diskLimit)}% of its ` +
            `${server.diskLimit} MiB. Uploads and world saves start failing at the limit — ` +
            'delete what it no longer needs, or give it more disk.',
          usedBytes: peak,
          limitMib: server.diskLimit,
        });
      }
    }
  }
}

function percentOf(usedBytes: bigint, limitMib: number): number {
  return Math.min(100, Math.round((Number(usedBytes) / (limitMib * MIB)) * 100));
}

/**
 * One warning per server per resource, then quiet for a while.
 *
 * A tick runs every minute and a server at its ceiling is still at its ceiling
 * the minute after. Without this the first thing an owner would learn is that
 * the panel sends three hundred notifications a night.
 */
async function warnOnce(
  app: FastifyInstance,
  server: { id: string; name: string; shortId: string; ownerId: string },
  resource: 'memory' | 'disk',
  detail: { title: string; message: string; usedBytes: bigint; limitMib: number },
): Promise<void> {
  const key = `storm:ceiling-warned:${server.id}:${resource}`;
  const first = await app.redis.set(key, '1', 'EX', CEILING_COOLDOWN_SECONDS, 'NX');
  if (!first) return;

  await app.notifications.push(server.ownerId, {
    type: NotificationType.SERVER_RESOURCE_WARNING,
    title: detail.title,
    message: detail.message,
    level: 'WARNING',
    link: `/servers/${server.shortId}`,
    metadata: { serverId: server.id, resource },
  });
  await app.webhooks.dispatch(WebhookEvent.SERVER_RESOURCE_WARNING, {
    serverId: server.id,
    name: server.name,
    resource,
    usedBytes: Number(detail.usedBytes),
    limitMib: detail.limitMib,
  });
  app.log.info({ serverId: server.id, resource }, 'warned an owner about a resource ceiling');
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
          await app.storage.removeArchive(storage, {
            node: backup.server.node,
            serverUuid: backup.server.uuid,
            backupUuid: backup.uuid,
            key: backup.storageKey,
          });
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
