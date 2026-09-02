import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ScheduleAction, ServerStatus } from '@storm/types';
import { dispatchDueSchedules } from '../src/workers/maintenance.worker.js';
import { runSchedule } from '../src/workers/schedule.worker.js';
import { nextRunAt, describeCron, isValidCron } from '../src/lib/cron.js';
import { createTestApp, deleteUser, registerUser, uniqueSuffix } from './helpers.js';
import type { RegisteredUser } from './helpers.js';

/**
 * Schedules that stop firing and never say so.
 *
 * A due schedule is claimed before it is queued — `isProcessing` — so two API
 * replicas ticking the same minute cannot dispatch it twice. The claim was
 * released in exactly one place: the end of a completed run. Every other way
 * out kept it forever, and a schedule holding a claim is filtered out of every
 * later tick.
 *
 * The paths that leaked it are the ordinary ones. `onlyWhenOnline` is the flag
 * you set on a nightly backup so it does not run against a stopped server: the
 * first night the server happened to be off, the schedule was claimed, skipped,
 * and never ran again. Same for a suspended server, a schedule paused while it
 * was in flight, and a panel restarted between the claim and the run — which
 * the update button does on purpose.
 *
 * Nothing surfaced any of it. The schedule still reads "active" in the panel
 * with a next run in the past, and backups simply stop.
 */
