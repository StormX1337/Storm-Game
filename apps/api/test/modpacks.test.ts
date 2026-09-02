import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createServer, type Server as HttpServer } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import archiver from 'archiver';
import type { FastifyInstance } from 'fastify';
import type { Node } from '@prisma/client';
import { hashPassword } from '@storm/security';
import { cloneTemplate, createTestApp, deleteUser, registerUser, uniqueSuffix } from './helpers.js';
import type { RegisteredUser } from './helpers.js';

/**
 * The Minecraft modpack browser.
 *
 * A modpack index is a list of download URLs written by a stranger, which is a
 * different proposition from a plugin's single file. If the panel passes that
 * list on unchecked, "install this modpack" becomes "make my node fetch these
 * hundred addresses and write the answers where I can read them" — the node's
 * own metadata service, a database on the operator's private network, anything
 * the node can reach and the customer cannot.
 *
 * So the checks that matter here are: every URL inside the pack is vetted, not
 * just the pack's own; a path in the index cannot climb out of the server
 * directory; and a pack is never installed into a server that cannot run it.
 *
 * The registry is a stub on localhost. It is the only way to answer with the
 * hostile things a real registry never would.
 */
describe('modpack browser', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let registry: HttpServer;
  let registryUrl: string;
  let registryPort = 0;
  let customer: RegisteredUser;
  let adminToken: string;
  let nodeId: string;
  let serverId: string;
  let otherGameServerId: string;
  let template: { id: string; slug: string };
  const createdUsers: string[] = [];

  /** The index the stub packs into the `.mrpack` it serves. */
  let index: Record<string, unknown> = {};
  /** What the stub answers for /version/:id. */
  let versionResponse: unknown = null;
  /** The facets the panel asked the registry for, as sent. */
  let lastFacets = '';
  /** Every call the routes made to the node, in order. */
  let agentCalls: { path: string; body?: unknown; query?: unknown }[] = [];
  let realRequest: FastifyInstance['agents']['request'];

  const auth = () => ({ authorization: `Bearer ${customer.accessToken}` });

  /** A real zip, because the panel really opens it. */
  async function mrpack(contents: Record<string, unknown>): Promise<Buffer> {
    const zip = archiver('zip');
    const chunks: Buffer[] = [];
    zip.on('data', (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<void>((resolve, reject) => {
      zip.on('end', resolve);
      zip.on('error', reject);
    });
    zip.append(JSON.stringify(contents), { name: 'modrinth.index.json' });
    zip.append('# a config the pack ships', { name: 'overrides/config/pack.toml' });
    await zip.finalize();
    await done;
    return Buffer.concat(chunks);
  }

  /** A pack index that installs cleanly, with whatever is overridden here. */
  function goodIndex(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      formatVersion: 1,
      game: 'minecraft',
      name: 'Test Pack',
      dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.9' },
      files: [
        {
          path: 'mods/example.jar',
          downloads: ['https://cdn.modrinth.com/example.jar'],
          fileSize: 2048,
          hashes: { sha512: 'abc' },
        },
      ],
      ...overrides,
    };
  }

  const install = () =>
    app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/modpacks`,
      headers: auth(),
      payload: { versionId: 'ver_pack' },
    });

  before(async () => {
    registry = createServer((request, response) => {
      const url = request.url ?? '';

      if (url.startsWith('/search')) {
        lastFacets = new URL(url, 'http://x').searchParams.get('facets') ?? '';
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            hits: [
              {
                project_id: 'proj_pack',
                slug: 'test-pack',
                title: 'Test Pack',
                description: 'A pack for tests.',
                downloads: 500,
                follows: 5,
                icon_url: 'https://cdn.modrinth.com/icon.png',
                categories: ['fabric'],
              },
            ],
          }),
        );
        return;
      }

      if (url.includes('/version')) {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify(url.startsWith('/project/') ? [versionResponse] : versionResponse),
        );
        return;
      }

      response.statusCode = 404;
      response.end('{}');
    });
    await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve));
    const address = registry.address();
    registryPort = typeof address === 'object' && address ? address.port : 0;
    registryUrl = `http://127.0.0.1:${registryPort}`;

    const context = await createTestApp({
      env: {
        MODRINTH_API_URL: registryUrl,
        // The stub serves its own downloads, so it has to be allowed for the
        // happy path. The rejection tests point somewhere else on purpose.
        MODRINTH_DOWNLOAD_HOSTS: 'cdn.modrinth.com,127.0.0.1',
      },
    });
    app = context.app;
    cleanup = context.cleanup;
    realRequest = app.agents.request;

    // Only the transport. Everything the panel checks about that URL — https,
    // not a private address, on the operator's allowlist — still runs, against
    // the real cdn.modrinth.com hostname the pack claims to live at.
    app.modpacks.fetchArchive = async () => mrpack(index);

    // Stands in for a node, and records what it was told to do — which is the
    // only place the URLs the panel approved can actually be observed.
    app.agents.request = (async (
      _node: Node,
      path: string,
      options?: { body?: unknown; query?: unknown },
    ) => {
      agentCalls.push({ path, body: options?.body, query: options?.query });
      if (path.includes('/files/list')) {
        return { entries: [{ name: 'config' }] };
      }
      return {};
    }) as FastifyInstance['agents']['request'];

    customer = await registerUser(app);
    createdUsers.push(customer.id);

    const suffix = uniqueSuffix();
    const ownerRole = await app.prisma.role.findUniqueOrThrow({ where: { name: 'OWNER' } });
    const owner = await app.prisma.user.create({
      data: {
        email: `pack-owner-${suffix}@storm.test`,
        username: `packowner${suffix}`,
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

    const node = await app.prisma.node.create({
      data: {
        name: `pack-node-${suffix}`,
        location: 'Test',
        hostname: '127.0.0.1',
        ip: '127.0.0.1',
        scheme: 'http',
        memoryTotal: 8192,
        diskTotal: 51200,
      },
    });
    nodeId = node.id;
    for (const port of [27611, 27612]) {
      await app.prisma.serverAllocation.create({ data: { nodeId, ip: '127.0.0.1', port } });
    }

    template = await cloneTemplate(app, 'minecraft-java', ['modpacks']);

    const limits = {
      cpuLimit: 100,
      memoryLimit: 1024,
      diskLimit: 4096,
      swapLimit: 0,
      ioWeight: 500,
      pidsLimit: 128,
      oomKill: true,
    };

    const make = async (
      templateId: string,
      name: string,
      environment: Record<string, string> = {},
    ): Promise<string> => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/servers',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name,
          nodeId,
          templateId,
          ownerId: customer.id,
          environment,
          limits,
          skipInstall: true,
        },
      });
      assert.equal(created.statusCode, 201, created.body);
      return created.json<{ data: { id: string } }>().data.id;
    };

    serverId = await make(template.id, 'Modpack server', {
      PROJECT: 'fabric',
      MINECRAFT_VERSION: '1.21.1',
    });
    const valheim = await app.prisma.gameTemplate.findFirstOrThrow({ where: { slug: 'valheim' } });
    otherGameServerId = await make(valheim.id, 'No packs here', {
      SERVER_PASSWORD: 'TestPassword123',
    });
  });

  beforeEach(() => {
    index = goodIndex();
    versionResponse = {
      id: 'ver_pack',
      name: 'Test Pack 1.0',
      version_number: '1.0.0',
      game_versions: ['1.21.1'],
      loaders: ['fabric'],
      version_type: 'release',
      date_published: '2026-01-01T00:00:00Z',
      files: [
        {
          url: 'https://cdn.modrinth.com/pack/test.mrpack',
          filename: 'test.mrpack',
          primary: true,
          size: 4096,
          hashes: { sha512: 'packhash' },
        },
      ],
    };
    agentCalls = [];
  });

  after(async () => {
    app.agents.request = realRequest;
    await app.prisma.serverAllocation.updateMany({ where: { nodeId }, data: { serverId: null } });
    await app.prisma.server.deleteMany({ where: { nodeId } });
    await app.prisma.serverAllocation.deleteMany({ where: { nodeId } });
    await app.prisma.node.delete({ where: { id: nodeId } }).catch(() => undefined);
    await app.prisma.templateVariable.deleteMany({ where: { templateId: template.id } });
    await app.prisma.gameTemplate.delete({ where: { id: template.id } }).catch(() => undefined);
    for (const id of createdUsers) await deleteUser(app, id);
    await cleanup();
    await new Promise<void>((resolve) => registry.close(() => resolve()));
  });

  /* ------------------------------------------------ only where it belongs -- */

  it('is not there at all for a game that has no modpacks', async () => {
    for (const [method, url] of [
      ['GET', `/api/v1/servers/${otherGameServerId}/modpacks/search?q=x`],
      ['POST', `/api/v1/servers/${otherGameServerId}/modpacks`],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: auth(),
        payload: method === 'POST' ? { versionId: 'ver_pack' } : undefined,
      });
      assert.equal(response.statusCode, 404, `${method} ${url} → ${response.body}`);
    }
  });

  /* ------------------------------------------------------------ browsing -- */

  it('asks the registry for fabric modpacks, not for mods', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/modpacks/search?q=create`,
      headers: auth(),
    });
    assert.equal(response.statusCode, 200, response.body);

    // Both facets, and both for a reason: without the project type the list
    // fills with individual mods, and without the loader it fills with Forge
    // packs this panel cannot install.
    assert.match(lastFacets, /project_type:modpack/);
    assert.match(lastFacets, /categories:fabric/);

    assert.equal(response.json<{ data: unknown[] }>().data.length, 1);
  });

  /* ------------------------------------------------- what the node is told -- */

  it('installs, and hands the node only addresses it checked itself', async () => {
    const response = await install();
    assert.equal(response.statusCode, 200, response.body);

    const fetched = agentCalls
      .filter((call) => call.path.endsWith('/files/fetch'))
      .map((call) => call.body as { url: string; path: string });

    // The pack archive, then the mod inside it. Every URL came from the
    // registry and passed the allowlist; none of them came from the request.
    assert.equal(fetched.length, 2);
    assert.ok(
      fetched.every((entry) => entry.url.startsWith('https://cdn.modrinth.com/')),
      JSON.stringify(fetched),
    );
    assert.ok(
      fetched.some((entry) => entry.path === '/mods/example.jar'),
      JSON.stringify(fetched),
    );

    // Overrides are moved into place before the mods are fetched, so a pack
    // that ships its own mods folder does not collide with them.
    const order = agentCalls.map((call) => call.path.replace(/^.*\/files\//, ''));
    assert.ok(
      order.indexOf('rename') < order.lastIndexOf('fetch'),
      `overrides must land first: ${order.join(', ')}`,
    );
    // And the staging directory does not survive the install.
    assert.ok(
      agentCalls.some(
        (call) =>
          call.path.endsWith('/files/delete') &&
          JSON.stringify(call.body).includes('.storm-modpack'),
      ),
    );
  });

  it('refuses a pack whose files point somewhere the operator never allowed', async () => {
    // A host that resolves and is not on the allowlist. Somewhere unresolvable
    // would be rejected by DNS before either check ran, and would prove
    // nothing about the allowlist.
    index = goodIndex({
      files: [
        {
          path: 'mods/evil.jar',
          downloads: ['https://example.com/evil.jar'],
          fileSize: 10,
          hashes: {},
        },
      ],
    });

    const response = await install();
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.body, /only accepted from/i);
    // Nothing at all reached the node. The whole index is vetted before the
    // first write, so one bad entry stops the install rather than leaving a
    // half-built pack and a directory to clean up by hand.
    assert.equal(
      agentCalls.filter((call) => call.path.includes('/files/')).length,
      0,
      JSON.stringify(agentCalls),
    );
  });

  it('refuses a pack that reaches for an address on the node itself', async () => {
    // 127.0.0.1 is on this test's allowlist, so only the private-address check
    // can reject this one. That is the point: the two checks catch different
    // things and both have to be there.
    index = goodIndex({
      files: [
        {
          path: 'mods/ssrf.jar',
          downloads: ['https://127.0.0.1/latest/meta-data/'],
          fileSize: 10,
          hashes: {},
        },
      ],
    });

    const response = await install();
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.body, /will not fetch/i);
  });

  it('refuses a path that climbs out of the server directory', async () => {
    for (const path of ['../../etc/cron.d/backdoor', '/etc/passwd', 'mods\\..\\..\\escape.jar']) {
      index = goodIndex({
        files: [{ path, downloads: ['https://cdn.modrinth.com/x.jar'], fileSize: 10 }],
      });
      const response = await install();
      assert.equal(response.statusCode, 400, `${path} → ${response.body}`);
      assert.match(response.body, /absolute path|outside the server/i);
    }
  });

  it('leaves out the files a pack marks client-only', async () => {
    index = goodIndex({
      files: [
        {
          path: 'mods/server-side.jar',
          downloads: ['https://cdn.modrinth.com/a.jar'],
          fileSize: 10,
        },
        {
          path: 'mods/client-shaders.jar',
          downloads: ['https://cdn.modrinth.com/b.jar'],
          fileSize: 10,
          env: { client: 'required', server: 'unsupported' },
        },
      ],
    });

    const response = await install();
    assert.equal(response.statusCode, 200, response.body);

    const paths = agentCalls
      .filter((call) => call.path.endsWith('/files/fetch'))
      .map((call) => (call.body as { path: string }).path);
    assert.ok(paths.includes('/mods/server-side.jar'), JSON.stringify(paths));
    assert.ok(
      !paths.includes('/mods/client-shaders.jar'),
      'a client-only mod crashes the server on load',
    );

    const data = response.json<{ data: { skippedClientOnly: string[] } }>().data;
    assert.deepEqual(data.skippedClientOnly, ['mods/client-shaders.jar']);
  });

  /* --------------------------------------------- what the server can run -- */

  it('refuses a pack the server has no loader for', async () => {
    await app.prisma.serverVariable.updateMany({
      where: { server: { id: serverId }, key: 'PROJECT' },
      data: { value: 'paper' },
    });

    const response = await install();
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.body, /runs paper/);
    assert.match(response.body, /Startup/);
    // Nothing was written. A refusal that half-installs is worse than one that
    // does not install at all.
    assert.equal(agentCalls.filter((call) => call.path.includes('/files/')).length, 0);

    await app.prisma.serverVariable.updateMany({
      where: { server: { id: serverId }, key: 'PROJECT' },
      data: { value: 'fabric' },
    });
  });

  it('refuses a pack built for a different Minecraft version', async () => {
    index = goodIndex({ dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.16.9' } });

    const response = await install();
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.body, /1\.21\.1.*1\.20\.1/s);
  });

  it('refuses a Forge pack by name rather than installing mods nothing will load', async () => {
    index = goodIndex({ dependencies: { minecraft: '1.21.1', forge: '52.0.1' } });

    const response = await install();
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.body, /forge/i);
    assert.match(response.body, /Only Fabric packs/i);
  });

  it('will not rewrite a server that is running', async () => {
    await app.prisma.server.update({ where: { id: serverId }, data: { status: 'ONLINE' } });

    const response = await install();
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.body, /Stop the server/i);
    assert.equal(agentCalls.filter((call) => call.path.includes('/files/')).length, 0);

    await app.prisma.server.update({ where: { id: serverId }, data: { status: 'OFFLINE' } });
  });
});
