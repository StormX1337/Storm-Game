import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import { NodeStatus, NotificationType, Permission, ServerStatus } from '@storm/types';
import { VISIBILITY_TTL_MS } from '../src/ws/account-socket.js';
import { createTestApp, deleteUser, registerUser, uniqueSuffix } from './helpers.js';
import type { RegisteredUser } from './helpers.js';

/**
 * The account socket — the dashboard's live tiles and the notification bell.
 *
 * It is a fan-out: every status change and every resource sample on the panel
 * arrives on one Redis channel, and this decides who is allowed to see which.
 * That decision was made once, when the socket opened, and then cached without
 * an expiry — so what it really answered was "could this person see that
 * server at some point in the past".
 */
describe('the account socket', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let baseUrl: string;
  let owner: RegisteredUser;
  let helper: RegisteredUser;
  let admin: RegisteredUser;
  let serverId: string;
  let nodeId: string;
  const createdUsers: string[] = [];

  async function open(token: string | null): Promise<{
    socket: WebSocket;
    events: Record<string, unknown>[];
    closed: Promise<number>;
    settle: () => Promise<void>;
  }> {
    const query = token ? `?token=${encodeURIComponent(token)}` : '';
    const socket = new WebSocket(`${baseUrl}/api/v1/ws${query}`);
    const events: Record<string, unknown>[] = [];

    socket.on('message', (raw: Buffer) => {
      try {
        events.push(JSON.parse(raw.toString()) as Record<string, unknown>);
      } catch {
        /* not our problem here */
      }
    });

    const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });

    // Redis pub/sub is a round trip through another process; give it one.
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 250));
    await settle();
    return { socket, events, closed, settle };
  }

  /** Resolves what the promise resolves to, or 'timeout' if it takes too long. */
  const within = <T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> =>
    Promise.race([
      promise,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms)),
    ]);

  const statusEvents = (events: Record<string, unknown>[]) =>
    events.filter((event) => event.type === 'server:status');

  async function share(): Promise<void> {
    await app.prisma.serverSubuser.upsert({
      where: { serverId_userId: { serverId, userId: helper.id } },
      create: { serverId, userId: helper.id, permissions: [Permission.SERVERS_VIEW] },
      update: { permissions: [Permission.SERVERS_VIEW] },
    });
  }

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;
    baseUrl = (await app.listen({ port: 0, host: '127.0.0.1' })).replace('http://', 'ws://');

    owner = await registerUser(app);
    helper = await registerUser(app);
    admin = await registerUser(app);
    createdUsers.push(owner.id, helper.id, admin.id);

    const adminRole = await app.prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } });
    await app.prisma.user.update({ where: { id: admin.id }, data: { roleId: adminRole.id } });

    const suffix = uniqueSuffix();
    const node = await app.prisma.node.create({
      data: {
        name: `account-node-${suffix}`,
        location: 'Test',
        hostname: '127.0.0.1',
        ip: '127.0.0.1',
        scheme: 'http',
        memoryTotal: 8192,
        diskTotal: 51200,
        status: NodeStatus.ONLINE,
      },
    });
    nodeId = node.id;

    const template = await app.prisma.gameTemplate.findFirstOrThrow({
      where: { slug: 'minecraft-java' },
    });
    serverId = (
      await app.prisma.server.create({
        data: {
          name: 'Watched',
          shortId: uniqueSuffix().slice(0, 8),
          ownerId: owner.id,
          nodeId,
          templateId: template.id,
          dockerImage: 'alpine',
          startupCommand: 'true',
          sftpUsername: `acct_${suffix}`,
          sftpPasswordEnc: 'not-a-real-secret',
          status: ServerStatus.OFFLINE,
          installedAt: new Date(),
        },
      })
    ).id;
  });

  after(async () => {
    await app.prisma.serverSubuser.deleteMany({ where: { serverId } });
    await app.prisma.server.deleteMany({ where: { nodeId } });
    await app.prisma.node.delete({ where: { id: nodeId } }).catch(() => undefined);
    for (const id of createdUsers) await deleteUser(app, id);
    await cleanup();
  });

  beforeEach(async () => {
    await app.prisma.serverSubuser.deleteMany({ where: { serverId } });
    await app.prisma.user.update({ where: { id: helper.id }, data: { suspendedAt: null } });
  });

  /* ------------------------------------------------------- getting in -- */

  it('turns away a socket with no credentials on it', async () => {
    const { closed } = await open(null);
    assert.equal(await within(closed, 2000), 4401);
  });

  it('says hello to a signed-in account', async () => {
    const { socket, events } = await open(owner.accessToken);
    assert.equal(events[0]?.type, 'ready');
    assert.equal(events[0]?.userId, owner.id);
    socket.close();
  });

  /* --------------------------------------------------- who sees what -- */

  it('delivers a notification to the account it was addressed to', async () => {
    const { socket, events, settle } = await open(owner.accessToken);

    await app.notifications.push(owner.id, {
      type: NotificationType.GENERIC,
      title: 'For you',
      message: 'Only you.',
      level: 'INFO',
    });
    await settle();

    assert.ok(
      events.some((event) => event.type === 'notification'),
      JSON.stringify(events),
    );
    socket.close();
  });

  it('does not deliver somebody else’s notification', async () => {
    const { socket, events, settle } = await open(helper.accessToken);

    await app.notifications.push(owner.id, {
      type: NotificationType.GENERIC,
      title: 'Not for you',
      message: 'Someone else entirely.',
      level: 'INFO',
    });
    await settle();

    assert.deepEqual(
      events.filter((event) => event.type === 'notification'),
      [],
    );
    socket.close();
  });

  it('relays the status of a server that has been shared with them', async () => {
    await share();
    const { socket, events, settle } = await open(helper.accessToken);

    await app.notifications.broadcastServerStatus(serverId, owner.id, ServerStatus.ONLINE);
    await settle();

    assert.equal(statusEvents(events).length, 1, JSON.stringify(events));
    socket.close();
  });

  it('relays the status of a server the account owns outright', async () => {
    const { socket, events, settle } = await open(owner.accessToken);

    await app.notifications.broadcastServerStatus(serverId, owner.id, ServerStatus.ONLINE);
    await settle();

    assert.equal(statusEvents(events).length, 1, JSON.stringify(events));
    socket.close();
  });

  it('relays a server the account created after the socket opened', async () => {
    // The cached list is a snapshot, so a brand-new server is not in it — and
    // watching the dashboard while creating one is the most ordinary thing a
    // customer does. Their own servers do not wait on the next refresh.
    const { socket, events, settle } = await open(owner.accessToken);

    // Warm the snapshot first, so the new server is genuinely missing from it
    // rather than being picked up by the refresh this test would otherwise
    // trigger. Inside the TTL from here on.
    await app.notifications.broadcastServerStatus(serverId, owner.id, ServerStatus.ONLINE);
    await settle();
    assert.equal(statusEvents(events).length, 1, 'the snapshot never warmed');

    const suffix = uniqueSuffix();
    const template = await app.prisma.gameTemplate.findFirstOrThrow({
      where: { slug: 'minecraft-java' },
    });
    const fresh = await app.prisma.server.create({
      data: {
        name: 'Brand new',
        shortId: suffix.slice(0, 8),
        ownerId: owner.id,
        nodeId,
        templateId: template.id,
        dockerImage: 'alpine',
        startupCommand: 'true',
        sftpUsername: `new_${suffix}`,
        sftpPasswordEnc: 'not-a-real-secret',
        status: ServerStatus.INSTALLING,
      },
    });

    try {
      await app.notifications.broadcastServerStatus(fresh.id, owner.id, ServerStatus.OFFLINE);
      await settle();
      assert.equal(statusEvents(events).length, 2, JSON.stringify(events));
    } finally {
      await app.prisma.server.delete({ where: { id: fresh.id } }).catch(() => undefined);
      socket.close();
    }
  });

  it('says nothing about a server that was never shared with them', async () => {
    const { socket, events, settle } = await open(helper.accessToken);

    await app.notifications.broadcastServerStatus(serverId, owner.id, ServerStatus.ONLINE);
    await settle();

    assert.deepEqual(statusEvents(events), []);
    socket.close();
  });

  /* ------------------------------------ and for how long that holds -- */

  it('stops relaying a server the moment the share is taken back', async () => {
    // The cache only ever filled: an id that was once visible was never asked
    // about again. So an ex-sub-user kept receiving live status and resource
    // samples — CPU, memory, disk, network — for a server they had been
    // removed from, for as long as they left the tab open.
    await share();
    const { socket, events, settle } = await open(helper.accessToken);

    await app.notifications.broadcastServerStatus(serverId, owner.id, ServerStatus.ONLINE);
    await settle();
    assert.equal(statusEvents(events).length, 1, 'nothing arrived while the share was live');

    await app.prisma.serverSubuser.deleteMany({ where: { serverId, userId: helper.id } });
    await wait(VISIBILITY_TTL_MS);

    await app.notifications.broadcastServerStatus(serverId, owner.id, ServerStatus.OFFLINE);
    await app.notifications.broadcastServerStats(serverId, owner.id, {
      cpuPercent: 12,
      cpuLimit: 100,
      memoryBytes: 1024,
      memoryLimit: 2048,
      diskBytes: 4096,
      diskLimit: 8192,
      networkRx: 1,
      networkTx: 2,
      uptime: 60,
      timestamp: new Date().toISOString(),
    });
    await settle();

    assert.equal(
      statusEvents(events).length,
      1,
      'kept relaying status after the share was removed',
    );
    // Resource samples are the more sensitive half: they are a live picture of
    // what somebody else's machine is doing.
    assert.deepEqual(
      events.filter((event) => event.type === 'server:stats'),
      [],
      'kept relaying resource samples after the share was removed',
    );
    socket.close();
  });

  it('relays node health to an administrator', async () => {
    const { socket, events, settle } = await open(admin.accessToken);

    await app.notifications.broadcastNodeStatus(nodeId, NodeStatus.OFFLINE);
    await settle();

    assert.ok(
      events.some((event) => event.type === 'node:status'),
      JSON.stringify(events),
    );
    socket.close();
  });

  it('stops relaying node health once the account is no longer an administrator', async () => {
    // Being an administrator was decided at the handshake and never revisited,
    // so a demoted account kept a live feed of every node and every server on
    // the panel.
    const { socket, events, settle } = await open(admin.accessToken);

    const customerRole = await app.prisma.role.findFirstOrThrow({ where: { name: 'CUSTOMER' } });
    const adminRole = await app.prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } });
    await app.prisma.user.update({ where: { id: admin.id }, data: { roleId: customerRole.id } });

    try {
      await wait(VISIBILITY_TTL_MS);
      await app.notifications.broadcastNodeStatus(nodeId, NodeStatus.DEGRADED);
      await settle();

      assert.deepEqual(
        events.filter((event) => event.type === 'node:status'),
        [],
      );
    } finally {
      await app.prisma.user.update({ where: { id: admin.id }, data: { roleId: adminRole.id } });
      socket.close();
    }
  });

  it('closes a socket belonging to an account that has been suspended', async () => {
    await share();
    const { socket, closed, settle } = await open(helper.accessToken);

    await app.prisma.user.update({ where: { id: helper.id }, data: { suspendedAt: new Date() } });
    await wait(VISIBILITY_TTL_MS);
    await app.notifications.broadcastServerStatus(serverId, owner.id, ServerStatus.ONLINE);
    await settle();

    assert.equal(await within(closed, 2000), 4403);
    socket.close();
  });

  it('still answers a ping', async () => {
    // The control: none of the above may turn the socket into a brick.
    const { socket, events, settle } = await open(owner.accessToken);

    socket.send(JSON.stringify({ type: 'ping' }));
    await settle();

    assert.ok(
      events.some((event) => event.type === 'pong'),
      JSON.stringify(events),
    );
    socket.close();
  });
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms + 250));
