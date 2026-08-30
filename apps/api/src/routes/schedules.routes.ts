import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { Permission, createScheduleSchema, updateScheduleSchema } from '@storm/types';
import { body, params } from '../lib/validation.js';
import { ok } from '../lib/response.js';
import { badRequest, notFound } from '../lib/errors.js';
import { ServerAccessService } from '../services/server-access.service.js';
import { toScheduleSummary } from '../lib/transformers.js';
import { describeCron, isValidCron, nextRunAt } from '../lib/cron.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const scheduleParam = idParam.extend({ scheduleId: z.string().min(1).max(64) });

const MAX_SCHEDULES_PER_SERVER = 20;

export default async function scheduleRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  app.get('/:id/schedules', { schema: { tags: ['Schedules'] } }, async (request) => {
    const user = request.currentUser();
    const { id } = params(request, idParam);
    const access = await app.serverAccess.require(user, id, Permission.SERVERS_SCHEDULES);

    const schedules = await app.prisma.schedule.findMany({
      where: { serverId: access.server.id },
      include: { tasks: { orderBy: { sequence: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    });

    return ok(
      schedules.map((schedule) => ({
        ...toScheduleSummary(schedule),
        description: describeCron(schedule),
      })),
    );
  });

  app.post('/:id/schedules', { schema: { tags: ['Schedules'], summary: 'Create a schedule' } }, async (request, reply) => {
    const user = request.currentUser();
    const { id } = params(request, idParam);
    const input = body(request, createScheduleSchema);
    const access = await app.serverAccess.require(user, id, Permission.SERVERS_SCHEDULES_MANAGE);
    ServerAccessService.assertNotSuspended(access);

    const count = await app.prisma.schedule.count({ where: { serverId: access.server.id } });
    if (count >= MAX_SCHEDULES_PER_SERVER) {
      throw badRequest(`A server may have at most ${MAX_SCHEDULES_PER_SERVER} schedules`);
    }
    if (!isValidCron(input)) throw badRequest('That cron expression is not valid');

    const schedule = await app.prisma.schedule.create({
      data: {
        serverId: access.server.id,
        name: input.name,
        cronMinute: input.cronMinute,
        cronHour: input.cronHour,
        cronDayOfMonth: input.cronDayOfMonth,
        cronMonth: input.cronMonth,
        cronDayOfWeek: input.cronDayOfWeek,
        timezone: input.timezone,
        isActive: input.isActive,
        onlyWhenOnline: input.onlyWhenOnline,
        nextRunAt: nextRunAt(input),
        tasks: {
          create: input.tasks.map((task, index) => ({
            action: task.action,
            payload: task.payload,
            timeOffsetSec: task.timeOffsetSec,
            sequence: index,
            continueOnFailure: task.continueOnFailure,
          })),
        },
      },
      include: { tasks: { orderBy: { sequence: 'asc' } } },
    });

    await app.audit.activity(request, {
      serverId: access.server.id,
      event: 'schedule:created',
      metadata: { scheduleId: schedule.id, name: schedule.name },
    });

    return reply.status(201).send(ok(toScheduleSummary(schedule)));
  });

  app.patch('/:id/schedules/:scheduleId', { schema: { tags: ['Schedules'] } }, async (request) => {
    const user = request.currentUser();
    const { id, scheduleId } = params(request, scheduleParam);
    const input = body(request, updateScheduleSchema);
    const access = await app.serverAccess.require(user, id, Permission.SERVERS_SCHEDULES_MANAGE);

    const existing = await app.prisma.schedule.findFirst({
      where: { id: scheduleId, serverId: access.server.id },
    });
    if (!existing) throw notFound('Schedule was not found');

    const cron = {
      cronMinute: input.cronMinute ?? existing.cronMinute,
      cronHour: input.cronHour ?? existing.cronHour,
      cronDayOfMonth: input.cronDayOfMonth ?? existing.cronDayOfMonth,
      cronMonth: input.cronMonth ?? existing.cronMonth,
      cronDayOfWeek: input.cronDayOfWeek ?? existing.cronDayOfWeek,
      timezone: input.timezone ?? existing.timezone,
    };
    if (!isValidCron(cron)) throw badRequest('That cron expression is not valid');

    const schedule = await app.prisma.$transaction(async (tx) => {
      if (input.tasks) {
        await tx.scheduleTask.deleteMany({ where: { scheduleId } });
        await tx.scheduleTask.createMany({
          data: input.tasks.map((task, index) => ({
            scheduleId,
            action: task.action,
            payload: task.payload,
            timeOffsetSec: task.timeOffsetSec,
            sequence: index,
            continueOnFailure: task.continueOnFailure,
          })),
        });
      }
      return tx.schedule.update({
        where: { id: scheduleId },
        data: {
          ...(input.name ? { name: input.name } : {}),
          ...cron,
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          ...(input.onlyWhenOnline !== undefined ? { onlyWhenOnline: input.onlyWhenOnline } : {}),
          nextRunAt: nextRunAt(cron),
          isProcessing: false,
        },
        include: { tasks: { orderBy: { sequence: 'asc' } } },
      });
    });

    await app.audit.activity(request, {
      serverId: access.server.id,
      event: 'schedule:updated',
      metadata: { scheduleId },
    });
    return ok(toScheduleSummary(schedule));
  });

  app.post('/:id/schedules/:scheduleId/run', { schema: { tags: ['Schedules'], summary: 'Run a schedule now' } }, async (request) => {
    const user = request.currentUser();
    const { id, scheduleId } = params(request, scheduleParam);
    const access = await app.serverAccess.require(user, id, Permission.SERVERS_SCHEDULES_MANAGE);
    ServerAccessService.assertNotSuspended(access);

    const schedule = await app.prisma.schedule.findFirst({
      where: { id: scheduleId, serverId: access.server.id },
    });
    if (!schedule) throw notFound('Schedule was not found');

    await app.queues.enqueueSchedule(scheduleId);
    await app.audit.activity(request, {
      serverId: access.server.id,
      event: 'schedule:manual_run',
      metadata: { scheduleId },
    });
    return ok({ queued: true });
  });

  app.delete('/:id/schedules/:scheduleId', { schema: { tags: ['Schedules'] } }, async (request) => {
    const user = request.currentUser();
    const { id, scheduleId } = params(request, scheduleParam);
    const access = await app.serverAccess.require(user, id, Permission.SERVERS_SCHEDULES_MANAGE);

    const deleted = await app.prisma.schedule.deleteMany({
      where: { id: scheduleId, serverId: access.server.id },
    });
    if (deleted.count === 0) throw notFound('Schedule was not found');

    await app.audit.activity(request, {
      serverId: access.server.id,
      event: 'schedule:deleted',
      metadata: { scheduleId },
    });
    return ok({ deleted: true });
  });
}
