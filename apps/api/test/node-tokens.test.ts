import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { generateToken, hashPassword, hashToken } from '@storm/security';
import { createTestApp, uniqueSuffix } from './helpers.js';

/**
 * Handing out an agent configuration mints a credential that works until it is
 * revoked. Opening the dialog to look at it used to leave one behind every
 * time, each valid for the life of the node — so a screenshot or a scrollback
 * from months ago was still a way in.
 */
describe('agent configuration tokens', () => {
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
        email: `tokens-${suffix}@storm.test`,
        username: `tokens${suffix}`,
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
        name: `token-test-${uniqueSuffix()}`,
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

  function fetchConfig(nodeId: string) {
    return app.inject({
      method: 'GET',
      url: `/api/v1/admin/nodes/${nodeId}/configuration`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
  }

  it('serves a configuration the installer can read', async () => {
    const nodeId = await createNode();
    const response = await fetchConfig(nodeId);
    assert.equal(response.statusCode, 200);

    const { configuration } = response.json().data as { configuration: string };
    for (const key of ['NODE_UUID', 'PANEL_URL', 'AGENT_TOKEN_ID', 'AGENT_TOKEN', 'AGENT_SECRET']) {
      assert.match(configuration, new RegExp(`^${key}=.+$`, 'm'), `${key} missing`);
    }
  });

  it('leaves exactly one usable token behind, however often it is opened', async () => {
    const nodeId = await createNode();
    await fetchConfig(nodeId);
    await fetchConfig(nodeId);
    await fetchConfig(nodeId);

    const usable = await app.prisma.nodeToken.count({
      where: { nodeId, revokedAt: null },
    });
    assert.equal(usable, 1, 'every peek at the dialog left a working credential behind');
  });

  it('does not revoke the token a running node is authenticating with', async () => {
    const nodeId = await createNode();

    // What a node that has checked in looks like: a config token with a use.
    const inService = await app.prisma.nodeToken.create({
      data: {
        nodeId,
        name: 'configuration',
        tokenId: generateToken(8).slice(0, 16),
        tokenHash: hashToken(generateToken(32)),
        secretEnc: app.encrypter.encrypt(generateToken(32)),
        lastUsedAt: new Date(),
      },
    });

    await fetchConfig(nodeId);

    const still = await app.prisma.nodeToken.findUniqueOrThrow({ where: { id: inService.id } });
    assert.equal(still.revokedAt, null, 'looking at the page took a running node offline');
  });

  it('does not touch tokens issued for other purposes', async () => {
    const nodeId = await createNode();
    const rotated = await app.prisma.nodeToken.create({
      data: {
        nodeId,
        name: 'cli-rotation',
        tokenId: generateToken(8).slice(0, 16),
        tokenHash: hashToken(generateToken(32)),
        secretEnc: app.encrypter.encrypt(generateToken(32)),
      },
    });

    await fetchConfig(nodeId);

    const still = await app.prisma.nodeToken.findUniqueOrThrow({ where: { id: rotated.id } });
    assert.equal(still.revokedAt, null);
  });
});