describe('schedules: dispatch, claims and cron', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let customer: RegisteredUser;
  let serverId: string;
  let nodeId: string;
  let scheduleId: string;
  const createdUsers: string[] = [];
  /** Ids handed to the queue, instead of real jobs nothing here would consume. */
  let dispatched: string[] = [];

  const read = () => app.prisma.schedule.findUniqueOrThrow({ where: { id: scheduleId } });

  async function setSchedule(data: Record<string, unknown>): Promise<void> {
    await app.prisma.schedule.update({ where: { id: scheduleId }, data });
  }

  async function setServer(data: Record<string, unknown>): Promise<void> {
    await app.prisma.server.update({ where: { id: serverId }, data });
  }

  /** A tick, reporting only what it decided to queue. */
  async function tick(): Promise<string[]> {
    dispatched = [];
    await dispatchDueSchedules(app);
    return dispatched;
  }

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;

    // Real jobs would sit in the developer's queue forever; what matters here
    // is which schedules a tick decides are due.
    app.queues.enqueueSchedule = async (id: string) => {
      dispatched.push(id);
    };

    customer = await registerUser(app);
    createdUsers.push(customer.id);
    const suffix = uniqueSuffix();

    const node = await app.prisma.node.create({
      data: {
        name: `schedule-node-${suffix}`,
        location: 'Test',
        hostname: '127.0.0.1',
        ip: '127.0.0.1',
        scheme: 'http',
        memoryTotal: 4096,
        diskTotal: 20480,
      },
    });
    nodeId = node.id;

    const template = await app.prisma.gameTemplate.findFirstOrThrow({
      where: { slug: 'minecraft-java' },
    });
    const server = await app.prisma.server.create({
      data: {
        name: 'Schedule server',
        shortId: uniqueSuffix().slice(0, 8),
        ownerId: customer.id,
        nodeId,
        templateId: template.id,
        dockerImage: 'alpine',
        startupCommand: 'true',
        sftpUsername: `sched_${suffix}`,
        sftpPasswordEnc: 'not-a-real-secret',
        status: ServerStatus.OFFLINE,
      },
    });
    serverId = server.id;

    const schedule = await app.prisma.schedule.create({
      data: {
        serverId,
        name: 'Nightly backup',
        cronMinute: '0',
        cronHour: '3',
        timezone: 'UTC',
        // A notification, so a run touches nothing outside the panel.
        tasks: { create: [{ action: ScheduleAction.NOTIFY, payload: 'ran', sequence: 0 }] },
      },
    });
    scheduleId = schedule.id;
  });

  after(async () => {
    await app.prisma.schedule.deleteMany({ where: { serverId } });
    await app.prisma.server.deleteMany({ where: { nodeId } });
    await app.prisma.node.delete({ where: { id: nodeId } }).catch(() => undefined);
    for (const id of createdUsers) await deleteUser(app, id);
    await cleanup();
  });

  beforeEach(async () => {
    dispatched = [];
    // Due a minute ago, unclaimed, active, and the server stopped.
    await setSchedule({
      isActive: true,
      isProcessing: false,
      onlyWhenOnline: false,
      nextRunAt: new Date(Date.now() - 60_000),
      lastError: null,
    });
    await setServer({ status: ServerStatus.OFFLINE, suspendedAt: null });
  });

  /* ------------------------------------------------------- claim and release -- */

  it('claims a due schedule once, however many ticks run', async () => {
    assert.deepEqual(await tick(), [scheduleId], 'the first tick should dispatch it');
    assert.equal((await read()).isProcessing, true, 'and hold the claim while it runs');
    assert.deepEqual(await tick(), [], 'a second tick must not dispatch it again');
  });

  it('runs again after a night the server was offline', async () => {
    // The reason onlyWhenOnline exists: a nightly backup that skips itself
    // when the server is stopped. The skip must not be permanent.
    await setSchedule({ onlyWhenOnline: true });

    assert.deepEqual(await tick(), [scheduleId]);
    await runSchedule(app, scheduleId);

    assert.equal((await read()).isProcessing, false, 'the skipped run kept its claim');

    await setServer({ status: ServerStatus.ONLINE });
    await setSchedule({ nextRunAt: new Date(Date.now() - 60_000) });
    assert.deepEqual(await tick(), [scheduleId], 'the schedule never ran again');
  });

  it('runs again after the server comes back from suspension', async () => {
    await setServer({ suspendedAt: new Date() });

    assert.deepEqual(await tick(), [scheduleId]);
    await runSchedule(app, scheduleId);
    assert.equal((await read()).isProcessing, false, 'the skipped run kept its claim');

    await setServer({ suspendedAt: null });
    await setSchedule({ nextRunAt: new Date(Date.now() - 60_000) });
    assert.deepEqual(await tick(), [scheduleId]);
  });

  it('runs again after being paused and resumed mid-flight', async () => {
    assert.deepEqual(await tick(), [scheduleId]);
    // Paused in the panel between the claim and the run, which is a click.
    await setSchedule({ isActive: false });
    await runSchedule(app, scheduleId);

    await setSchedule({ isActive: true, nextRunAt: new Date(Date.now() - 60_000) });
    assert.deepEqual(await tick(), [scheduleId], 'resuming it left it claimed forever');
  });

  it('releases the claim when the run itself fails', async () => {
    assert.deepEqual(await tick(), [scheduleId]);

    // A database that blinks while the run is recording a task. Anything
    // thrown between the claim and the end of the run took the claim with it,
    // and the queue does not retry a schedule (attempts: 1) — so this is one
    // failed night followed by silence.
    const update = app.prisma.scheduleTask.update;
    app.prisma.scheduleTask.update = (() => {
      throw new Error('connection terminated unexpectedly');
    }) as typeof update;
    try {
      await assert.rejects(runSchedule(app, scheduleId));
    } finally {
      app.prisma.scheduleTask.update = update;
    }

    assert.equal((await read()).isProcessing, false, 'a failed run kept the claim');
  });

  it('completes an ordinary run and books the next one', async () => {
    assert.deepEqual(await tick(), [scheduleId]);
    await runSchedule(app, scheduleId);

    const after = await read();
    assert.equal(after.isProcessing, false);
    assert.equal(after.lastError, null);
    assert.ok(after.lastRunAt, 'a completed run should be recorded');
    assert.ok(after.nextRunAt && after.nextRunAt > new Date(), 'the next run is in the past');
  });

  /* ------------------------------------------------------------ lost claims -- */

  it('recovers a schedule whose run was lost to a restart', async () => {
    // The panel's own update button restarts the API. A schedule claimed in
    // that second has no run coming and nothing to release it.
    assert.deepEqual(await tick(), [scheduleId]);
    await setSchedule({ claimedAt: new Date(Date.now() - 30 * 60_000) });

    assert.deepEqual(await tick(), [scheduleId], 'the lost claim was never released');
  });

  it('leaves a long run alone until its own tasks could have finished', async () => {
    // "Stop, wait half an hour, start" is a legitimate schedule. Reclaiming on
    // a fixed timeout would run it a second time on top of the first.
    const slow = await app.prisma.schedule.create({
      data: {
        serverId,
        name: 'Slow maintenance window',
        nextRunAt: new Date(Date.now() - 60_000),
        isProcessing: true,
        claimedAt: new Date(Date.now() - 20 * 60_000),
        tasks: {
          create: [
            { action: ScheduleAction.POWER_STOP, sequence: 0 },
            { action: ScheduleAction.POWER_START, sequence: 1, timeOffsetSec: 1800 },
          ],
        },
      },
    });

    try {
      dispatched = [];
      await dispatchDueSchedules(app);
      assert.ok(!dispatched.includes(slow.id), 'reclaimed a run that is still going');

      await app.prisma.schedule.update({
        where: { id: slow.id },
        data: { claimedAt: new Date(Date.now() - 120 * 60_000) },
      });
      dispatched = [];
      await dispatchDueSchedules(app);
      assert.ok(dispatched.includes(slow.id), 'never reclaimed it either');
    } finally {
      await app.prisma.schedule.delete({ where: { id: slow.id } }).catch(() => undefined);
    }
  });

  it('does not hand out a second run because the schedule was edited', async () => {
    // Editing a schedule used to clear the claim, which was the only way out
    // of a stuck one. Now that a run always gives its claim back, clearing it
    // from here only means a tick can start the schedule again on top of the
    // run already going.
    assert.deepEqual(await tick(), [scheduleId]);
    const server = await app.prisma.server.findUniqueOrThrow({ where: { id: serverId } });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/servers/${server.shortId}/schedules/${scheduleId}`,
      headers: { authorization: `Bearer ${customer.accessToken}` },
      payload: { name: 'Nightly backup (renamed)' },
    });
    assert.equal(response.statusCode, 200, response.body);

    await setSchedule({ nextRunAt: new Date(Date.now() - 60_000) });
    assert.deepEqual(await tick(), [], 'the run in flight was dispatched a second time');
  });

  it('says in the listing which schedule is running right now', async () => {
    // Without this the panel offers "Run now" on a schedule that is already
    // running, and the 409 it gets back has nothing on screen to explain it.
    const server = await app.prisma.server.findUniqueOrThrow({ where: { id: serverId } });
    const list = async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/servers/${server.shortId}/schedules`,
        headers: { authorization: `Bearer ${customer.accessToken}` },
      });
      assert.equal(response.statusCode, 200, response.body);
      const rows = response.json<{ data: { id: string; isRunning: boolean }[] }>().data;
      return rows.find((row) => row.id === scheduleId);
    };

    assert.equal((await list())?.isRunning, false, 'idle but reported as running');
    await tick();
    assert.equal((await list())?.isRunning, true, 'running but reported as idle');
    await runSchedule(app, scheduleId);
    assert.equal((await list())?.isRunning, false, 'still reported as running after the run');
  });

  /* ----------------------------------------------------------------- run now -- */

  it('refuses "run now" on a paused schedule instead of reporting success', async () => {
    await setSchedule({ isActive: false });
    const server = await app.prisma.server.findUniqueOrThrow({ where: { id: serverId } });

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${server.shortId}/schedules/${scheduleId}/run`,
      headers: { authorization: `Bearer ${customer.accessToken}` },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.deepEqual(dispatched, [], 'a paused schedule was queued anyway');
  });

  it('starts one run when the button is pressed twice at once', async () => {
    // A double click, or two people on the same server. Both requests read the
    // schedule as idle before either has written anything, so the claim has to
    // be a compare-and-swap rather than a read followed by a write.
    const server = await app.prisma.server.findUniqueOrThrow({ where: { id: serverId } });
    const run = () =>
      app.inject({
        method: 'POST',
        url: `/api/v1/servers/${server.shortId}/schedules/${scheduleId}/run`,
        headers: { authorization: `Bearer ${customer.accessToken}` },
      });

    const [a, b] = await Promise.all([run(), run()]);
    assert.deepEqual(
      [a.statusCode, b.statusCode].sort(),
      [200, 409],
      `${a.statusCode}/${b.statusCode}: ${a.body} ${b.body}`,
    );
    assert.deepEqual(dispatched, [scheduleId], 'the schedule was queued twice');
  });

  it('refuses "run now" while the schedule is already running', async () => {
    await setSchedule({ isProcessing: true, claimedAt: new Date() });
    const server = await app.prisma.server.findUniqueOrThrow({ where: { id: serverId } });

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${server.shortId}/schedules/${scheduleId}/run`,
      headers: { authorization: `Bearer ${customer.accessToken}` },
    });
    assert.equal(response.statusCode, 409, response.body);
  });
});

