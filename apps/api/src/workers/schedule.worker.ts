import { Worker } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { QUEUE_NAMES } from '@storm/config';
import { NotificationType, ScheduleAction, ServerStatus } from '@storm/types';
import type { Prisma } from '@storm/database';
import type { ScheduleJobData } from '../plugins/queues.js';
import { nextRunAt } from '../lib/cron.js';
import { concurrency } from './concurrency.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const SCHEDULE_INCLUDE = {
  server: true,
  tasks: { orderBy: { sequence: 'asc' } },
} satisfies Prisma.ScheduleInclude;

type ScheduleRun = Prisma.ScheduleGetPayload<{ include: typeof SCHEDULE_INCLUDE }>;

/**
 * Executes the tasks of one schedule in sequence, honouring each task's time
 * offset. A failing task aborts the run unless it is marked continueOnFailure.
 */
export function createScheduleWorker(app: FastifyInstance): Worker<ScheduleJobData> {
  return new Worker<ScheduleJobData>(
    QUEUE_NAMES.schedules,
    async (job) => {
      await runSchedule(app, job.data.scheduleId);
    },
    { connection: { url: app.env.REDIS_URL }, concurrency: concurrency(app, 5) },
  );
}

/** Exported so a test can drive one run directly; the worker is its only caller. */
export async function runSchedule(app: FastifyInstance, scheduleId: string): Promise<void> {
  const schedule = await app.prisma.schedule.findUnique({
    where: { id: scheduleId },
    include: SCHEDULE_INCLUDE,
  });
  // Deleting the schedule takes its claim with it; there is nothing to release.
  if (!schedule) return;

  try {
    await execute(app, schedule);
  } finally {
    // The claim taken when this schedule was dispatched has to come back on
    // every way out of here, not only the one where every task ran. It used to
    // be released in that branch alone, so a night skipped because the server
    // was off, a schedule paused between the claim and the run, or anything
    // thrown left the claim standing — and a claimed schedule is filtered out
    // of every later tick. The schedule still read "active" in the panel, with
    // a next run in the past, and never fired again.
    await releaseClaim(app, schedule.id);
  }
}

/** Gives back the claim, whatever happened to the run that held it. */
async function releaseClaim(app: FastifyInstance, scheduleId: string): Promise<void> {
  try {
    // updateMany, so a schedule deleted during its own run is a no-op rather
    // than an error thrown out of a finally block, on top of a real one.
    await app.prisma.schedule.updateMany({
      where: { id: scheduleId },
      data: { isProcessing: false, claimedAt: null },
    });
  } catch (error) {
    app.log.error({ err: error, scheduleId }, 'could not release the schedule claim');
  }
}

async function execute(app: FastifyInstance, schedule: ScheduleRun): Promise<void> {
  if (!schedule.isActive) return;

  const { server } = schedule;

  if (server.suspendedAt) {
    app.log.info({ scheduleId: schedule.id }, 'skipping schedule for suspended server');
    return;
  }
  if (schedule.onlyWhenOnline && server.status !== ServerStatus.ONLINE) {
    await app.prisma.schedule.update({
      where: { id: schedule.id },
      data: { lastRunAt: new Date(), nextRunAt: nextRunAt(schedule) },
    });
    return;
  }

  let failure: string | null = null;

  for (const task of schedule.tasks) {
    if (task.timeOffsetSec > 0) await sleep(task.timeOffsetSec * 1000);

    try {
      await runTask(app, schedule.serverId, task.action, task.payload, schedule.name);
      await app.prisma.scheduleTask.update({
        where: { id: task.id },
        data: { lastRunAt: new Date(), lastError: null },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failure = message;
      await app.prisma.scheduleTask.update({
        where: { id: task.id },
        data: { lastRunAt: new Date(), lastError: message.slice(0, 500) },
      });
      app.log.warn({ err: error, taskId: task.id }, 'scheduled task failed');
      if (!task.continueOnFailure) break;
    }
  }

  await app.prisma.schedule.update({
    where: { id: schedule.id },
    data: {
      lastRunAt: new Date(),
      nextRunAt: nextRunAt(schedule),
      lastError: failure?.slice(0, 500) ?? null,
    },
  });

  await app.audit.system({
    action: 'schedule.executed',
    targetType: 'schedule',
    targetId: schedule.id,
    targetLabel: schedule.name,
    metadata: { serverId: schedule.serverId, failed: Boolean(failure) },
  });

  if (failure) {
    await app.notifications.push(server.ownerId, {
      type: NotificationType.SCHEDULE_FAILED,
      title: 'Schedule failed',
      message: `Schedule "${schedule.name}" on ${server.name} failed: ${failure.slice(0, 160)}`,
      level: 'ERROR',
      link: `/servers/${server.shortId}/schedules`,
    });
  }
}

async function runTask(
  app: FastifyInstance,
  serverId: string,
  action: string,
  payload: string,
  scheduleName: string,
): Promise<void> {
  switch (action) {
    case ScheduleAction.POWER_START:
      await app.servers.sendPower(serverId, 'start');
      break;
    case ScheduleAction.POWER_STOP:
      await app.servers.sendPower(serverId, 'stop');
      break;
    case ScheduleAction.POWER_RESTART:
      await app.servers.sendPower(serverId, 'restart');
      break;
    case ScheduleAction.POWER_KILL:
      await app.servers.sendPower(serverId, 'kill');
      break;
    case ScheduleAction.COMMAND: {
      const server = await app.servers.findWithRelations(serverId);
      await app.agents.request(server.node, `/api/v1/servers/${server.uuid}/command`, {
        method: 'POST',
        body: { command: payload },
      });
      break;
    }
    case ScheduleAction.BACKUP: {
      // Not for the record it returns — it throws if the server was deleted
      // between the schedule being written and this run, which is the check
      // we want before writing a backup row for it.
      await app.servers.findWithRelations(serverId);
      const storage = await app.prisma.backupStorage.findFirst({
        where: { isActive: true },
        orderBy: { isDefault: 'desc' },
      });
      if (!storage) throw new Error('No active backup storage is configured');

      const backup = await app.prisma.backup.create({
        data: {
          serverId,
          storageId: storage.id,
          name:
            payload ||
            `${scheduleName} — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
          isAutomatic: true,
        },
      });
      await app.queues.enqueueBackup(backup.id);
      break;
    }
    case ScheduleAction.NOTIFY: {
      const server = await app.servers.findWithRelations(serverId);
      await app.notifications.push(server.ownerId, {
        type: NotificationType.GENERIC,
        title: `Schedule: ${scheduleName}`,
        message: payload || `Schedule "${scheduleName}" ran on ${server.name}.`,
        level: 'INFO',
        link: `/servers/${server.shortId}/schedules`,
      });
      break;
    }
    default:
      throw new Error(`Unknown schedule action: ${action}`);
  }
}
