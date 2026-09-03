import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { NodeStatus } from '@storm/types';
import { hashPassword } from '@storm/security';
import {
  buildConfigFiles,
  renderTemplate,
  validateAgainstRules,
} from '../src/services/server.service.js';
import { cronExpression, describeCron, isValidCron, nextRunAt } from '../src/lib/cron.js';
import {
  createTestApp,
  deleteUser,
  registerUser,
  uniqueSuffix,
  type RegisteredUser,
} from './helpers.js';

describe('server lifecycle', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  const createdUsers: string[] = [];
  let customer: RegisteredUser;
  let adminToken: string;
  let nodeId: string;
  let templateId: string;

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
        email: `srvowner-${suffix}@storm.test`,
        username: `srvowner${suffix}`,
        passwordHash: await hashPassword('OwnerPassword123!'),
        roleId: ownerRole.id,
        emailVerifiedAt: new Date(),
        serverLimit: 100,
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
        name: `srv-node-${suffix}`,
        location: 'Test',
        hostname: '127.0.0.1',
        ip: '127.0.0.1',
        scheme: 'http',
        memoryTotal: 4096,
        diskTotal: 20480,
        // A node a customer is allowed to deploy to. The panel refuses to
        // place a server on one that is not answering, so a node left at the
        // column default of OFFLINE would fail every creation here for a
        // reason that has nothing to do with what is being tested.
        status: NodeStatus.ONLINE,
      },
    });
    nodeId = node.id;

    const template = await app.prisma.gameTemplate.findFirstOrThrow({
      where: { slug: 'minecraft-java' },
    });
    templateId = template.id;
  });

  after(async () => {
    await app.prisma.serverAllocation.updateMany({ where: { nodeId }, data: { serverId: null } });
    await app.prisma.server.deleteMany({ where: { nodeId } });
    await app.prisma.serverAllocation.deleteMany({ where: { nodeId } });
    await app.prisma.node.delete({ where: { id: nodeId } }).catch(() => undefined);
    for (const id of createdUsers) await deleteUser(app, id);
    await cleanup();
  });

  const limits = {
    cpuLimit: 100,
    memoryLimit: 1024,
    diskLimit: 2048,
    swapLimit: 0,
    ioWeight: 500,
    networkLimitMbps: 0,
    pidsLimit: 128,
    oomKill: true,
  };

  it('refuses to create a server when the node has no free ports', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'No ports available',
        nodeId,
        templateId,
        environment: {},
        limits,
        skipInstall: true,
      },
    });

    assert.equal(response.statusCode, 409);
    assert.equal(
      response.json<{ error: { code: string } }>().error.code,
      'NO_ALLOCATION_AVAILABLE',
    );
  });

  it('creates a server, claims a port and seeds its variables', async () => {
    await app.prisma.serverAllocation.create({
      data: { nodeId, ip: '127.0.0.1', port: 25565 },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'Lifecycle server',
        nodeId,
        templateId,
        environment: { MINECRAFT_VERSION: '1.21.4', MAX_PLAYERS: '30' },
        limits,
        skipInstall: true,
      },
    });

    assert.equal(response.statusCode, 201);
    const server = response.json<{
      data: { id: string; shortId: string; primaryAllocation: { port: number } };
    }>().data;

    assert.equal(server.primaryAllocation.port, 25565);
    assert.equal(server.shortId.length, 8);

    const allocation = await app.prisma.serverAllocation.findFirstOrThrow({
      where: { nodeId, port: 25565 },
    });
    assert.equal(allocation.serverId, server.id, 'the port must be claimed');
    assert.equal(allocation.isPrimary, true);

    const variables = await app.prisma.serverVariable.findMany({ where: { serverId: server.id } });
    const byKey = Object.fromEntries(variables.map((v) => [v.key, v.value]));
    assert.equal(byKey.MAX_PLAYERS, '30', 'submitted values must be stored');
    assert.equal(byKey.MINECRAFT_VERSION, '1.21.4');
    assert.equal(byKey.SERVER_JARFILE, 'server.jar', 'defaults must fill the rest');

    const sftp = await app.prisma.server.findUniqueOrThrow({ where: { id: server.id } });
    assert.ok(sftp.sftpUsername.length > 0);
    assert.notEqual(sftp.sftpPasswordEnc, '', 'the SFTP password must be stored encrypted');
    assert.ok(!sftp.sftpPasswordEnc.includes(' '), 'and must not be plaintext');
  });

  it('will not take a port that is already claimed', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'Port conflict',
        nodeId,
        templateId,
        environment: {},
        limits,
        skipInstall: true,
      },
    });

    // 25565 is taken by the previous test and no other port exists.
    assert.equal(response.statusCode, 409);
  });

  it('enforces the node memory ceiling', async () => {
    await app.prisma.serverAllocation.create({ data: { nodeId, ip: '127.0.0.1', port: 25566 } });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'Too much memory',
        nodeId,
        templateId,
        environment: {},
        // The node has 4096 MiB and 1024 is already allocated.
        limits: { ...limits, memoryLimit: 8192 },
        skipInstall: true,
      },
    });

    assert.equal(response.statusCode, 409);
    assert.equal(
      response.json<{ error: { code: string } }>().error.code,
      'INSUFFICIENT_NODE_CAPACITY',
    );
  });

  it('enforces the per-account server limit', async () => {
    // Zero means unlimited throughout the panel, so a real cap is tested here:
    // one server allowed, and the second attempt refused.
    await app.prisma.user.update({
      where: { id: customer.id },
      data: { serverLimit: 1, memoryLimit: 0, diskLimit: 0 },
    });

    await app.prisma.serverAllocation.create({ data: { nodeId, ip: '127.0.0.1', port: 25570 } });
    await app.prisma.serverAllocation.create({ data: { nodeId, ip: '127.0.0.1', port: 25571 } });

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { authorization: `Bearer ${customer.accessToken}` },
      payload: {
        name: 'Within the limit',
        nodeId,
        templateId,
        environment: {},
        limits: { ...limits, memoryLimit: 256, diskLimit: 512 },
        skipInstall: true,
      },
    });
    assert.equal(first.statusCode, 201, first.body);

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { authorization: `Bearer ${customer.accessToken}` },
      payload: {
        name: 'Over the limit',
        nodeId,
        templateId,
        environment: {},
        limits: { ...limits, memoryLimit: 256, diskLimit: 512 },
        skipInstall: true,
      },
    });

    assert.equal(second.statusCode, 409);
    assert.equal(second.json<{ error: { code: string } }>().error.code, 'RESOURCE_LIMIT_REACHED');
  });

  it('rejects a variable that fails its template rules', async () => {
    await app.prisma.serverAllocation.create({ data: { nodeId, ip: '127.0.0.1', port: 25567 } });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'Bad variables',
        nodeId,
        templateId,
        // MAX_PLAYERS is `required|integer|between:1,1000`.
        environment: { MAX_PLAYERS: 'not-a-number' },
        limits,
        skipInstall: true,
      },
    });

    assert.equal(response.statusCode, 422);
    const body = response.json<{ error: { details: Record<string, string[]> } }>();
    assert.ok(body.error.details.MAX_PLAYERS, 'the failing variable must be named');
  });

  it('rejects a docker image the template does not offer', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'Arbitrary image',
        nodeId,
        templateId,
        dockerImage: 'attacker/backdoor:latest',
        environment: {},
        limits,
        skipInstall: true,
      },
    });

    assert.equal(response.statusCode, 422);
  });
});

