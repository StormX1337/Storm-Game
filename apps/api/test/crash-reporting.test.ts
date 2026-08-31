import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { generateToken, hashPassword, hashToken } from '@storm/security';
import { createTestApp, uniqueSuffix } from './helpers.js';

/**
 * What the owner is told when their server dies.
 *
 * Running out of memory is how a game server usually dies, and the only crash
 * its owner can fix themselves. The agent knew — Docker reports it — and the
 * panel threw the distinction away, leaving "stopped unexpectedly" beside a
 * console showing a bare "Killed".
 */
describe('reporting a crash to the owner', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let credentials: string;
  const created: { users: string[]; nodes: string[]; servers: string[] } = {
    users: [],
    nodes: [],
    servers: [],
  };

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;

    const suffix = uniqueSuffix();
    const role = await app.prisma.role.findUniqueOrThrow({ where: { name: 'CUSTOMER' } });
    const owner = await app.prisma.user.create({
      data: {
        email: `crash-${suffix}@storm.test`,
        username: `crash${suffix}`,
        passwordHash: await hashPassword('CorrectHorseBattery1'),
        roleId: role.id,
        emailVerifiedAt: new Date(),
      },
    });
    created.users.push(owner.id);

    const node = await app.prisma.node.create({
      data: {
        name: `crash-node-${suffix}`,
        location: 'Test',
        hostname: '127.0.0.1',
        ip: '127.0.0.1',
        scheme: 'http',
        agentPort: 8081,
        sftpPort: 2022,
        cpuCores: 1,
        memoryTotal: 4096,
        diskTotal: 10240,
      },
    });
    created.nodes.push(node.id);

    const tokenId = generateToken(8).slice(0, 16);
    const token = generateToken(32);
    await app.prisma.nodeToken.create({
      data: {
        nodeId: node.id,
        name: 'test',
        tokenId,
        tokenHash: hashToken(token),
        secretEnc: app.encrypter.encrypt(generateToken(32)),
      },
    });
    credentials = `${tokenId}.${token}`;

    const template = await app.prisma.gameTemplate.findFirstOrThrow();
    const server = await app.prisma.server.create({
      data: {
        name: 'Storm',
        shortId: `c${suffix}`.slice(0, 12),
        ownerId: owner.id,
        nodeId: node.id,
        templateId: template.id,
        dockerImage: 'eclipse-temurin:25-jre',
        startupCommand: 'true',
        memoryLimit: 512,
        diskLimit: 1024,
        cpuLimit: 100,
        status: 'ONLINE',
        sftpUsername: `crash${suffix}`,
        sftpPasswordEnc: app.encrypter.encrypt('not-used-here'),
      },
    });
    created.servers.push(server.id);
  });

  after(async () => {
    await app.prisma.notification.deleteMany({ where: { userId: { in: created.users } } });
    await app.prisma.server.deleteMany({ where: { id: { in: created.servers } } });
    await app.prisma.nodeToken.deleteMany({ where: { nodeId: { in: created.nodes } } });
    await app.prisma.node.deleteMany({ where: { id: { in: created.nodes } } });
    await app.prisma.user.deleteMany({ where: { id: { in: created.users } } });
    await cleanup();
  });

  async function report(status: string, reason?: string) {
    const server = await app.prisma.server.findUniqueOrThrow({
      where: { id: created.servers[0] as string },
    });
    // The status only changes when it differs, so reset first.
    await app.prisma.server.update({
      where: { id: server.id },
      data: { status: status === 'CRASHED' ? 'ONLINE' : 'CRASHED' },
    });
    return app.inject({
      method: 'POST',
      url: `/api/v1/internal/servers/${server.uuid}/state`,
      headers: { authorization: `Bearer ${credentials}` },
      payload: { status, ...(reason ? { reason } : {}) },
    });
  }

  async function latestNotification() {
    return app.prisma.notification.findFirst({
      where: { userId: created.users[0] as string },
      orderBy: { createdAt: 'desc' },
    });
  }

  it('names the memory limit when the kernel killed it for exceeding it', async () => {
    const response = await report('CRASHED', 'oom');
    assert.equal(response.statusCode, 200, response.body);

    const notification = await latestNotification();
    assert.ok(notification);
    assert.match(notification.title, /out of memory/i);
    assert.match(notification.message, /512 MiB/);
    // The fix is one page away, so link there rather than at the server.
    assert.match(notification.link ?? '', /\/settings$/);
  });

  it('does not blame memory for a crash that was not one', async () => {
    const response = await report('CRASHED');
    assert.equal(response.statusCode, 200, response.body);

    const notification = await latestNotification();
    assert.ok(notification);
    assert.equal(notification.title, 'Server crashed');
    assert.doesNotMatch(notification.message, /memory/i);
  });

  it('still accepts an agent too old to send a reason', async () => {
    // An agent updated later than the panel omits the field entirely.
    const response = await report('CRASHED');
    assert.equal(response.statusCode, 200);
  });

  it('refuses a reason it does not know', async () => {
    const server = await app.prisma.server.findUniqueOrThrow({
      where: { id: created.servers[0] as string },
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/internal/servers/${server.uuid}/state`,
      headers: { authorization: `Bearer ${credentials}` },
      payload: { status: 'CRASHED', reason: 'whatever-the-agent-felt-like' },
    });
    // A node is trusted to say what happened, not to define new vocabulary:
    // whatever it sends has to be one of the reasons the panel renders.
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.body, /VALIDATION_ERROR/);
  });
});
