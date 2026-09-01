import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { hashPassword } from '@storm/security';
import { createTestApp, deleteUser, registerUser, uniqueSuffix } from './helpers.js';
import type { RegisteredUser } from './helpers.js';

/**
 * Turning a template's optional panels on and off.
 *
 * The mechanism existed before this did, which made it unreachable: only the
 * seed set it, so an operator importing their own Minecraft template got no
 * plugin browser and no way to ask for one. A capability nobody can operate is
 * the same defect as a switch that does nothing, just facing the other way.
 */
describe('template features', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let adminToken: string;
  let customer: RegisteredUser;
  let templateId: string;
  const createdUsers: string[] = [];

  const admin = () => ({ authorization: `Bearer ${adminToken}` });

  const patch = (features: unknown) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/templates/${templateId}`,
      headers: admin(),
      payload: { features },
    });

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;

    customer = await registerUser(app);
    createdUsers.push(customer.id);

    const suffix = uniqueSuffix();
    const ownerRole = await app.prisma.role.findUniqueOrThrow({ where: { name: 'OWNER' } });
    const owner = await app.prisma.user.create({
      data: {
        email: `tf-owner-${suffix}@storm.test`,
        username: `tfowner${suffix}`,
        passwordHash: await hashPassword('OwnerPassword123!'),
        roleId: ownerRole.id,
        emailVerifiedAt: new Date(),
      },
    });
    createdUsers.push(owner.id);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: owner.email, password: 'OwnerPassword123!' },
    });
    adminToken = login.json<{ data: { accessToken: string } }>().data.accessToken;

    // An operator's own template, which is the case the seed never covers.
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/templates',
      headers: admin(),
      payload: {
        name: `Imported Minecraft ${suffix}`,
        slug: `imported-minecraft-${suffix}`,
        game: 'Minecraft Java',
        dockerImages: { 'Java 21': 'eclipse-temurin:21-jre' },
        defaultImage: 'eclipse-temurin:21-jre',
        startupCommand: 'java -jar server.jar',
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    templateId = created.json<{ data: { id: string } }>().data.id;
  });

  after(async () => {
    await app.prisma.gameTemplate.delete({ where: { id: templateId } }).catch(() => undefined);
    for (const id of createdUsers) await deleteUser(app, id);
    await cleanup();
  });

  it('starts with none, since most games have none', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/templates/${templateId}`,
      headers: admin(),
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json<{ data: { features: string[] } }>().data.features, []);
  });

  it('turns a panel on for a template the seed never touched', async () => {
    const response = await patch(['plugins', 'players']);
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json<{ data: { features: string[] } }>().data.features.sort(), [
      'players',
      'plugins',
    ]);
  });

  it('turns one back off without disturbing the other', async () => {
    const response = await patch(['plugins']);
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json<{ data: { features: string[] } }>().data.features, ['plugins']);
  });

  it('refuses a feature the panel does not have', async () => {
    // Free text here would be a switch an operator could set and then wonder
    // about: nothing reads it, and a typo looks exactly like a real value.
    for (const bad of [['modpacks'], ['Plugins'], ['plugins', 'nonsense'], ['']]) {
      const response = await patch(bad);
      assert.equal(response.statusCode, 400, `${JSON.stringify(bad)} must be refused`);
    }
  });

  it('takes effect on the servers built from it, at once', async () => {
    // The point of the switch. Nothing is cached between the template row and
    // the endpoints that read it, and this is what says so.
    await patch([]);

    const node = await app.prisma.node.create({
      data: {
        name: `tf-node-${uniqueSuffix()}`,
        location: 'Test',
        hostname: '127.0.0.1',
        ip: '127.0.0.1',
        scheme: 'http',
        memoryTotal: 4096,
        diskTotal: 20480,
      },
    });
    await app.prisma.serverAllocation.create({
      data: { nodeId: node.id, ip: '127.0.0.1', port: 27611 },
    });

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: admin(),
      payload: {
        name: 'Feature switch server',
        nodeId: node.id,
        templateId,
        ownerId: customer.id,
        environment: {},
        limits: {
          cpuLimit: 100,
          memoryLimit: 1024,
          diskLimit: 2048,
          swapLimit: 0,
          ioWeight: 500,
          pidsLimit: 128,
          oomKill: true,
        },
        skipInstall: true,
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const serverId = created.json<{ data: { id: string } }>().data.id;

    const ask = () =>
      app.inject({
        method: 'GET',
        url: `/api/v1/servers/${serverId}/plugins`,
        headers: { authorization: `Bearer ${customer.accessToken}` },
      });

    assert.equal((await ask()).statusCode, 404, 'off means the endpoint is not there');

    await patch(['plugins']);
    assert.notEqual((await ask()).statusCode, 404, 'and on means it is, with no restart');

    // And the server payload carries it, which is what draws the tab.
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}`,
      headers: { authorization: `Bearer ${customer.accessToken}` },
    });
    assert.deepEqual(
      detail.json<{ data: { template: { features: string[] } } }>().data.template.features,
      ['plugins'],
    );

    await app.prisma.serverAllocation.updateMany({
      where: { nodeId: node.id },
      data: { serverId: null },
    });
    await app.prisma.server.deleteMany({ where: { nodeId: node.id } });
    await app.prisma.serverAllocation.deleteMany({ where: { nodeId: node.id } });
    await app.prisma.node.delete({ where: { id: node.id } }).catch(() => undefined);
  });

  it('is closed to a customer, whatever they send', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/templates/${templateId}`,
      headers: { authorization: `Bearer ${customer.accessToken}` },
      payload: { features: ['plugins', 'players'] },
    });
    assert.equal(response.statusCode, 403);
  });
});