describe('startup command rendering', () => {
  it('substitutes template placeholders', () => {
    const rendered = renderTemplate(
      'java -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}} --port {{SERVER_PORT}}',
      { SERVER_MEMORY: '2048', SERVER_JARFILE: 'paper.jar', SERVER_PORT: '25565' },
    );
    assert.equal(rendered, 'java -Xmx2048M -jar paper.jar --port 25565');
  });

  it('leaves unknown placeholders alone rather than emptying them', () => {
    const rendered = renderTemplate('./run --flag {{UNKNOWN_THING}}', { OTHER: 'x' });
    assert.equal(rendered, './run --flag {{UNKNOWN_THING}}');
  });

  it('accepts the server.* alias form', () => {
    const rendered = renderTemplate('port {{server.port}}', { PORT: '25565' });
    assert.equal(rendered, 'port 25565');
  });
});

describe('template variable rules', () => {
  it('enforces required', () => {
    assert.ok(validateAgainstRules('', 'required|string'));
    assert.equal(validateAgainstRules('', 'string'), null);
  });

  it('enforces integer and range', () => {
    assert.equal(validateAgainstRules('20', 'required|integer|between:1,100'), null);
    assert.ok(validateAgainstRules('abc', 'required|integer'));
    assert.ok(validateAgainstRules('500', 'required|integer|between:1,100'));
  });

  it('enforces in and regex', () => {
    assert.equal(validateAgainstRules('paper', 'required|in:paper,purpur,vanilla'), null);
    assert.ok(validateAgainstRules('spigot', 'required|in:paper,purpur,vanilla'));
    assert.equal(
      validateAgainstRules('server.jar', 'required|regex:^[A-Za-z0-9_.-]+\\.jar$'),
      null,
    );
    assert.ok(validateAgainstRules('evil.sh', 'required|regex:^[A-Za-z0-9_.-]+\\.jar$'));
  });

  it('enforces alpha_dash', () => {
    assert.equal(validateAgainstRules('my-world_2', 'required|alpha_dash'), null);
    assert.ok(validateAgainstRules('my world', 'required|alpha_dash'));
    // The point of the rule: no shell metacharacters reach a startup command.
    assert.ok(validateAgainstRules('a;rm -rf /', 'required|alpha_dash'));
  });

  it('enforces url, and only over http(s)', () => {
    assert.equal(validateAgainstRules('https://example.com/x.zip', 'required|url'), null);
    assert.ok(validateAgainstRules('not a url', 'required|url'));
    assert.ok(validateAgainstRules('file:///etc/passwd', 'required|url'));
  });

  it('enforces length bounds', () => {
    assert.ok(validateAgainstRules('ab', 'required|min:5'));
    assert.ok(validateAgainstRules('abcdefghij', 'required|max:5'));
    assert.equal(validateAgainstRules('abcde', 'required|min:5|max:10'), null);
  });

  it('treats a malformed rule as no constraint rather than failing closed', () => {
    // An operator typo in a template must not make every server uncreatable.
    assert.equal(validateAgainstRules('anything', 'required|regex:[unclosed'), null);
  });
});

