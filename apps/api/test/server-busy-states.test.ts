import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Node } from '@storm/database';
import { ServerStatus } from '@storm/types';
import { authHeaders, createTestApp, deleteUser, registerUser, uniqueSuffix } from './helpers.js';
import type { RegisteredUser } from './helpers.js';

/**
 * What a customer may do with a server whose files the panel is holding.
 *
 * An install script runs in its own throwaway container against the server's
 * data directory, and a move copies that directory to another machine. Neither
 * survives the game server writing underneath it — so neither may be running
 * when the container comes up.
 *
 * The only guard on that read `installedAt`, which stays set through a
 * reinstall and through a move. A customer could start a server into a
 * directory an install script was in the middle of rewriting, into one a
 * transfer was copying away, or — worst of the three — into whatever a
 * reinstall with `wipe` left behind after falling over, because `installedAt`
 * still said the server had been installed. It had been, once.
 */
describe('a server whose files a job is holding', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let customer: RegisteredUser;
  let serverId: string;
  let serverShortId: string;
  let nodeId: string;
  const createdUsers: string[] = [];

  let calls: string[] = [];

  async function setStatus(status: ServerStatus): Promise<void> {
    await app.prisma.server.update({
      where: { id: serverId },
      data: { status, installedAt: new Date() },
    });
  }

  const power = (action: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverShortId}/power`,
      headers: authHeaders(customer),
      payload: { action },
    });

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;

    // Recorded, not delivered: a refusal that still reached the node would be
    // no refusal at all, and only the stub can show that it did not.
    app.agents.request = (async (_node: Node, path: string) => {
      calls.push(path);
      return {};
    }) as typeof app.agents.request;

    customer = await registerUser(app);
    createdUsers.push(customer.id);
    const suffix = uniqueSuffix();

    const node = await app.prisma.node.create({
      data: {
        name: `busy-node-${suffix}`,
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

    const template = await app.prisma.gameTemplate.findFirstOrThrow({
      where: { slug: 'minecraft-java' },
    });
    const server = await app.prisma.server.create({
      data: {
        name: 'Held',
        shortId: uniqueSuffix().slice(0, 8),
        ownerId: customer.id,
        nodeId,
        templateId: template.id,
        dockerImage: 'alpine:3.20',
        startupCommand: 'true',
        sftpUsername: `busy_${suffix}`,
        sftpPasswordEnc: 'not-a-real-secret',
        status: ServerStatus.OFFLINE,
        installedAt: new Date(),
      },
    });
    serverId = server.id;
    serverShortId = server.shortId;
  });

  after(async () => {
    await app.prisma.server.deleteMany({ where: { nodeId } });
    await app.prisma.node.delete({ where: { id: nodeId } }).catch(() => undefined);
    for (const id of createdUsers) await deleteUser(app, id);
    await cleanup();
  });

  beforeEach(() => {
    calls = [];
  });

  it('will not start a server that is being reinstalled', async () => {
    await setStatus(ServerStatus.REINSTALLING);

    const response = await power('start');
    assert.equal(response.statusCode, 409);
    assert.match(response.body, /reinstall/i);
    assert.deepEqual(calls, [], 'the node was told to start it anyway');
  });

  it('will not start a server that is still installing for the first time', async () => {
    await setStatus(ServerStatus.INSTALLING);

    const response = await power('start');
    assert.equal(response.statusCode, 409);
    assert.deepEqual(calls, []);
  });

  it('will not start a server whose reinstall never finished', async () => {
    // A reinstall with `wipe` empties the directory before the script runs, so
    // a failed one may have left nothing behind at all.
    await setStatus(ServerStatus.INSTALL_FAILED);

    const response = await power('start');
    assert.equal(response.statusCode, 409);
    assert.match(response.body, /did not finish installing/i);
    assert.deepEqual(calls, []);
  });

  it('will not start a server that is being moved to another node', async () => {
    // The move copies the data directory to the other machine. A server
    // writing to it while that runs corrupts whichever copy wins.
    await setStatus(ServerStatus.TRANSFERRING);

    const response = await power('start');
    assert.equal(response.statusCode, 409);
    assert.match(response.body, /moved/i);
    assert.deepEqual(calls, []);
  });

  it('refuses in the service too, not only in the route', async () => {
    // Schedules and the console websocket call sendPower directly, so a guard
    // that only sat in the HTTP handler would cover neither.
    await setStatus(ServerStatus.REINSTALLING);

    await assert.rejects(app.servers.sendPower(serverId, 'start'), /reinstall/i);
    assert.deepEqual(calls, []);
  });

  it('will not take a backup mid-reinstall', async () => {
    // Archiving a directory being rewritten produces an archive of neither the
    // old server nor the new one.
    await setStatus(ServerStatus.REINSTALLING);

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverShortId}/backups`,
      headers: authHeaders(customer),
      payload: { name: 'mid-reinstall' },
    });
    assert.equal(response.statusCode, 409);
  });

  it('still starts an ordinary offline server', async () => {
    // The control: the guard has to say no to those four and yes to this, or
    // it is not a guard, it is an outage.
    await setStatus(ServerStatus.OFFLINE);

    const response = await power('start');
    assert.equal(response.statusCode, 200);
    assert.ok(calls.some((path) => path.endsWith('/power')));
  });

  it('still lets a running server be stopped', async () => {
    await setStatus(ServerStatus.ONLINE);

    const response = await power('stop');
    assert.equal(response.statusCode, 200);
    assert.ok(calls.some((path) => path.endsWith('/power')));
  });
});
