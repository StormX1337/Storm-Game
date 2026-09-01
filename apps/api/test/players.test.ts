import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Node } from '@storm/database';
import { hashPassword } from '@storm/security';
import { createTestApp, deleteUser, registerUser, uniqueSuffix } from './helpers.js';
import type { RegisteredUser } from './helpers.js';

/**
 * Operators, whitelist and bans.
 *
 * The security question is narrow and sharp. Every change here is carried out
 * as a console command, and the agent submits a command by writing it followed
 * by a newline — so a "player name" containing one would be a second command.
 * Holding `servers.players` is meant to allow opping and banning, not running
 * anything at all on the console, and these check that the difference holds.
 */
describe('player management', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let customer: RegisteredUser;
  let adminToken: string;
  let nodeId: string;
  let serverId: string;
  const createdUsers: string[] = [];

  /** Every command the routes asked the node to run. */
  let commands: string[] = [];
  let realRequest: FastifyInstance['agents']['request'];
  let propertiesContent = 'white-list=false\nmotd=hello\n';

  const auth = () => ({ authorization: `Bearer ${customer.accessToken}` });

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;
    realRequest = app.agents.request;

    // Stands in for a node: records commands, and serves Minecraft's files.
    app.agents.request = (async (
      _node: Node,
      path: string,
      options?: { body?: unknown; query?: Record<string, string> },
    ) => {
      if (path.endsWith('/command')) {
        commands.push((options?.body as { command: string }).command);
        return {};
      }
      if (path.includes('/files/contents')) {
        const wanted = String((options as { query?: { path?: string } })?.query?.path ?? '');
        if (wanted.endsWith('server.properties')) {
          return { content: propertiesContent };
        }
        return {
          content: JSON.stringify([
            { uuid: '11111111-1111-1111-1111-111111111111', name: 'Notch', level: 4 },
          ]),
        };
      }
      return {};
    }) as typeof app.agents.request;

    customer = await registerUser(app);
    createdUsers.push(customer.id);

    const suffix = uniqueSuffix();
    const ownerRole = await app.prisma.role.findUniqueOrThrow({ where: { name: 'OWNER' } });
    const owner = await app.prisma.user.create({
      data: {
        email: `play-owner-${suffix}@storm.test`,
        username: `playowner${suffix}`,
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
        name: `play-node-${suffix}`,
        location: 'Test',
        hostname: '127.0.0.1',
        ip: '127.0.0.1',
        scheme: 'http',
        memoryTotal: 8192,
        diskTotal: 51200,
      },
    });
    nodeId = node.id;
    await app.prisma.serverAllocation.create({ data: { nodeId, ip: '127.0.0.1', port: 27511 } });

    const template = await app.prisma.gameTemplate.findFirstOrThrow({
      where: { slug: 'minecraft-java' },
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'Player server',
        nodeId,
        templateId: template.id,
        ownerId: customer.id,
        environment: {},
        limits: {
          cpuLimit: 100,
          memoryLimit: 1024,
          diskLimit: 4096,
          swapLimit: 0,
          ioWeight: 500,
          pidsLimit: 128,
          oomKill: true,
        },
        skipInstall: true,
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    serverId = created.json<{ data: { id: string } }>().data.id;

    // Running, so the commands are allowed through.
    await app.prisma.server.update({
      where: { id: serverId },
      data: { status: 'ONLINE', installedAt: new Date() },
    });
  });

  after(async () => {
    app.agents.request = realRequest;
    await app.prisma.serverAllocation.updateMany({ where: { nodeId }, data: { serverId: null } });
    await app.prisma.server.deleteMany({ where: { nodeId } });
    await app.prisma.serverAllocation.deleteMany({ where: { nodeId } });
    await app.prisma.node.delete({ where: { id: nodeId } }).catch(() => undefined);
    for (const id of createdUsers) await deleteUser(app, id);
    await cleanup();
  });

  const post = (path: string, payload: unknown) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/players/${path}`,
      headers: auth(),
      payload,
    });

  /* ------------------------------------------------------- the commands -- */

  it('turns each action into the command Minecraft understands', async () => {
    commands = [];

    assert.equal((await post('operators', { name: 'Notch' })).statusCode, 200);
    assert.equal((await post('whitelist', { name: 'Notch' })).statusCode, 200);
    assert.equal((await post('bans', { name: 'Griefer', reason: 'broke spawn' })).statusCode, 200);
    assert.equal((await post('whitelist/enabled', { enabled: true })).statusCode, 200);
    assert.equal((await post('kick', { name: 'Notch' })).statusCode, 200);

    assert.deepEqual(commands, [
      'op Notch',
      'whitelist add Notch',
      'ban Griefer broke spawn',
      'whitelist on',
      'kick Notch',
    ]);
  });

  /* -------------------------------------------------- the injection guard -- */

  it('refuses a name that would smuggle in a second command', async () => {
    // The agent submits a command by writing it and a newline. A name with one
    // in it would run whatever follows, turning "may manage players" into "may
    // run anything on the console".
    commands = [];

    const hostile = [
      'Notch\nop Attacker',
      'Notch\rop Attacker',
      'Notch\r\nstop',
      'Notch op Attacker',
      'Notch; stop',
      '../../etc/passwd',
      'a'.repeat(64),
      '',
    ];

    for (const name of hostile) {
      const response = await post('operators', { name });
      assert.equal(response.statusCode, 400, `${JSON.stringify(name)} must be refused`);
    }

    assert.deepEqual(commands, [], 'not one of those may have reached the console');
  });

  it('refuses a ban reason that would smuggle in a second command', async () => {
    commands = [];
    const response = await post('bans', { name: 'Griefer', reason: 'rude\nstop' });

    assert.equal(response.statusCode, 400, response.body);
    assert.deepEqual(commands, []);
  });

  it('refuses a hostile name in the path, not only in a body', async () => {
    commands = [];
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/servers/${serverId}/players/operators/${encodeURIComponent('Notch\nstop')}`,
      headers: auth(),
    });

    assert.notEqual(response.statusCode, 200, response.body);
    assert.deepEqual(commands, []);
  });

  it('refuses an address that is not one', async () => {
    commands = [];
    const response = await post('ip-bans', { ip: '1.2.3.4 ; stop' });

    assert.equal(response.statusCode, 400, response.body);
    assert.deepEqual(commands, []);
  });

  /* ------------------------------------------------- when it cannot work -- */

  it('says why a change needs a running server, rather than losing it', async () => {
    // Editing ops.json under a running server is ignored and undone at
    // shutdown; doing it while stopped and then starting works, but the panel
    // has no way to know which. Saying so beats a change that appears to land.
    await app.prisma.server.update({ where: { id: serverId }, data: { status: 'OFFLINE' } });
    commands = [];

    const response = await post('operators', { name: 'Notch' });
    assert.equal(response.statusCode, 409, response.body);
    assert.match(
      response.json<{ error: { message: string } }>().error.message,
      /running/i,
      'the message has to name the actual obstacle',
    );
    assert.deepEqual(commands, []);

    await app.prisma.server.update({ where: { id: serverId }, data: { status: 'ONLINE' } });
  });

  it('still reads the lists while the server is off', async () => {
    // The files are on disk either way, and someone deciding whether to start
    // a server wants to see who is opped first.
    await app.prisma.server.update({ where: { id: serverId }, data: { status: 'OFFLINE' } });

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/players`,
      headers: auth(),
    });
    assert.equal(response.statusCode, 200, response.body);

    const data = response.json<{ data: { operators: { name: string }[]; live: boolean } }>().data;
    assert.equal(data.operators[0]?.name, 'Notch');
    assert.equal(data.live, false, 'and is honest that this is the last written state');

    await app.prisma.server.update({ where: { id: serverId }, data: { status: 'ONLINE' } });
  });

  /* ------------------------------------------------------- where it is -- */

  it('reports whether the whitelist is actually enforced', async () => {
    // The list and the switch are separate things in Minecraft. A panel that
    // showed the list without the switch would let someone curate a whitelist
    // that is never consulted, and think they had locked the server down.
    const read = async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/servers/${serverId}/players`,
        headers: auth(),
      });
      return response.json<{ data: { whitelistEnabled: boolean } }>().data.whitelistEnabled;
    };

    propertiesContent = 'white-list=false\nmotd=hello\n';
    assert.equal(await read(), false);

    propertiesContent = 'motd=hello\nwhite-list=true\n';
    assert.equal(await read(), true);

    // A commented-out line is not a setting. server.properties is full of
    // them, and a substring search reads this as the whitelist being on.
    propertiesContent = '#white-list=true\nwhite-list=false\n';
    assert.equal(await read(), false, 'a commented line is not a setting');

    // Nor is a different key that happens to end the same way.
    propertiesContent = 'x-white-list=true\nwhite-list=false\n';
    assert.equal(await read(), false);

    propertiesContent = 'white-list=false\n';
  });

  it('is absent on a game that does not work this way', async () => {
    const template = await app.prisma.gameTemplate.findFirstOrThrow({
      where: { slug: 'minecraft-java' },
    });
    try {
      await app.prisma.gameTemplate.update({
        where: { id: template.id },
        data: { features: ['plugins'] },
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/servers/${serverId}/players`,
        headers: auth(),
      });
      assert.equal(response.statusCode, 404);
    } finally {
      await app.prisma.gameTemplate.update({
        where: { id: template.id },
        data: { features: template.features },
      });
    }
  });

  it('is closed to someone else entirely', async () => {
    const stranger = await registerUser(app);
    createdUsers.push(stranger.id);

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/players/operators`,
      headers: { authorization: `Bearer ${stranger.accessToken}` },
      payload: { name: 'Notch' },
    });
    assert.equal(response.statusCode, 404);
  });
});