describe('cron scheduling', () => {
  it('builds and validates expressions', () => {
    const daily = {
      cronMinute: '0',
      cronHour: '4',
      cronDayOfMonth: '*',
      cronMonth: '*',
      cronDayOfWeek: '*',
      timezone: 'UTC',
    };
    assert.equal(cronExpression(daily), '0 4 * * *');
    assert.equal(isValidCron(daily), true);

    const next = nextRunAt(daily, new Date('2026-01-01T05:00:00Z'));
    assert.ok(next);
    assert.equal(next.getUTCHours(), 4);
    assert.equal(next.getUTCDate(), 2, 'the next 04:00 after 05:00 is tomorrow');
  });

  it('rejects a nonsense expression', () => {
    assert.equal(
      isValidCron({
        cronMinute: 'banana',
        cronHour: '*',
        cronDayOfMonth: '*',
        cronMonth: '*',
        cronDayOfWeek: '*',
        timezone: 'UTC',
      }),
      false,
    );
  });

  it('describes common cadences in plain English', () => {
    const base = { cronDayOfMonth: '*', cronMonth: '*', cronDayOfWeek: '*', timezone: 'UTC' };
    assert.equal(describeCron({ ...base, cronMinute: '0', cronHour: '4' }), 'Daily at 04:00');
    assert.equal(
      describeCron({ ...base, cronMinute: '0', cronHour: '*/6' }),
      'Every 6 hours at :00',
    );
    assert.equal(describeCron({ ...base, cronMinute: '*/30', cronHour: '*' }), 'Every 30 minutes');
  });

  it('honours the timezone', () => {
    const parts = {
      cronMinute: '0',
      cronHour: '4',
      cronDayOfMonth: '*',
      cronMonth: '*',
      cronDayOfWeek: '*',
      timezone: 'America/New_York',
    };
    const next = nextRunAt(parts, new Date('2026-01-01T00:00:00Z'));
    assert.ok(next);
    // 04:00 in New York is 09:00 UTC in January.
    assert.equal(next.getUTCHours(), 9);
  });
});

describe('template config files', () => {
  const context = {
    'server.allocation.ip': '203.0.113.10',
    'server.allocation.port': '30012',
    'server.build.memory': '4096',
  };

  it('resolves placeholders into literal values', () => {
    const files = buildConfigFiles(
      {
        'server.properties': {
          parser: 'properties',
          find: {
            'server-port': '{{server.allocation.port}}',
            'server-ip': '{{server.allocation.ip}}',
          },
        },
      },
      context,
    );

    assert.deepEqual(files, [
      {
        path: 'server.properties',
        parser: 'properties',
        find: { 'server-port': '30012', 'server-ip': '203.0.113.10' },
      },
    ]);
  });

  it('drops entries an operator has mistyped rather than throwing', () => {
    // A broken mapping in one template must not make its servers unstartable.
    const files = buildConfigFiles(
      {
        'a.properties': { parser: 'xml', find: { a: 'b' } },
        'b.properties': { parser: 'properties', find: 'not an object' },
        'c.properties': { parser: 'properties' },
        'd.properties': 'nonsense',
        'e.properties': { parser: 'properties', find: { ok: '{{server.build.memory}}' } },
      },
      context,
    );

    assert.deepEqual(files, [{ path: 'e.properties', parser: 'properties', find: { ok: '4096' } }]);
  });

  it('returns nothing for a template with no mappings', () => {
    assert.deepEqual(buildConfigFiles({}, context), []);
    assert.deepEqual(buildConfigFiles(null, context), []);
    assert.deepEqual(buildConfigFiles(undefined, context), []);
  });
});