/**
 * The cron expression itself, which decides whether anything above ever runs.
 *
 * A schedule is stored as five fields and a timezone. Getting the timezone
 * wrong is invisible: the schedule fires, just at the wrong hour, and an hour
 * either way looks like nothing until it is the hour your players are on.
 */
describe('cron expressions', () => {
  const at = (parts: Record<string, string>) => ({
    cronMinute: '0',
    cronHour: '*',
    cronDayOfMonth: '*',
    cronMonth: '*',
    cronDayOfWeek: '*',
    timezone: 'UTC',
    ...parts,
  });

  it('fires at the wall-clock hour of the schedule, not the panel', () => {
    // 03:00 in Berlin is 01:00 UTC in summer and 02:00 UTC in winter. A panel
    // that ignored the timezone would give the same UTC hour for both.
    const berlin = at({ cronHour: '3', timezone: 'Europe/Berlin' });
    const summer = nextRunAt(berlin, new Date('2026-07-01T00:00:00Z'));
    const winter = nextRunAt(berlin, new Date('2026-01-01T00:00:00Z'));

    assert.equal(summer?.toISOString(), '2026-07-01T01:00:00.000Z');
    assert.equal(winter?.toISOString(), '2026-01-01T02:00:00.000Z');
  });

  it('picks the next occurrence, never one already past', () => {
    const from = new Date('2026-03-10T04:30:00Z');
    const next = nextRunAt(at({ cronHour: '3' }), from);
    assert.ok(next && next > from, `${next?.toISOString()} is not after ${from.toISOString()}`);
    assert.equal(next?.toISOString(), '2026-03-11T03:00:00.000Z');
  });

  it('reports an unusable expression rather than guessing at one', () => {
    for (const parts of [
      at({ cronMinute: '61' }),
      at({ cronHour: 'noon' }),
      at({ cronDayOfMonth: '32' }),
      at({ cronMonth: '13' }),
      at({ timezone: 'Mars/Olympus_Mons' }),
    ]) {
      assert.equal(isValidCron(parts), false, JSON.stringify(parts));
      assert.equal(nextRunAt(parts), null);
    }
  });

  it('describes a schedule the way its owner set it', () => {
    assert.equal(describeCron(at({ cronMinute: '*/15' })), 'Every 15 minutes');
    assert.equal(describeCron(at({ cronMinute: '30', cronHour: '4' })), 'Daily at 04:30');
    assert.equal(
      describeCron(at({ cronMinute: '0', cronHour: '6', cronDayOfWeek: '1' })),
      'Every Monday at 06:00',
    );
  });
});
