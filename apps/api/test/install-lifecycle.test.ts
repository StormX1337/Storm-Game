import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Node } from '@storm/database';
import { NotificationType, ServerStatus, WebhookEvent } from '@storm/types';
import { runInstall } from '../src/workers/install.worker.js';
import { failStalledInstalls } from '../src/workers/maintenance.worker.js';
import { createTestApp, deleteUser, registerUser, uniqueSuffix } from './helpers.js';
import type { RegisteredUser } from './helpers.js';

/**
 * Installing a server, and what may happen to it while that is going on.
 *
 * The install worker had no test at all: every other suite creates its servers
 * with `skipInstall`, which is the one path a real customer never takes. What
 * is pinned here is the order the node is told to do things in — spec, script,
 * spec again, because the install tears the container down and a server whose
 * spec was not re-applied cannot boot — and the bookkeeping either side of it:
 * what the customer is told, when, and what state the row is left in when the
 * node says no.
 */
describe('installing a server', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let customer: RegisteredUser;
  let serverId: string;
  let serverUuid: string;
  let nodeId: string;
  let templateId: string;
  const createdUsers: string[] = [];

  let calls: { path: string; method: string; body: Record<string, unknown> }[] = [];
  let dispatched: { event: string; payload: Record<string, unknown> }[] = [];
  let agentFailsOn: string | null = null;

  const read = () => app.prisma.server.findUniqueOrThrow({ where: { id: serverId } });
  const notifications = () =>
    app.prisma.notification.findMany({
      where: { userId: customer.id },
      orderBy: { createdAt: 'asc' },
    });
  const auditEntries = () =>
    app.prisma.auditLog.findMany({ where: { targetId: serverId }, orderBy: { createdAt: 'asc' } });

  async function setStatus(
    status: ServerStatus,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    await app.prisma.server.update({ where: { id: serverId }, data: { status, ...data } });
  }

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;

    // The node is stubbed; what is under test is everything either side of it.
    app.agents.request = (async (
      _node: Node,
      path: string,
      options?: { method?: string; body?: Record<string, unknown> },
    ) => {
      calls.push({ path, method: options?.method ?? 'GET', body: options?.body ?? {} });
      if (agentFailsOn && path.includes(agentFailsOn)) throw new Error('node said no');
      return {};
    }) as typeof app.agents.request;

    // Recorded rather than delivered: a real dispatch would reach whatever
    // webhooks the developer running the suite happens to have configured.
    app.webhooks.dispatch = (async (event: string, payload: Record<string, unknown>) => {
      dispatched.push({ event, payload });
    }) as typeof app.webhooks.dispatch;

    customer = await registerUser(app);
    createdUsers.push(customer.id);
    const suffix = uniqueSuffix();

    const node = await app.prisma.node.create({
      data: {
        name: `install-node-${suffix}`,
        location: 'Test',
        hostname: '127.0.0.1',
        ip: '127.0.0.1',
        scheme: 'http',
        memoryTotal: 8192,
        diskTotal: 51200,
        status: 'ONLINE',
      },
    });
    nodeId = node.id;

    // A template of its own: the install script and container it carries are
    // exactly what this suite asserts reach the node.
    const template = await app.prisma.gameTemplate.create({
      data: {
        name: `Install probe ${suffix}`,
        slug: `install-probe-${suffix}`,
        game: 'Test',
        category: 'Test',
        dockerImages: { Test: 'alpine:3.20' },
        defaultImage: 'alpine:3.20',
        startupCommand: 'true',
        installScript: '#!/bin/bash\necho installing\n',
        installContainer: 'alpine:3.20',
        installEntrypoint: 'sh',
      },
    });
    templateId = template.id;

    const server = await app.prisma.server.create({
      data: {
        name: 'Fresh',
        shortId: uniqueSuffix().slice(0, 8),
        ownerId: customer.id,
        nodeId,
        templateId,
        dockerImage: 'alpine:3.20',
        startupCommand: 'true',
        sftpUsername: `inst_${suffix}`,
        sftpPasswordEnc: 'not-a-real-secret',
        status: ServerStatus.INSTALLING,
      },
    });
    serverId = server.id;
    serverUuid = server.uuid;
  });

  after(async () => {
    await app.prisma.auditLog.deleteMany({ where: { targetId: serverId } });
    await app.prisma.server.deleteMany({ where: { nodeId } });
    await app.prisma.gameTemplate.delete({ where: { id: templateId } }).catch(() => undefined);
    await app.prisma.node.delete({ where: { id: nodeId } }).catch(() => undefined);
    for (const id of createdUsers) await deleteUser(app, id);
    await cleanup();
  });

  beforeEach(async () => {
    calls = [];
    dispatched = [];
    agentFailsOn = null;
    await app.prisma.notification.deleteMany({ where: { userId: customer.id } });
    await app.prisma.auditLog.deleteMany({ where: { targetId: serverId } });
    await setStatus(ServerStatus.INSTALLING, { installedAt: null, installStartedAt: null });
  });

  /* ------------------------------------------------------ the happy path -- */

  it('pushes the spec, runs the script, then pushes the spec again', async () => {
    await runInstall(app, { serverId, startOnCompletion: false });

    // The order is the whole point. The install step tears the container down
    // so the script cannot touch a live one, which leaves nothing to boot
    // unless the spec is applied a second time afterwards.
    assert.deepEqual(
      calls.map((call) => `${call.method} ${call.path}`),
      ['PUT /api/v1/servers', `POST /api/v1/servers/${serverUuid}/install`, 'PUT /api/v1/servers'],
    );
  });

  it("hands the node the template's install script, not a default one", async () => {
    await runInstall(app, { serverId, startOnCompletion: false });

    const install = calls.find((call) => call.path.endsWith('/install'));
    assert.ok(install, JSON.stringify(calls));
    assert.equal(install.body.script, '#!/bin/bash\necho installing\n');
    assert.equal(install.body.container, 'alpine:3.20');
    assert.equal(install.body.entrypoint, 'sh');
    // The image the *server* will run, which the install container needs so it
    // can lay the files down where that image expects them.
    assert.equal(install.body.serverImage, 'alpine:3.20');
  });

  it('only wipes the data directory when the reinstall asked for it', async () => {
    await runInstall(app, { serverId, startOnCompletion: false });
    assert.equal(calls.find((call) => call.path.endsWith('/install'))?.body.wipe, false);

    calls = [];
    await runInstall(app, { serverId, startOnCompletion: false, reinstall: true, wipe: true });
    assert.equal(calls.find((call) => call.path.endsWith('/install'))?.body.wipe, true);
  });

  it('marks the server installed and offline once the node is done', async () => {
    const before = Date.now();
    await runInstall(app, { serverId, startOnCompletion: false });

    const server = await read();
    assert.equal(server.status, ServerStatus.OFFLINE);
    assert.ok(server.installedAt, 'the server never got an installedAt');
    assert.ok(server.installedAt.getTime() >= before - 1000);
  });

  it('tells the owner, the audit log and the webhooks that it worked', async () => {
    await runInstall(app, { serverId, startOnCompletion: false });

    const [note] = await notifications();
    assert.equal(note?.type, NotificationType.SERVER_INSTALLED);
    assert.match(note?.message ?? '', /Fresh/);

    const actions = (await auditEntries()).map((entry) => entry.action);
    assert.ok(actions.includes('server.installed'), actions.join(','));

    const event = dispatched.find((entry) => entry.event === WebhookEvent.SERVER_INSTALLED);
    assert.ok(event, JSON.stringify(dispatched));
    assert.equal(event.payload.uuid, serverUuid);
  });

  it('records a reinstall as a reinstall', async () => {
    await runInstall(app, { serverId, startOnCompletion: false, reinstall: true });

    const actions = (await auditEntries()).map((entry) => entry.action);
    assert.ok(actions.includes('server.reinstalled'), actions.join(','));
    assert.ok(!actions.includes('server.installed'), actions.join(','));
  });

  it('starts the server afterwards only when it was asked to', async () => {
    await runInstall(app, { serverId, startOnCompletion: false });
    assert.ok(!calls.some((call) => call.path.endsWith('/power')), 'started without being asked');

    calls = [];
    await runInstall(app, { serverId, startOnCompletion: true });
    const start = calls.find((call) => call.path.endsWith('/power'));
    assert.ok(start, JSON.stringify(calls));
    assert.equal(start.body.action, 'start');
  });

  it('counts the install as done even if the automatic start fails', async () => {
    // The files are on disk either way. Failing the job here would mark a
    // perfectly good server INSTALL_FAILED over a container that would not
    // boot — and the customer can press start themselves.
    agentFailsOn = '/power';
    await runInstall(app, { serverId, startOnCompletion: true });

    assert.ok(
      calls.some((call) => call.path.endsWith('/power')),
      'never tried to start it',
    );
    const server = await read();
    assert.equal(server.status, ServerStatus.OFFLINE);
    assert.ok(server.installedAt);
    assert.deepEqual(
      (await auditEntries()).filter((entry) => entry.action === 'server.install_failed'),
      [],
    );
  });

  /* ---------------------------------------------------------- when it fails -- */

  it('marks the last attempt failed, and says so everywhere', async () => {
    agentFailsOn = '/install';

    await assert.rejects(runInstall(app, { serverId, startOnCompletion: false }, 0, 1));

    const server = await read();
    assert.equal(server.status, ServerStatus.INSTALL_FAILED);
    assert.equal(server.installedAt, null);

    const [note] = await notifications();
    assert.equal(note?.type, NotificationType.SERVER_CRASHED);
    assert.match(note?.title ?? '', /Installation failed/);

    const failure = (await auditEntries()).find(
      (entry) => entry.action === 'server.install_failed',
    );
    assert.ok(failure, 'nothing was written down about the failure');

    // Operators watching a fleet hear about it from their own tooling rather
    // than from the customer, who was the only one told before this.
    const event = dispatched.find((entry) => entry.event === WebhookEvent.SERVER_INSTALL_FAILED);
    assert.ok(event, JSON.stringify(dispatched));
    assert.equal(event.payload.error, 'node said no');
  });

  it('stays quiet on an attempt the queue is going to retry', async () => {
    // The queue runs installs twice. Reporting the first failure told the
    // customer their server was finished when it was not — and INSTALL_FAILED
    // is exactly the status that unlocks the reinstall button, so the retry
    // and the reinstall it invites both end up in the same data directory.
    agentFailsOn = '/install';

    await assert.rejects(runInstall(app, { serverId, startOnCompletion: false }, 0, 2));

    const server = await read();
    assert.equal(server.status, ServerStatus.INSTALLING);
    assert.deepEqual(await notifications(), []);
    assert.deepEqual(
      (await auditEntries()).filter((entry) => entry.action === 'server.install_failed'),
      [],
    );
    assert.deepEqual(dispatched, []);
  });

  it('reports the failure once the retries are used up', async () => {
    agentFailsOn = '/install';

    await assert.rejects(runInstall(app, { serverId, startOnCompletion: false }, 1, 2));

    assert.equal((await read()).status, ServerStatus.INSTALL_FAILED);
    assert.equal((await notifications()).length, 1);
  });

  it('stamps when the attempt began, so a lost one can be found', async () => {
    const before = Date.now();
    agentFailsOn = '/install';
    await assert.rejects(runInstall(app, { serverId, startOnCompletion: false }, 0, 2));

    const server = await read();
    assert.ok(server.installStartedAt, 'no stamp for an install that is running');
    assert.ok(server.installStartedAt.getTime() >= before - 1000);
  });

  /* ------------------------------------------------ installs that vanished -- */

  it('hands back a server whose install never came back', async () => {
    // A worker killed between attempts takes the job with it. The row keeps
    // saying INSTALLING, and the reinstall route refuses a server that is
    // already installing — so the one action that fixes it is the one action
    // the customer cannot take.
    await setStatus(ServerStatus.INSTALLING, {
      installedAt: null,
      installStartedAt: new Date(Date.now() - 5 * 3600_000),
    });

    await failStalledInstalls(app);

    assert.equal((await read()).status, ServerStatus.INSTALL_FAILED);
    const [note] = await notifications();
    assert.equal(note?.type, NotificationType.SERVER_CRASHED);
    assert.match(note?.message ?? '', /Reinstall it/);
  });

  it('leaves an install that is still running alone', async () => {
    await setStatus(ServerStatus.REINSTALLING, {
      installedAt: new Date(),
      installStartedAt: new Date(Date.now() - 30 * 60_000),
    });

    await failStalledInstalls(app);

    assert.equal((await read()).status, ServerStatus.REINSTALLING);
    assert.deepEqual(await notifications(), []);
  });

  it('leaves a server that is not installing alone, however old the stamp', async () => {
    await setStatus(ServerStatus.OFFLINE, {
      installedAt: new Date(),
      installStartedAt: new Date(Date.now() - 30 * 24 * 3600_000),
    });

    await failStalledInstalls(app);

    assert.equal((await read()).status, ServerStatus.OFFLINE);
  });
});
