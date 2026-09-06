import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { hashPassword } from '@storm/security';
import { ServerStatus } from '@storm/types';
import { createTestApp, deleteUser, registerUser, uniqueSuffix } from './helpers.js';
import type { RegisteredUser } from './helpers.js';

/**
 * An allocation's IP is a bind address, and a name is not one.
 *
 * It travels to the node and becomes `HostIp` on a Docker port binding. Docker
 * parses that with Go's `netip.ParseAddr`, which resolves nothing, so a
 * hostname fails the container create outright:
 *
 *   (HTTP code 400) bad parameter - invalid JSON:
 *   ParseAddr("storm.example.com"): unexpected character
 *
 * That happened to a real server. The panel had accepted the hostname on the
 * nodes screen days earlier, and what the operator saw was an install that
 * failed twice with a Go parser error and a server stuck on "Reinstalling" —
 * nothing pointing at the address, or at the screen it was typed on.
 *
 * Two ends, because a validator alone would not have helped the server that
 * was already broken: the field refuses it, and the spec that goes to the node
 * refuses to be built from a row that predates the field.
 */
describe('an allocation binds to an address, not a name', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let adminToken: string;
  let owner: RegisteredUser;
  let nodeId: string;
  let serverId: string;
  const createdUsers: string[] = [];

  const asAdmin = () => ({ authorization: `Bearer ${adminToken}` });

  // DNS is stubbed. What is under test is what the panel does with an answer,
  // not whether this machine can reach a resolver — and a suite that needs the
  // network is a suite that fails for reasons that are not the code's.
  const RESOLVES_TO = '203.0.113.7';
  const realLookup = dns.lookup;

  let port = 30000;
  const nextPort = () => (port += 1);

  const createAllocation = (ip: string, alias?: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/admin/nodes/${nodeId}/allocations`,
      headers: asAdmin(),
      payload: { ip, ...(alias ? { alias } : {}), ports: [nextPort()] },
    });

  before(async () => {
    (dns as { lookup: unknown }).lookup = async (host: string) => {
      if (host === 'nowhere.invalid') throw new Error('ENOTFOUND');
      return { address: RESOLVES_TO, family: 4 };
    };

    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;

    owner = await registerUser(app);
    createdUsers.push(owner.id);

    const suffix = uniqueSuffix();
    const ownerRole = await app.prisma.role.findUniqueOrThrow({ where: { name: 'OWNER' } });
    const admin = await app.prisma.user.create({
      data: {
        email: `bind-admin-${suffix}@storm.test`,
        username: `badmin${suffix}`,
        passwordHash: await hashPassword('BindAdmin123!'),
        roleId: ownerRole.id,
        emailVerifiedAt: new Date(),
      },
    });
    createdUsers.push(admin.id);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: admin.email, password: 'BindAdmin123!' },
    });
    adminToken = login.json<{ data: { accessToken: string } }>().data.accessToken;

    nodeId = (
      await app.prisma.node.create({
        data: {
          name: `bind-node-${suffix}`,
          location: 'Test',
          hostname: '127.0.0.1',
          ip: '127.0.0.1',
          scheme: 'http',
          memoryTotal: 8192,
          diskTotal: 51200,
          status: 'ONLINE',
        },
      })
    ).id;
  });

  after(async () => {
    (dns as { lookup: unknown }).lookup = realLookup;
    await app.prisma.serverAllocation.deleteMany({ where: { nodeId } });
    await app.prisma.server.deleteMany({ where: { nodeId } });
    await app.prisma.node.delete({ where: { id: nodeId } }).catch(() => undefined);
    for (const id of createdUsers) await deleteUser(app, id);
    await cleanup();
  });

  beforeEach(async () => {
    await app.prisma.serverAllocation.updateMany({ where: { nodeId }, data: { serverId: null } });
    await app.prisma.server.deleteMany({ where: { nodeId } });
    await app.prisma.serverAllocation.deleteMany({ where: { nodeId } });

    const suffix = uniqueSuffix();
    const template = await app.prisma.gameTemplate.findFirstOrThrow({
      where: { slug: 'minecraft-java' },
    });
    serverId = (
      await app.prisma.server.create({
        data: {
          name: 'Storm SMP Test',
          shortId: suffix.slice(0, 8),
          ownerId: owner.id,
          nodeId,
          templateId: template.id,
          dockerImage: 'alpine',
          startupCommand: 'true',
          sftpUsername: `bind_${suffix}`,
          sftpPasswordEnc: app.encrypter.encrypt('not-a-real-secret'),
          status: ServerStatus.OFFLINE,
          installedAt: new Date(),
        },
      })
    ).id;
  });

  /* ------------------------------------------------------- the validator -- */

  it('takes an IPv4 address', async () => {
    const response = await createAllocation('10.0.0.5');
    assert.equal(response.statusCode, 201, response.body);
  });

  it('takes 0.0.0.0, which is how an operator says every interface', async () => {
    const response = await createAllocation('0.0.0.0');
    assert.equal(response.statusCode, 201, response.body);
  });

  it('takes an IPv6 address', async () => {
    const response = await createAllocation('2a01:4f8:1c18:96a4::1');
    assert.equal(response.statusCode, 201, response.body);
  });

  it('refuses something that is neither an address nor a name', async () => {
    // 400 is what this panel answers for a body that does not validate.
    const response = await createAllocation('http://storm.example.com:25565/x');
    assert.equal(response.statusCode, 400, response.body);
  });

  it('takes the alias when one is given', async () => {
    const response = await createAllocation('10.0.0.6', 'storm.stormclient.xyz');
    assert.equal(response.statusCode, 201, response.body);
    const stored = await app.prisma.serverAllocation.findFirstOrThrow({
      where: { nodeId, ip: '10.0.0.6' },
    });
    assert.equal(stored.alias, 'storm.stormclient.xyz');
  });

  /* ------------------------------------------------------- a typed name -- */

  it('takes a hostname and stores what it resolved to', async () => {
    // Pterodactyl's bargain, and the reason an operator expects this to work:
    // the name is looked up once, and the address is what is kept.
    const port = nextPort();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/nodes/${nodeId}/allocations`,
      headers: asAdmin(),
      payload: { ip: 'storm.stormclient.xyz', ports: [port] },
    });
    assert.equal(response.statusCode, 201, response.body);

    const stored = await app.prisma.serverAllocation.findFirstOrThrow({ where: { nodeId, port } });
    assert.equal(stored.ip, RESOLVES_TO, 'the name was stored instead of the address');
  });

  it('keeps the name as the alias, because that is what it was', async () => {
    // Somebody who types a name into an address field means customers to see
    // it. Pterodactyl drops it here and the name is simply gone.
    const port = nextPort();
    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/nodes/${nodeId}/allocations`,
      headers: asAdmin(),
      payload: { ip: 'storm.stormclient.xyz', ports: [port] },
    });

    const stored = await app.prisma.serverAllocation.findFirstOrThrow({ where: { nodeId, port } });
    assert.equal(stored.alias, 'storm.stormclient.xyz');
  });

  it('does not overwrite an alias the operator gave', async () => {
    const port = nextPort();
    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/nodes/${nodeId}/allocations`,
      headers: asAdmin(),
      payload: { ip: 'storm.stormclient.xyz', alias: 'play.example.com', ports: [port] },
    });

    const stored = await app.prisma.serverAllocation.findFirstOrThrow({ where: { nodeId, port } });
    assert.equal(stored.alias, 'play.example.com');
  });

  it('says what it resolved, rather than quietly storing something else', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/nodes/${nodeId}/allocations`,
      headers: asAdmin(),
      payload: { ip: 'storm.stormclient.xyz', ports: [nextPort()] },
    });
    const data = response.json<{ data: { ip: string; resolvedFrom: string | null } }>().data;
    assert.equal(data.ip, RESOLVES_TO);
    assert.equal(data.resolvedFrom, 'storm.stormclient.xyz');
  });

  it('reports nothing resolved when an address was typed', async () => {
    const response = await createAllocation('10.0.0.9');
    const data = response.json<{ data: { resolvedFrom: string | null } }>().data;
    assert.equal(data.resolvedFrom, null);
  });

  it('refuses a name that does not resolve, and says to use the alias', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/nodes/${nodeId}/allocations`,
      headers: asAdmin(),
      payload: { ip: 'nowhere.invalid', ports: [nextPort()] },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.body, /did not resolve/i);
    assert.match(response.body, /alias/i);
  });

  it('stores nothing at all when the name does not resolve', async () => {
    const port = nextPort();
    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/nodes/${nodeId}/allocations`,
      headers: asAdmin(),
      payload: { ip: 'nowhere.invalid', ports: [port] },
    });
    assert.equal(await app.prisma.serverAllocation.count({ where: { nodeId, port } }), 0);
  });

  /* ------------------------------------------------------------ the guard -- */

  /** Writes a row the way one existed before the validator did. */
  async function attachAllocation(ip: string): Promise<void> {
    await app.prisma.serverAllocation.create({
      data: { nodeId, ip, port: 25565, serverId, isPrimary: true },
    });
  }

  const buildSpec = () => app.servers.buildAgentSpec(serverId);

  it('builds a spec for a server bound to an address', async () => {
    await attachAllocation('10.0.0.7');
    const spec = await buildSpec();
    assert.deepEqual(
      spec.ports.map((port) => port.ip),
      ['10.0.0.7'],
    );
  });

  it('refuses to build one from a row holding a name', async () => {
    // This is the row the panel already had. Nothing validates it on the way
    // out of the database, so without this the name reaches Docker.
    await attachAllocation('storm.stormclient.xyz');
    await assert.rejects(buildSpec(), (error: { statusCode?: number; message?: string }) => {
      assert.equal(error.statusCode, 422);
      assert.match(String(error.message), /storm\.stormclient\.xyz:25565/);
      return true;
    });
  });

  it('names the screen the address is corrected on', async () => {
    await attachAllocation('storm.stormclient.xyz');
    await assert.rejects(buildSpec(), (error: { message?: string }) => {
      assert.match(String(error.message), /allocations/i);
      assert.match(String(error.message), /alias/i);
      return true;
    });
  });

  it('does not quietly rebind it to every interface', async () => {
    // 0.0.0.0 is the only substitute that would always work, and publishing a
    // customer's port on every interface of the node is not a repair.
    await attachAllocation('storm.stormclient.xyz');
    await assert.rejects(buildSpec());
    const stored = await app.prisma.serverAllocation.findFirstOrThrow({ where: { serverId } });
    assert.equal(stored.ip, 'storm.stormclient.xyz');
  });
});
