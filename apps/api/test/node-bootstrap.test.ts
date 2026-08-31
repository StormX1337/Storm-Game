import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { hashPassword } from '@storm/security';
import { createTestApp, uniqueSuffix } from './helpers.js';

/**
 * Installing a node used to require moving a file onto it, which assumes a
 * machine that can hold one. From a phone there is no such machine — so the
 * panel hands out a claim the installer redeems itself, and the credential
 * never touches the operator's device.
 *
 * What matters is that the claim is worth one node's configuration, once.
 */
describe('node installation claims', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let ownerToken: string;
  const nodes: string[] = [];
  const users: string[] = [];

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;

    const role = await app.prisma.role.findUniqueOrThrow({ where: { name: 'OWNER' } });
    const suffix = uniqueSuffix();
    const owner = await app.prisma.user.create({
      data: {
        email: `claim-${suffix}@storm.test`,
        username: `claim${suffix}`,
        passwordHash: await hashPassword('CorrectHorseBattery1'),
        roleId: role.id,
        emailVerifiedAt: new Date(),
      },
      include: { role: { include: { permissions: true } } },
    });
    users.push(owner.id);
    const session = await app.auth.issueSession(owner, { ip: '127.0.0.1', userAgent: 'test' });
    ownerToken = session.accessToken;
  });

  after(async () => {
    await app.prisma.nodeToken.deleteMany({ where: { nodeId: { in: nodes } } });
    await app.prisma.node.deleteMany({ where: { id: { in: nodes } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
    await cleanup();
  });

  async function createNode(): Promise<string> {
    const node = await app.prisma.node.create({
      data: {
        name: `claim-node-${uniqueSuffix()}`,
        location: 'Test',
        hostname: '127.0.0.1',
        ip: '127.0.0.1',
        scheme: 'http',
        agentPort: 8081,
        sftpPort: 2022,
        cpuCores: 1,
        memoryTotal: 1024,
        diskTotal: 10240,
      },
    });
    nodes.push(node.id);
    return node.id;
  }

  async function mintClaim(nodeId: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/nodes/${nodeId}/bootstrap`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(response.statusCode, 200, response.body);
    const { command } = response.json().data as { command: string };
    const claim = /--claim (\S+)/.exec(command)?.[1];
    assert.ok(claim, `no claim in: ${command}`);
    return claim;
  }

  function redeem(claim: string) {
    return app.inject({ method: 'POST', url: '/install/claim', payload: { claim } });
  }

  it('gives one command that carries everything the installer needs', async () => {
    const nodeId = await createNode();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/nodes/${nodeId}/bootstrap`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });

    const { command, expiresInSeconds } = response.json().data as {
      command: string;
      expiresInSeconds: number;
    };
    assert.match(command, /install\/node\.sh/);
    assert.match(command, /--panel-url /);
    assert.match(command, /--claim /);
    assert.ok(expiresInSeconds > 0 && expiresInSeconds <= 3600);
    // It has to survive being pasted into a phone keyboard in one piece.
    assert.equal(command.includes('\n'), false);
  });

  it('redeems into the configuration for that node and no other', async () => {
    const nodeId = await createNode();
    const other = await createNode();

    const response = await redeem(await mintClaim(nodeId));
    assert.equal(response.statusCode, 200, response.body);

    const { configuration } = response.json().data as { configuration: string };
    const node = await app.prisma.node.findUniqueOrThrow({ where: { id: nodeId } });
    const wrong = await app.prisma.node.findUniqueOrThrow({ where: { id: other } });

    assert.match(configuration, new RegExp(`^NODE_UUID=${node.uuid}$`, 'm'));
    assert.doesNotMatch(configuration, new RegExp(wrong.uuid));
    for (const key of ['PANEL_URL', 'AGENT_TOKEN_ID', 'AGENT_TOKEN', 'AGENT_SECRET']) {
      assert.match(configuration, new RegExp(`^${key}=.+$`, 'm'), `${key} missing`);
    }
  });

  it('works exactly once', async () => {
    const claim = await mintClaim(await createNode());

    assert.equal((await redeem(claim)).statusCode, 200);
    const second = await redeem(claim);
    assert.equal(second.statusCode, 404, 'a used claim still worked');
    assert.match(second.body, /expired or has already been used/);
  });

  it('refuses a claim nobody issued', async () => {
    const response = await redeem('a'.repeat(48));
    assert.equal(response.statusCode, 404);
  });

  it('needs a session to mint one', async () => {
    const nodeId = await createNode();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/nodes/${nodeId}/bootstrap`,
    });
    assert.equal(response.statusCode, 401);
  });

  it('does not keep the claim where a database dump would reveal it', async () => {
    const nodeId = await createNode();
    const claim = await mintClaim(nodeId);

    // Stored under its digest, like the node tokens themselves.
    const keys = await app.redis.keys('storm:node-bootstrap:*');
    assert.ok(keys.length > 0);
    assert.equal(
      keys.some((key) => key.includes(claim)),
      false,
      'the claim is recoverable from Redis',
    );
  });

  it('expires on its own', async () => {
    const claim = await mintClaim(await createNode());
    const keys = await app.redis.keys('storm:node-bootstrap:*');
    const ttls = await Promise.all(keys.map((key) => app.redis.ttl(key)));
    assert.ok(
      ttls.every((ttl) => ttl > 0 && ttl <= 900),
      `a claim outlives its window: ${ttls.join(', ')}`,
    );
    assert.ok(claim.length >= 24);
  });
});
