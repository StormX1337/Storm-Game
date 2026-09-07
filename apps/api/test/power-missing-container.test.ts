import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ErrorCode, ServerStatus } from '@storm/types';
import { createTestApp, deleteUser, registerUser, uniqueSuffix } from './helpers.js';
import type { RegisteredUser } from './helpers.js';

/**
 * Starting a server the node has no container for.
 *
 * The container is created by pushing the spec, and several ordinary things
 * leave that undone while the row still says OFFLINE: a spec push that failed
 * when the server was created — a bad allocation was enough, and was exactly
 * what happened — an install whose failure was discarded, a node rebuilt from
 * its backup directory, an operator tidying containers by hand.
 *
 * In every one of them the panel is holding the spec that would fix it. What
 * it did instead was pass the node's own words to the customer — "That server
 * has no container on this node" — and stop. That is an internal state, not an
 * instruction, and there is nothing the person reading it can do with it.
 */
describe('starting a server whose container is missing', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let owner: RegisteredUser;
  let nodeId: string;
  let serverId: string;
  const createdUsers: string[] = [];

  /** Every call the panel made to the node, in order. */
  let calls: { path: string; method: string }[] = [];
  /** Paths whose first `count` calls answer "no container". */
  let missingUntil = 0;
  /** True once the spec has been pushed, the way a real node would behave. */
  let specPushed = false;
  let syncFails = false;
  /** An error the first power call answers with, whatever the container state. */
  let failFirstPowerWith: string | null = null;

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;

    app.agents.request = (async (_node: unknown, path: string, options?: { method?: string }) => {
      const method = options?.method ?? 'GET';
      calls.push({ path, method });

      if (path === '/api/v1/servers' && method === 'PUT') {
        if (syncFails) throw new Error('the node refused the spec');
        specPushed = true;
        return { uuid: 'x', containerId: 'deadbeef' };
      }

      if (path.endsWith('/power')) {
        if (failFirstPowerWith) {
          const code = failFirstPowerWith;
          failFirstPowerWith = null;
          throw new (await import('../src/lib/errors.js')).AppError(
            409,
            code,
            'something else went wrong',
          );
        }
        // The node answers exactly as it does: a 404 carrying SERVER_NOT_FOUND.
        if (!specPushed && missingUntil > 0) {
          missingUntil -= 1;
          throw new (await import('../src/lib/errors.js')).AppError(
            404,
            ErrorCode.SERVER_NOT_FOUND,
            'That server has no container on this node',
          );
        }
        return { ok: true };
      }

      return { ok: true };
    }) as typeof app.agents.request;

    owner = await registerUser(app);
    createdUsers.push(owner.id);

    const suffix = uniqueSuffix();
    nodeId = (
      await app.prisma.node.create({
        data: {
          name: `power-node-${suffix}`,
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
    await app.prisma.serverAllocation.deleteMany({ where: { nodeId } });
    await app.prisma.server.deleteMany({ where: { nodeId } });
    await app.prisma.node.delete({ where: { id: nodeId } }).catch(() => undefined);
    for (const id of createdUsers) await deleteUser(app, id);
    await cleanup();
  });

  beforeEach(async () => {
    calls = [];
    missingUntil = 0;
    specPushed = false;
    syncFails = false;
    failFirstPowerWith = null;

    await app.prisma.serverAllocation.deleteMany({ where: { nodeId } });
    await app.prisma.server.deleteMany({ where: { nodeId } });

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
          sftpUsername: `pw_${suffix}`,
          sftpPasswordEnc: app.encrypter.encrypt('not-a-real-secret'),
          status: ServerStatus.OFFLINE,
          installedAt: new Date(),
        },
      })
    ).id;
    await app.prisma.serverAllocation.create({
      data: { nodeId, ip: '10.0.0.5', port: 25565, serverId, isPrimary: true },
    });
  });

  const powers = () => calls.filter((call) => call.path.endsWith('/power'));
  const specPushes = () =>
    calls.filter((call) => call.path === '/api/v1/servers' && call.method === 'PUT');

  it('starts normally when the container is there', async () => {
    await app.servers.sendPower(serverId, 'start');
    assert.equal(powers().length, 1);
    assert.equal(specPushes().length, 0, 'nothing needed re-applying');
  });

  it('re-applies the spec and starts, instead of reporting the node’s words', async () => {
    missingUntil = 1;

    await app.servers.sendPower(serverId, 'start');

    assert.deepEqual(
      calls.map((call) => `${call.method} ${call.path.replace(/[0-9a-f-]{36}/, ':uuid')}`),
      [
        'POST /api/v1/servers/:uuid/power',
        'PUT /api/v1/servers',
        'POST /api/v1/servers/:uuid/power',
      ],
      'the spec has to be pushed between the two attempts',
    );
  });

  it('leaves the server started, not merely un-errored', async () => {
    missingUntil = 1;
    await app.servers.sendPower(serverId, 'start');

    const server = await app.prisma.server.findUniqueOrThrow({ where: { id: serverId } });
    assert.equal(server.status, ServerStatus.STARTING);
  });

  it('does the same for a restart', async () => {
    missingUntil = 1;
    await app.servers.sendPower(serverId, 'restart');
    assert.equal(specPushes().length, 1);
    assert.equal(powers().length, 2);
  });

  it('does not chase a container for stop or kill', async () => {
    // Stopping something that is not there is already the desired state, and
    // creating a container in order to stop it would be absurd.
    for (const action of ['stop', 'kill'] as const) {
      calls = [];
      missingUntil = 5;
      specPushed = false;
      await assert.rejects(app.servers.sendPower(serverId, action));
      assert.equal(specPushes().length, 0, `${action} should not push a spec`);
      assert.equal(powers().length, 1, `${action} should not retry`);
    }
  });

  it('tries once, not forever, when the node keeps saying no', async () => {
    // A node that cannot create the container has to report that, rather than
    // the panel looping between a push and a start.
    missingUntil = 99;
    specPushed = false;
    syncFails = true;

    await assert.rejects(app.servers.sendPower(serverId, 'start'));
    assert.ok(powers().length <= 2, `tried ${powers().length} times`);
  });

  it('does not retry past a failure that is not a missing container', async () => {
    // The one that matters: the second attempt would have succeeded. A repair
    // that retries on any error turns a real refusal — a suspension the node
    // knows about, a conflicting state — into a silent success.
    failFirstPowerWith = ErrorCode.SERVER_SUSPENDED;

    await assert.rejects(app.servers.sendPower(serverId, 'start'), (error: { code?: string }) => {
      assert.equal(error.code, ErrorCode.SERVER_SUSPENDED);
      return true;
    });
    assert.equal(specPushes().length, 0, 'nothing should have been re-applied');
    assert.equal(powers().length, 1, 'it should not have tried again');
  });

  it('surfaces an unrelated failure untouched', async () => {
    // Only a missing container is repairable here. A node that is down, or a
    // server that is suspended on the node, must not be papered over by a
    // spec push that will fail for the same reason.
    app.agents.request = (async () => {
      throw new (await import('../src/lib/errors.js')).AppError(
        503,
        ErrorCode.NODE_UNREACHABLE,
        'The node could not be reached',
      );
    }) as typeof app.agents.request;

    await assert.rejects(app.servers.sendPower(serverId, 'start'), (error: { code?: string }) => {
      assert.equal(error.code, ErrorCode.NODE_UNREACHABLE);
      return true;
    });
  });
});
