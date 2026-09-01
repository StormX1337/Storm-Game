import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { hashPassword } from '@storm/security';
import { cloneTemplate, createTestApp, deleteUser, registerUser, uniqueSuffix } from './helpers.js';
import type { RegisteredUser } from './helpers.js';

/**
 * The Minecraft plugin browser.
 *
 * Two things are being pinned down. That it exists only where the template
 * says so, rather than wherever a name happens to match. And that a customer
 * cannot choose what a node downloads — which is the whole security question
 * of this feature: "install this plugin" must not become "make the node fetch
 * this address and put the answer somewhere I can read it".
 *
 * The registry is a stub on localhost, both because the real one is not
 * reachable from a test and because a stub can answer with the hostile things
 * a real one would not.
 */
describe('plugin browser', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let registry: HttpServer;
  let registryUrl: string;
  let customer: RegisteredUser;
  let adminToken: string;
  let nodeId: string;
  let minecraftServerId: string;
  let otherGameServerId: string;
  let minecraftTemplate: { id: string; slug: string };
  const createdUsers: string[] = [];

  /** What the stub registry answers with for /version/:id. */
  let versionResponse: unknown = null;
  /** What it answers for /project/:id/version. */
  let projectVersions: unknown[] = [];
  /** The facets the panel asked the registry for, as sent. */
  let lastFacets = '';

  const auth = () => ({ authorization: `Bearer ${customer.accessToken}` });

  before(async () => {
    // A registry under the test's control, so a malicious answer is testable.
    registry = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url?.startsWith('/search')) {
        lastFacets = new URL(request.url, 'http://x').searchParams.get('facets') ?? '';
        response.end(
          JSON.stringify({
            hits: [
              {
                project_id: 'proj_essentials',
                slug: 'essentialsx',
                title: 'EssentialsX',
                description: 'The essential plugin suite.',
                downloads: 1000,
                follows: 10,
                icon_url: 'https://cdn.modrinth.com/icon.png',
                categories: ['utility'],
              },
            ],
          }),
        );
        return;
      }
      if (request.url?.includes('/version')) {
        // /project/:id/version is a list; /version/:id is one.
        response.end(
          JSON.stringify(request.url.startsWith('/project/') ? projectVersions : versionResponse),
        );
        return;
      }
      response.statusCode = 404;
      response.end('{}');
    });
    await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve));
    const address = registry.address();
    registryUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

    const context = await createTestApp({
      env: {
        MODRINTH_API_URL: registryUrl,
        // The stub serves downloads from itself, so it has to be allowed for
        // the happy path — the rejection tests point somewhere else.
        MODRINTH_DOWNLOAD_HOSTS: 'cdn.modrinth.com,127.0.0.1',
      },
    });
    app = context.app;
    cleanup = context.cleanup;

    customer = await registerUser(app);
    createdUsers.push(customer.id);

    const suffix = uniqueSuffix();
    const ownerRole = await app.prisma.role.findUniqueOrThrow({ where: { name: 'OWNER' } });
    const owner = await app.prisma.user.create({
      data: {
        email: `plug-owner-${suffix}@storm.test`,
        username: `plugowner${suffix}`,
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
        name: `plug-node-${suffix}`,
        location: 'Test',
        hostname: '127.0.0.1',
        ip: '127.0.0.1',
        scheme: 'http',
        memoryTotal: 8192,
        diskTotal: 51200,
      },
    });
    nodeId = node.id;
    for (const port of [27411, 27412]) {
      await app.prisma.serverAllocation.create({ data: { nodeId, ip: '127.0.0.1', port } });
    }

    const limits = {
      cpuLimit: 100,
      memoryLimit: 1024,
      diskLimit: 4096,
      swapLimit: 0,
      ioWeight: 500,
      pidsLimit: 128,
      oomKill: true,
    };

    // A private copy: this suite toggles features, and the seeded template is
    // shared with every other suite running at the same time.
    minecraftTemplate = await cloneTemplate(app, 'minecraft-java', ['plugins']);

    const make = async (
      slug: string,
      name: string,
      environment: Record<string, string> = {},
    ): Promise<string> => {
      const template =
        slug === 'minecraft-java'
          ? { id: minecraftTemplate.id }
          : await app.prisma.gameTemplate.findFirstOrThrow({ where: { slug } });
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/servers',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name,
          nodeId,
          templateId: template.id,
          ownerId: customer.id,
          environment,
          limits,
          skipInstall: true,
        },
      });
      assert.equal(created.statusCode, 201, created.body);
      return created.json<{ data: { id: string } }>().data.id;
    };

    minecraftServerId = await make('minecraft-java', 'Plugin server');
    // Valheim insists on a password, which is nothing to do with plugins but
    // is what the template requires to be created at all.
    otherGameServerId = await make('valheim', 'No plugins here', {
      SERVER_PASSWORD: 'TestPassword123',
    });
  });

  after(async () => {
    await app.prisma.serverAllocation.updateMany({ where: { nodeId }, data: { serverId: null } });
    await app.prisma.server.deleteMany({ where: { nodeId } });
    await app.prisma.serverAllocation.deleteMany({ where: { nodeId } });
    await app.prisma.node.delete({ where: { id: nodeId } }).catch(() => undefined);
    for (const id of createdUsers) await deleteUser(app, id);
    await cleanup();
    await new Promise<void>((resolve) => registry.close(() => resolve()));
  });

  /* ------------------------------------------------ only where it belongs -- */

  it('is not there at all for a game that has no plugins', async () => {
    // Not hidden in the panel — absent from the API. A customer calling it
    // directly on their Valheim server gets the same answer as one who cannot
    // see the tab.
    for (const [method, url] of [
      ['GET', `/api/v1/servers/${otherGameServerId}/plugins`],
      ['GET', `/api/v1/servers/${otherGameServerId}/plugins/search?q=x`],
      ['POST', `/api/v1/servers/${otherGameServerId}/plugins`],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: auth(),
        ...(method === 'POST' ? { payload: { versionId: 'v1' } } : {}),
      });
      assert.equal(response.statusCode, 404, `${method} ${url}`);
    }
  });

  it('is there for the template that declares the feature', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${minecraftServerId}/plugins/search?q=essentials`,
      headers: auth(),
    });

    assert.equal(response.statusCode, 200, response.body);
    const hits = response.json<{ data: { title: string; projectId: string }[] }>().data;
    assert.equal(hits[0]?.title, 'EssentialsX');
  });

  it('follows the template rather than the slug', async () => {
    // The reason the feature is a column and not a name match: an operator's
    // own Minecraft template must keep the browser, and turning it off must
    // actually turn it off.
    // This suite's own template, so switching it off disturbs nobody else.
    const template = await app.prisma.gameTemplate.findUniqueOrThrow({
      where: { id: minecraftTemplate.id },
    });

    try {
      await app.prisma.gameTemplate.update({ where: { id: template.id }, data: { features: [] } });

      const off = await app.inject({
        method: 'GET',
        url: `/api/v1/servers/${minecraftServerId}/plugins`,
        headers: auth(),
      });
      assert.equal(off.statusCode, 404, 'the slug still says minecraft; the feature does not');
    } finally {
      await app.prisma.gameTemplate.update({
        where: { id: template.id },
        data: { features: template.features },
      });
    }
  });

  /* ----------------------------------------- what a node may be told to get -- */

  /** Makes the stub answer with one file at whatever URL a test names. */
  function versionServingFrom(url: string, loaders: string[] = ['paper']): void {
    versionResponse = {
      id: 'v1',
      name: 'v1',
      version_number: '1.0',
      game_versions: ['1.21'],
      loaders,
      version_type: 'release',
      date_published: new Date().toISOString(),
      files: [{ url, filename: 'plugin.jar', primary: true, size: 1024, hashes: {} }],
    };
  }

  const install = () =>
    app.inject({
      method: 'POST',
      url: `/api/v1/servers/${minecraftServerId}/plugins`,
      headers: auth(),
      payload: { versionId: 'v1' },
    });

  it('refuses a host the operator has not allowed', async () => {
    // Deliberately a name that resolves. An unresolvable one would be turned
    // away by the address check and prove nothing about the allowlist — which
    // is how the first version of this test passed with the allowlist removed.
    versionServingFrom('https://example.com/plugin.jar');

    const response = await install();
    assert.equal(response.statusCode, 400, response.body);
    assert.match(
      response.json<{ error: { message: string } }>().error.message,
      /only accepted from/i,
    );
  });

  it('refuses an address inside the network even when its host is allowed', async () => {
    // The mirror image: 127.0.0.1 is in this suite's allowlist, so only the
    // address check can stop it. A registry that started answering with links
    // to the node's own network must not turn the node into a fetcher for it.
    versionServingFrom('https://127.0.0.1/plugin.jar');

    const response = await install();
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.json<{ error: { message: string } }>().error.message, /will not fetch/i);
  });

  it('refuses a scheme that is not https, and the metadata service', async () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      'file:///etc/passwd',
      'https://10.0.0.5/internal.jar',
    ]) {
      versionServingFrom(url);
      const response = await install();
      assert.equal(response.statusCode, 400, `${url} must be refused: ${response.body}`);
    }
  });

  it('asks the registry only for builds a plugins folder can load', async () => {
    // Searching by project type is what put Fabric API and Sodium in front of
    // someone running Paper. What decides whether a jar works is its loader.
    lastFacets = '';
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${minecraftServerId}/plugins/search?q=api`,
      headers: auth(),
    });
    assert.equal(response.statusCode, 200, response.body);

    const facets = JSON.parse(lastFacets) as string[][];
    assert.ok(
      facets[0]?.includes('categories:paper') && facets[0]?.includes('categories:spigot'),
      `expected loader facets, got ${lastFacets}`,
    );
    assert.ok(!lastFacets.includes('project_type:mod'), 'asking for mods is what offered mods');
  });

  it('hides a build made for a loader this server does not use', async () => {
    projectVersions = [
      {
        id: 'fabric-only',
        name: 'Fabric build',
        version_number: '1.0',
        game_versions: ['1.21'],
        loaders: ['fabric'],
        version_type: 'release',
        date_published: new Date().toISOString(),
        files: [
          {
            url: 'https://cdn.modrinth.com/a.jar',
            filename: 'a.jar',
            primary: true,
            size: 1,
            hashes: {},
          },
        ],
      },
      {
        id: 'paper-build',
        name: 'Paper build',
        version_number: '1.0',
        game_versions: ['1.21'],
        loaders: ['paper', 'spigot'],
        version_type: 'release',
        date_published: new Date().toISOString(),
        files: [
          {
            url: 'https://cdn.modrinth.com/b.jar',
            filename: 'b.jar',
            primary: true,
            size: 1,
            hashes: {},
          },
        ],
      },
    ];

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${minecraftServerId}/plugins/proj_x/versions`,
      headers: auth(),
    });
    assert.equal(response.statusCode, 200, response.body);

    const ids = response.json<{ data: { versionId: string }[] }>().data.map((v) => v.versionId);
    assert.deepEqual(ids, ['paper-build'], 'a Fabric build does nothing in a plugins folder');
  });

  it('refuses to install a build for the wrong loader, whatever the list showed', async () => {
    // Enforced rather than merely hidden: the version id is the caller's, and
    // a stale page or a hand-made request must not get a Fabric jar installed.
    versionServingFrom('https://cdn.modrinth.com/data/x/mod.jar', ['fabric']);

    const response = await install();
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.json<{ error: { message: string } }>().error.message, /loader|Paper/i);
  });

  it('refuses anything that is not a plugin jar', async () => {
    versionResponse = {
      id: 'v1',
      name: 'v1',
      version_number: '1.0',
      game_versions: ['1.21'],
      loaders: ['paper'],
      version_type: 'release',
      date_published: new Date().toISOString(),
      files: [
        {
          url: 'https://cdn.modrinth.com/data/x/run.sh',
          filename: 'run.sh',
          primary: true,
          size: 10,
          hashes: {},
        },
      ],
    };

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${minecraftServerId}/plugins`,
      headers: auth(),
      payload: { versionId: 'v1' },
    });
    assert.equal(response.statusCode, 400, response.body);
  });

  it('refuses a file too large to be a plugin', async () => {
    versionResponse = {
      id: 'v1',
      name: 'v1',
      version_number: '1.0',
      game_versions: ['1.21'],
      loaders: ['paper'],
      version_type: 'release',
      date_published: new Date().toISOString(),
      files: [
        {
          url: 'https://cdn.modrinth.com/data/x/huge.jar',
          filename: 'huge.jar',
          primary: true,
          size: 900 * 1024 * 1024,
          hashes: {},
        },
      ],
    };

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${minecraftServerId}/plugins`,
      headers: auth(),
      payload: { versionId: 'v1' },
    });
    assert.equal(response.statusCode, 400, response.body);
  });

  it('takes no url from the caller, whatever they send', async () => {
    // The request body is one opaque id. Extra fields must not become
    // instructions — zod strips them, and this is the test that says so.
    versionResponse = {
      id: 'v1',
      name: 'v1',
      version_number: '1.0',
      game_versions: ['1.21'],
      loaders: ['paper'],
      version_type: 'release',
      date_published: new Date().toISOString(),
      files: [
        {
          url: 'https://evil.example.com/payload.jar',
          filename: 'plugin.jar',
          primary: true,
          size: 1024,
          hashes: {},
        },
      ],
    };

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${minecraftServerId}/plugins`,
      headers: auth(),
      payload: {
        versionId: 'v1',
        url: 'https://cdn.modrinth.com/allowed.jar',
        path: '/../../etc/cron.d/backdoor',
      },
    });

    // Refused on the registry's answer, which is the only source that counts.
    assert.equal(response.statusCode, 400, response.body);
  });

  it('refuses a plugin jar named to escape the plugins directory', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/servers/${minecraftServerId}/plugins/${encodeURIComponent('../../server.properties')}`,
      headers: auth(),
    });
    assert.equal(response.statusCode, 400, response.body);
  });

  /* ------------------------------------------------------------ access -- */

  it('needs write access to install, not just to look', async () => {
    const stranger = await registerUser(app);
    createdUsers.push(stranger.id);

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${minecraftServerId}/plugins`,
      headers: { authorization: `Bearer ${stranger.accessToken}` },
      payload: { versionId: 'v1' },
    });
    assert.equal(response.statusCode, 404, "someone else's server is not theirs to change");
  });
});
