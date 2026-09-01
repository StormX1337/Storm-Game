import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Node } from '@storm/database';
import { createTestApp, uniqueSuffix } from './helpers.js';

/**
 * What a failure on a node reads like by the time it reaches a person.
 *
 * This came from a real one: installing a plugin on a live panel answered
 * "Node \"fr-node\" rejected the request", which is true and useless. The node
 * had said exactly what was wrong — the route did not exist, because its agent
 * was older than the panel — and the translation threw that away, because it
 * only ever looked at `error.message` and Fastify's own replies put the reason
 * somewhere else.
 */
describe('errors coming back from a node', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let agent: HttpServer;
  let node: Node;

  /** What the fake agent answers with next. */
  let reply: { status: number; body: string } = { status: 200, body: '{}' };

  before(async () => {
    agent = createServer((_request, response) => {
      response.statusCode = reply.status;
      response.setHeader('content-type', 'application/json');
      response.end(reply.body);
    });
    await new Promise<void>((resolve) => agent.listen(0, '127.0.0.1', resolve));
    const address = agent.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;

    node = await app.prisma.node.create({
      data: {
        name: 'fr-node',
        location: 'Test',
        hostname: '127.0.0.1',
        ip: '127.0.0.1',
        scheme: 'http',
        agentPort: port,
        memoryTotal: 1024,
        diskTotal: 10240,
      },
    });
    await app.prisma.nodeToken.create({
      data: {
        nodeId: node.id,
        name: 'test',
        tokenId: `t${uniqueSuffix()}`,
        tokenHash: 'x'.repeat(64),
        secretEnc: app.encrypter.encrypt('secret'),
      },
    });
    node = await app.prisma.node.findUniqueOrThrow({ where: { id: node.id } });
  });

  after(async () => {
    await app.prisma.nodeToken.deleteMany({ where: { nodeId: node.id } });
    await app.prisma.node.delete({ where: { id: node.id } }).catch(() => undefined);
    await cleanup();
    await new Promise<void>((resolve) => agent.close(() => resolve()));
  });

  const call = async (): Promise<{ status: number; message: string }> => {
    try {
      await app.agents.request(node, '/api/v1/servers/x/files/fetch', { method: 'POST', body: {} });
      return { status: 200, message: '' };
    } catch (error) {
      const failure = error as { statusCode?: number; message: string };
      return { status: failure.statusCode ?? 0, message: failure.message };
    }
  };

  it('names a missing endpoint as an agent that is behind the panel', async () => {
    // Exactly what Fastify answers for a route it does not have — which is
    // what every node running an older agent answers after the panel gains an
    // endpoint. "Rejected the request" sent someone looking for a broken node.
    reply = {
      status: 404,
      body: JSON.stringify({
        message: 'Route POST:/api/v1/servers/x/files/fetch not found',
        error: 'Not Found',
        statusCode: 404,
      }),
    };

    const result = await call();
    assert.equal(result.status, 404);
    assert.match(result.message, /older than the panel/i);
    assert.match(result.message, /update the agent/i, 'and says what to do about it');
    assert.match(result.message, /fr-node/, 'and which node');
  });

  it("keeps the agent's own message when it has one", async () => {
    reply = {
      status: 413,
      body: JSON.stringify({
        success: false,
        error: { code: 'FILE_TOO_LARGE', message: 'The download is larger than 1024 bytes' },
      }),
    };

    const result = await call();
    assert.equal(result.status, 413);
    assert.equal(result.message, 'The download is larger than 1024 bytes');
  });

  it('falls back to a top-level message rather than to nothing', async () => {
    reply = { status: 400, body: JSON.stringify({ message: 'params/uuid must match format' }) };

    const result = await call();
    assert.equal(result.message, 'params/uuid must match format');
  });

  it('uses the raw body when it is not JSON at all', async () => {
    // A proxy in front of the node, say, answering with HTML.
    reply = { status: 502, body: '<html>Bad Gateway</html>' };

    const result = await call();
    assert.match(result.message, /Bad Gateway/);
  });

  it('still says something when the node answers with an empty body', async () => {
    reply = { status: 500, body: '' };

    const result = await call();
    assert.match(result.message, /fr-node/);
  });
});
