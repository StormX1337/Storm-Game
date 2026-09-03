import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { NotificationType, ServerStatus, WebhookEvent } from '@storm/types';
import { warnAboutCeilings } from '../src/workers/maintenance.worker.js';
import { createTestApp, deleteUser, registerUser, uniqueSuffix } from './helpers.js';
import type { RegisteredUser } from './helpers.js';

const MIB = 1024 * 1024;

/**
 * Telling an owner their server is about to die, rather than that it did.
 *
 * The panel already reports both failures after the fact — a crash
 * notification that names an out-of-memory kill, and a file manager that
 * refuses a write past the disk limit. The minute-by-minute stats that would
 * have seen either coming were written, charted, pruned, and never read.
 *
 * Memory is judged across a window because a Java server touching its ceiling
 * for one minute during world generation is not news; sitting there is. Disk
 * is judged on the high-water mark, because it does not fall on its own.
 */
describe('warning before the ceiling', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let customer: RegisteredUser;
  let serverId: string;
  let nodeId: string;
  const createdUsers: string[] = [];
  /** Events the dispatcher was handed, instead of real deliveries. */
  let dispatched: { event: string; payload: Record<string, unknown> }[] = [];

  const MEMORY_MIB = 2048;
  const DISK_MIB = 10240;

  /** Writes `count` readings a minute apart, newest first. */
  async function record(count: number, memoryMib: number, diskMib: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      await app.prisma.serverStat.create({
        data: {
          serverId,
          cpuPercent: 50,
          memoryBytes: BigInt(Math.round(memoryMib * MIB)),
          diskBytes: BigInt(Math.round(diskMib * MIB)),
          createdAt: new Date(Date.now() - index * 60_000),
        },
      });
    }
  }

  async function warnings(): Promise<{ title: string; message: string }[]> {
    return app.prisma.notification.findMany({
      where: { userId: customer.id, type: NotificationType.SERVER_RESOURCE_WARNING },
      select: { title: true, message: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;

    // Recorded rather than delivered: what matters here is that the event is
    // raised at all, and a real dispatch would reach a developer's webhooks.
    app.webhooks.dispatch = (async (event: string, payload: Record<string, unknown>) => {
      dispatched.push({ event, payload });
    }) as typeof app.webhooks.dispatch;

    customer = await registerUser(app);
    createdUsers.push(customer.id);
    const suffix = uniqueSuffix();

    const node = await app.prisma.node.create({
      data: {
        name: `ceiling-node-${suffix}`,
        location: 'Test',
        hostname: '127.0.0.1',
        ip: '127.0.0.1',
        scheme: 'http',
        memoryTotal: 8192,
        diskTotal: 51200,
      },
    });
    nodeId = node.id;

    const template = await app.prisma.gameTemplate.findFirstOrThrow({
      where: { slug: 'minecraft-java' },
    });
    const server = await app.prisma.server.create({
      data: {
        name: 'Survival',
        shortId: uniqueSuffix().slice(0, 8),
        ownerId: customer.id,
        nodeId,
        templateId: template.id,
        dockerImage: 'alpine',
        startupCommand: 'true',
        sftpUsername: `ceil_${suffix}`,
        sftpPasswordEnc: 'not-a-real-secret',
        status: ServerStatus.ONLINE,
        memoryLimit: MEMORY_MIB,
        diskLimit: DISK_MIB,
      },
    });
    serverId = server.id;
  });

  after(async () => {
    await app.prisma.serverStat.deleteMany({ where: { serverId } });
    await app.prisma.server.deleteMany({ where: { nodeId } });
    await app.prisma.node.delete({ where: { id: nodeId } }).catch(() => undefined);
    for (const id of createdUsers) await deleteUser(app, id);
    await cleanup();
  });

  beforeEach(async () => {
    dispatched = [];
    await app.prisma.serverStat.deleteMany({ where: { serverId } });
    await app.prisma.notification.deleteMany({ where: { userId: customer.id } });
    await app.redis.del(`storm:ceiling-warned:${serverId}:memory`);
    await app.redis.del(`storm:ceiling-warned:${serverId}:disk`);
    await app.prisma.server.update({
      where: { id: serverId },
      data: {
        status: ServerStatus.ONLINE,
        suspendedAt: null,
        memoryLimit: MEMORY_MIB,
        diskLimit: DISK_MIB,
      },
    });
  });

  it('says so when a server has been sitting at its memory ceiling', async () => {
    // 95% of 2048 MiB, five minutes running. The next thing that happens to a
    // server here is the kernel killing it.
    await record(5, MEMORY_MIB * 0.95, 100);
    await warnAboutCeilings(app);

    const [warning, ...rest] = await warnings();
    assert.ok(warning, 'nothing was said');
    assert.deepEqual(rest, [], 'one ceiling, one warning');
    assert.match(warning.title, /memory/i);
    // The numbers an owner needs to act: how much of what.
    assert.match(warning.message, /95%/);
    assert.match(warning.message, new RegExp(`${MEMORY_MIB} MiB`));
    assert.match(warning.message, /Survival/);

    assert.deepEqual(
      dispatched.map((entry) => entry.event),
      [WebhookEvent.SERVER_RESOURCE_WARNING],
    );
    assert.equal(dispatched[0]?.payload.resource, 'memory');
  });

  it('ignores a server that touches the ceiling and comes back down', async () => {
    // World generation pins the heap for a minute. That is a game server
    // working, and a panel that says so every time trains its owner to ignore
    // it — which is the failure mode that matters.
    await record(1, MEMORY_MIB * 0.98, 100);
    await record(1, MEMORY_MIB * 0.4, 100);
    await record(3, MEMORY_MIB * 0.5, 100);

    await warnAboutCeilings(app);
    assert.deepEqual(await warnings(), []);
  });

  it('waits for enough readings before judging', async () => {
    // A server that started thirty seconds ago has one reading. One reading is
    // not a trend, and warning on it would fire on every restart.
    await record(2, MEMORY_MIB * 0.99, 100);

    await warnAboutCeilings(app);
    assert.deepEqual(await warnings(), []);
  });

  it('says so when the disk is nearly full', async () => {
    // Disk is judged on the peak, not on every reading: it does not come back
    // down on its own, and the write that fails is the one at the top.
    await record(3, 100, DISK_MIB * 0.4);
    await record(1, 100, DISK_MIB * 0.93);

    await warnAboutCeilings(app);

    const [warning] = await warnings();
    assert.ok(warning, 'nothing was said');
    assert.match(warning.title, /disk/i);
    assert.match(warning.message, /93%/);
    assert.equal(dispatched[0]?.payload.resource, 'disk');
  });

  it('says both when both are running out', async () => {
    await record(5, MEMORY_MIB * 0.97, DISK_MIB * 0.97);
    await warnAboutCeilings(app);

    const titles = (await warnings()).map((warning) => warning.title).sort();
    assert.equal(titles.length, 2, JSON.stringify(titles));
    assert.match(titles.join(' '), /memory/i);
    assert.match(titles.join(' '), /disk/i);
  });

  it('says it once, not once a minute', async () => {
    // The tick runs every minute and a server at its ceiling is still at its
    // ceiling the minute after. Without a cooldown the first thing the owner
    // learns is that the panel sends three hundred notifications a night.
    await record(5, MEMORY_MIB * 0.95, 100);

    for (let tick = 0; tick < 4; tick += 1) await warnAboutCeilings(app);

    assert.equal((await warnings()).length, 1, 'the owner was told more than once');
    assert.equal(dispatched.length, 1);
  });

  it('says nothing about a server with no ceiling to hit', async () => {
    // Zero means unlimited everywhere else in the panel, so there is no
    // percentage to be at.
    await app.prisma.server.update({
      where: { id: serverId },
      data: { memoryLimit: 0, diskLimit: 0 },
    });
    await record(5, 64 * 1024, 400 * 1024);

    await warnAboutCeilings(app);
    assert.deepEqual(await warnings(), []);
  });

  it('warns about the ceiling that exists and not the one that does not', async () => {
    // Sold unmetered memory on a metered disk. Nought means unlimited, and a
    // percentage of nought is not a number to put in front of a customer.
    await app.prisma.server.update({ where: { id: serverId }, data: { memoryLimit: 0 } });
    await record(5, 16 * 1024, DISK_MIB * 0.94);

    await warnAboutCeilings(app);

    const found = await warnings();
    assert.equal(found.length, 1, JSON.stringify(found.map((entry) => entry.title)));
    assert.match(found[0]?.title ?? '', /disk/i);
  });

  it('says nothing about a server that is off or suspended', async () => {
    await record(5, MEMORY_MIB * 0.99, DISK_MIB * 0.99);

    await app.prisma.server.update({
      where: { id: serverId },
      data: { status: ServerStatus.OFFLINE },
    });
    await warnAboutCeilings(app);
    assert.deepEqual(await warnings(), [], 'a stopped server is not using anything');

    await app.prisma.server.update({
      where: { id: serverId },
      data: { status: ServerStatus.ONLINE, suspendedAt: new Date() },
    });
    await warnAboutCeilings(app);
    assert.deepEqual(await warnings(), [], 'a suspended server has other news for its owner');
  });

  it('reads what is happening now, not what happened this morning', async () => {
    // The stats table keeps a week. A window that took all of it would warn
    // about a peak the owner already dealt with.
    await app.prisma.serverStat.create({
      data: {
        serverId,
        memoryBytes: BigInt(Math.round(MEMORY_MIB * 0.99 * MIB)),
        diskBytes: BigInt(Math.round(DISK_MIB * 0.99 * MIB)),
        createdAt: new Date(Date.now() - 6 * 3600_000),
      },
    });
    await record(5, MEMORY_MIB * 0.3, DISK_MIB * 0.3);

    await warnAboutCeilings(app);
    assert.deepEqual(await warnings(), []);
  });
});
