import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { hashPassword } from '@storm/security';
import { MODPACK_LOADER } from '@storm/types';
import { createTestApp, deleteUser, registerUser, uniqueSuffix } from './helpers.js';
import type { RegisteredUser } from './helpers.js';

/**
 * The disk limit, enforced.
 *
 * It used to be bookkeeping: counted when placing a server on a node, shown in
 * the panel, handed to the node agent — which validates it and drops it, since
 * Docker's own quota needs a filesystem most hosts are not running. So a
 * customer sold 10 GiB could fill the node through the file manager and
 * nothing stopped them.
 *
 * These pin down both halves: what is refused once a server is over, and what
 * must keep working so being over is recoverable.
 */
describe('disk limit', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let customer: RegisteredUser;
  let adminToken: string;
  let nodeId: string;
  let serverId: string;
  const createdUsers: string[] = [];

  const DISK_MB = 2048;
  const PACK_MINECRAFT = '1.20.1';

  /** Records what the node last reported this server to be using. */
  async function reportUsage(mib: number): Promise<void> {
    await app.prisma.serverStat.create({
      data: {
        serverId,
        cpuPercent: 0,
        memoryBytes: BigInt(0),
        diskBytes: BigInt(mib) * BigInt(1024 * 1024),
        networkRx: BigInt(0),
        networkTx: BigInt(0),
      },
    });
  }

  const auth = () => ({ authorization: `Bearer ${customer.accessToken}` });

  /** A restorable backup, on whatever storage the seed set up. */
  async function createBackup() {
    const storage = await app.prisma.backupStorage.findFirstOrThrow();
    return app.prisma.backup.create({
      data: {
        serverId,
        storageId: storage.id,
        name: 'before the world got big',
        status: 'COMPLETED',
        bytes: BigInt(1024),
        storageKey: 'test/backup.tar.gz',
        completedAt: new Date(),
      },
    });
  }

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;

    customer = await registerUser(app);
    createdUsers.push(customer.id);

    const ownerRole = await app.prisma.role.findUniqueOrThrow({ where: { name: 'OWNER' } });
    const suffix = uniqueSuffix();
    const owner = await app.prisma.user.create({
      data: {
        email: `disk-owner-${suffix}@storm.test`,
        username: `diskowner${suffix}`,
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
        name: `disk-node-${suffix}`,
        location: 'Test',
        hostname: '127.0.0.1',
        ip: '127.0.0.1',
        scheme: 'http',
        memoryTotal: 8192,
        diskTotal: 51200,
      },
    });
    nodeId = node.id;
    await app.prisma.serverAllocation.create({ data: { nodeId, ip: '127.0.0.1', port: 26711 } });

    const template = await app.prisma.gameTemplate.findFirstOrThrow({
      where: { slug: 'minecraft-java' },
    });

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'Disk server',
        nodeId,
        templateId: template.id,
        ownerId: customer.id,
        environment: {},
        limits: {
          cpuLimit: 100,
          memoryLimit: 1024,
          diskLimit: DISK_MB,
          swapLimit: 0,
          ioWeight: 500,
          networkLimitMbps: 0,
          pidsLimit: 128,
          oomKill: true,
        },
        skipInstall: true,
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    serverId = created.json<{ data: { id: string } }>().data.id;
  });

  after(async () => {
    await app.prisma.serverStat.deleteMany({ where: { serverId } });
    await app.prisma.serverAllocation.updateMany({ where: { nodeId }, data: { serverId: null } });
    await app.prisma.server.deleteMany({ where: { nodeId } });
    await app.prisma.serverAllocation.deleteMany({ where: { nodeId } });
    await app.prisma.node.delete({ where: { id: nodeId } }).catch(() => undefined);
    for (const id of createdUsers) await deleteUser(app, id);
    await cleanup();
  });

  /* ------------------------------------------------- under the limit -- */

  it('does not get in the way of a server with room left', async () => {
    await reportUsage(100);

    // The agent is not running, so the write itself cannot succeed — but it
    // must fail on reaching the node, never on the quota.
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/files/write`,
      headers: auth(),
      payload: { path: '/server.properties', content: 'motd=hello' },
    });
    assert.notEqual(response.statusCode, 409, response.body);
  });

  it('allows a server that has never reported, rather than guessing', async () => {
    await app.prisma.serverStat.deleteMany({ where: { serverId } });

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/files/write`,
      headers: auth(),
      payload: { path: '/a.txt', content: 'x' },
    });
    assert.notEqual(
      response.statusCode,
      409,
      'a brand new server has no sample yet and must not be locked out',
    );
  });

  /* -------------------------------------------------- over the limit -- */

  describe('once the server is over its limit', () => {
    before(async () => {
      await app.prisma.serverStat.deleteMany({ where: { serverId } });
      await reportUsage(DISK_MB + 64);
    });

    const refused = [
      ['writing a file', 'POST', 'files/write', { path: '/a.txt', content: 'x' }],
      ['copying a file', 'POST', 'files/copy', { path: '/a.txt' }],
      ['compressing files', 'POST', 'files/compress', { path: '/', files: ['a.txt'] }],
      ['extracting an archive', 'POST', 'files/decompress', { path: '/', file: 'a.zip' }],
    ] as const;

    for (const [label, method, path, payload] of refused) {
      it(`refuses ${label}`, async () => {
        const response = await app.inject({
          method,
          url: `/api/v1/servers/${serverId}/${path}`,
          headers: auth(),
          payload,
        });

        assert.equal(response.statusCode, 409, response.body);
        const error = response.json<{ error: { code: string; message: string } }>().error;
        assert.equal(error.code, 'RESOURCE_LIMIT_REACHED');
        assert.match(
          error.message,
          /\d+ MiB of its \d+ MiB/,
          'the message should name both numbers, so the customer knows how far over they are',
        );
      });
    }

    it('refuses to start it, since starting is what lets it write more', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/servers/${serverId}/power`,
        headers: auth(),
        payload: { action: 'start' },
      });
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(
        response.json<{ error: { code: string } }>().error.code,
        'RESOURCE_LIMIT_REACHED',
      );
    });

    it('leaves the way out open: stopping and deleting still work', async () => {
      // A limit that traps someone is a bug, not a limit. Neither of these can
      // grow the directory, and deleting is the whole remedy.
      const stop = await app.inject({
        method: 'POST',
        url: `/api/v1/servers/${serverId}/power`,
        headers: auth(),
        payload: { action: 'stop' },
      });
      assert.notEqual(stop.statusCode, 409, 'stopping must never be blocked by the quota');

      const remove = await app.inject({
        method: 'POST',
        url: `/api/v1/servers/${serverId}/files/delete`,
        headers: auth(),
        payload: { paths: ['/a.txt'] },
      });
      assert.notEqual(remove.statusCode, 409, 'deleting is how a customer gets back under');
    });

    it('refuses a restore that would land on top of what is already there', async () => {
      const backup = await createBackup();
      await app.prisma.server.update({ where: { id: serverId }, data: { status: 'OFFLINE' } });

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/servers/${serverId}/backups/${backup.id}/restore`,
        headers: auth(),
        payload: { truncate: false },
      });
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(
        response.json<{ error: { code: string } }>().error.code,
        'RESOURCE_LIMIT_REACHED',
      );

      await app.prisma.backup.delete({ where: { id: backup.id } });
    });

    it('allows a restore that wipes first, because that is a way back under', async () => {
      // Refusing this one would be the trap the limit must not become: the
      // customer's own backup is often the shortest route back under quota.
      const backup = await createBackup();
      await app.prisma.server.update({ where: { id: serverId }, data: { status: 'OFFLINE' } });

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/servers/${serverId}/backups/${backup.id}/restore`,
        headers: auth(),
        payload: { truncate: true },
      });
      assert.notEqual(response.statusCode, 409, response.body);

      await app.prisma.backup.delete({ where: { id: backup.id } });
    });

    it('does not block an administrator raising the limit instead', async () => {
      // The other way out. It has to keep working while the server is over,
      // or the operator's only tool is telling the customer to delete things.
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/servers/${serverId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { limits: { diskLimit: DISK_MB * 2 } },
      });
      assert.equal(response.statusCode, 200, response.body);

      // And with room again, writing is allowed.
      const write = await app.inject({
        method: 'POST',
        url: `/api/v1/servers/${serverId}/files/write`,
        headers: auth(),
        payload: { path: '/a.txt', content: 'x' },
      });
      assert.notEqual(write.statusCode, 409, 'raising the limit should immediately unblock it');

      await app.inject({
        method: 'PATCH',
        url: `/api/v1/servers/${serverId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { limits: { diskLimit: DISK_MB } },
      });
    });
  });

  /* --------------------------------------------- what the node is told -- */

  describe('unpacking an archive', () => {
    /** Runs one decompress against a stubbed node and returns what it was sent. */
    async function decompress(): Promise<Record<string, unknown>> {
      const real = app.agents.request;
      let sent: Record<string, unknown> = {};
      app.agents.request = (async (
        _node: unknown,
        _path: string,
        options?: { body?: Record<string, unknown> },
      ) => {
        sent = options?.body ?? {};
        return {};
      }) as typeof app.agents.request;

      try {
        const response = await app.inject({
          method: 'POST',
          url: `/api/v1/servers/${serverId}/files/decompress`,
          headers: auth(),
          payload: { path: '/', file: 'pack.zip' },
        });
        assert.equal(response.statusCode, 200, response.body);
        return sent;
      } finally {
        app.agents.request = real;
      }
    }

    it('hands the node what is left of the budget, not just permission to start', async () => {
      // Being under the limit when the extraction starts says nothing about
      // where it ends: a megabyte of zip holds a hundred gigabytes, and the
      // disk it fills belongs to every other customer on the node too.
      await app.prisma.serverStat.deleteMany({ where: { serverId } });
      await reportUsage(48);

      const sent = await decompress();
      assert.equal(sent.maxBytes, (DISK_MB - 48) * 1024 * 1024);
    });

    it('sends no budget at all for a server sold unmetered disk', async () => {
      await app.prisma.server.update({ where: { id: serverId }, data: { diskLimit: 0 } });
      try {
        const sent = await decompress();
        assert.equal('maxBytes' in sent, false, JSON.stringify(sent));
      } finally {
        await app.prisma.server.update({
          where: { id: serverId },
          data: { diskLimit: DISK_MB },
        });
      }
    });
  });

  describe('every path that adds bytes spends from the same budget', () => {
    /**
     * Runs one request against a stubbed node and registry, and returns every
     * body the node was sent.
     *
     * The registry is stubbed too, because it lives on the internet: without
     * it these routes fail before they ever reach the node, and a test that
     * asserts on a call that never happened asserts nothing.
     */
    async function sent(
      run: () => Promise<{ statusCode: number; body: string }>,
    ): Promise<Record<string, unknown>[]> {
      const realAgent = app.agents.request;
      const realPlugin = app.plugins.resolveDownload;
      const realPlan = app.modpacks.resolvePlan;
      const bodies: Record<string, unknown>[] = [];

      app.agents.request = (async (
        _node: unknown,
        _path: string,
        options?: {
          body?: Record<string, unknown>;
          query?: Record<string, unknown>;
          stream?: AsyncIterable<Buffer>;
        },
      ) => {
        bodies.push({ ...(options?.query ?? {}), ...(options?.body ?? {}) });
        // A multipart upload will not advance to the next part until this one
        // has been read, so a stub that ignores the stream hangs the request.
        if (options?.stream) for await (const _chunk of options.stream) void _chunk;
        return { bytes: 0, sha512: 'x', entries: [] };
      }) as typeof app.agents.request;

      app.plugins.resolveDownload = (async () => ({
        url: 'https://example.invalid/plugin.jar',
        filename: 'plugin.jar',
        sha512: 'a'.repeat(128),
      })) as typeof app.plugins.resolveDownload;

      app.modpacks.resolvePlan = (async () => ({
        name: 'Test pack',
        versionNumber: '1.0.0',
        minecraft: PACK_MINECRAFT,
        loaderVersion: '0.15.0',
        packUrl: 'https://example.invalid/pack.mrpack',
        packBytes: 1024,
        packSha512: 'b'.repeat(128),
        files: [
          {
            path: 'mods/one.jar',
            url: 'https://example.invalid/one.jar',
            sha512: 'c'.repeat(128),
            bytes: 512,
          },
        ],
        totalBytes: 1536,
        skippedClientOnly: [],
      })) as unknown as typeof app.modpacks.resolvePlan;

      try {
        await run();
        return bodies;
      } finally {
        app.agents.request = realAgent;
        app.plugins.resolveDownload = realPlugin;
        app.modpacks.resolvePlan = realPlan;
      }
    }

    /** A multipart body with one part per file, built by hand. */
    function multipart(files: { name: string; content: string }[]): {
      body: string;
      contentType: string;
    } {
      const boundary = '----storm-test-boundary';
      const parts = files
        .map(
          (file) =>
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="files"; filename="${file.name}"\r\n` +
            'Content-Type: application/octet-stream\r\n\r\n' +
            `${file.content}\r\n`,
        )
        .join('');
      return {
        body: `${parts}--${boundary}--\r\n`,
        contentType: `multipart/form-data; boundary=${boundary}`,
      };
    }

    it('hands an upload what is left of the disk, not just permission to start', async () => {
      await app.prisma.serverStat.deleteMany({ where: { serverId } });
      await reportUsage(DISK_MB - 8);
      const { body, contentType } = multipart([{ name: 'one.jar', content: 'x' }]);

      const bodies = await sent(() =>
        app.inject({
          method: 'POST',
          url: `/api/v1/servers/${serverId}/files/upload`,
          headers: { ...auth(), 'content-type': contentType },
          payload: body,
        }),
      );

      assert.equal(bodies.length, 1, JSON.stringify(bodies));
      assert.equal(bodies[0]?.maxBytes, 8 * 1024 * 1024, JSON.stringify(bodies[0]));
    });

    it('spends the budget down across the files in one upload', async () => {
      // Five files must not each be handed the whole allowance, or the limit
      // is per file rather than per server.
      await app.prisma.serverStat.deleteMany({ where: { serverId } });
      await reportUsage(DISK_MB - 8);
      const { body, contentType } = multipart([
        { name: 'one.jar', content: 'x' },
        { name: 'two.jar', content: 'y' },
      ]);

      const realAgent = app.agents.request;
      const seen: number[] = [];
      app.agents.request = (async (
        _node: unknown,
        _path: string,
        options?: { query?: Record<string, unknown>; stream?: AsyncIterable<Buffer> },
      ) => {
        seen.push(Number(options?.query?.maxBytes));
        if (options?.stream) for await (const _chunk of options.stream) void _chunk;
        // Each file claims a megabyte of the allowance.
        return { bytes: 1024 * 1024 };
      }) as typeof app.agents.request;

      try {
        await app.inject({
          method: 'POST',
          url: `/api/v1/servers/${serverId}/files/upload`,
          headers: { ...auth(), 'content-type': contentType },
          payload: body,
        });
      } finally {
        app.agents.request = realAgent;
      }

      assert.equal(seen.length, 2, JSON.stringify(seen));
      assert.equal(seen[0], 8 * 1024 * 1024);
      assert.equal(
        seen[1],
        7 * 1024 * 1024,
        'the second file was handed the whole allowance again',
      );
    });

    it('bounds a plugin install by what is left, not just by what a plugin may weigh', async () => {
      // A plugin may be a quarter of a gigabyte. That is a sanity cap on what
      // counts as a plugin, not permission to write one onto a full server.
      await app.prisma.serverStat.deleteMany({ where: { serverId } });
      await reportUsage(DISK_MB - 4);

      const bodies = await sent(() =>
        app.inject({
          method: 'POST',
          url: `/api/v1/servers/${serverId}/plugins`,
          headers: auth(),
          payload: { versionId: 'whatever' },
        }),
      );

      const fetch = bodies.find((body) => typeof body.url === 'string');
      assert.ok(fetch, `the node was never asked to fetch anything: ${JSON.stringify(bodies)}`);
      assert.equal(fetch.maxBytes, 4 * 1024 * 1024, JSON.stringify(fetch));
    });

    /** A pack only installs onto a stopped Fabric server pinned to its version. */
    async function makeInstallable(): Promise<void> {
      await app.prisma.server.update({
        where: { id: serverId },
        data: { status: 'OFFLINE' },
      });
      for (const [key, value] of [
        ['PROJECT', MODPACK_LOADER],
        ['MINECRAFT_VERSION', PACK_MINECRAFT],
      ]) {
        await app.prisma.serverVariable.upsert({
          where: { serverId_key: { serverId, key: key! } },
          create: { serverId, key: key!, value: value! },
          update: { value: value! },
        });
      }
    }

    it('sends the extraction a budget when a modpack unpacks one', async () => {
      // The modpack path called decompress with no budget at all, which the
      // node reads as unmetered — the panel's own code walking around the
      // guard that stops an archive filling a shared disk.
      await app.prisma.serverStat.deleteMany({ where: { serverId } });
      await reportUsage(100);
      await makeInstallable();

      const bodies = await sent(() =>
        app.inject({
          method: 'POST',
          url: `/api/v1/servers/${serverId}/modpacks`,
          headers: auth(),
          payload: { versionId: 'whatever' },
        }),
      );

      const decompress = bodies.find((body) => typeof body.file === 'string');
      assert.ok(decompress, `nothing was extracted: ${JSON.stringify(bodies)}`);
      assert.ok(
        typeof decompress.maxBytes === 'number',
        `the extraction was sent no budget: ${JSON.stringify(decompress)}`,
      );
    });
  });

  /* ------------------------------------------------------- unlimited -- */

  it('treats a limit of zero as unlimited, as every other limit does', async () => {
    await app.prisma.server.update({ where: { id: serverId }, data: { diskLimit: 0 } });
    await app.prisma.serverStat.deleteMany({ where: { serverId } });
    await reportUsage(500_000);

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/files/write`,
      headers: auth(),
      payload: { path: '/a.txt', content: 'x' },
    });
    assert.notEqual(response.statusCode, 409, response.body);

    await app.prisma.server.update({ where: { id: serverId }, data: { diskLimit: DISK_MB } });
  });
});
