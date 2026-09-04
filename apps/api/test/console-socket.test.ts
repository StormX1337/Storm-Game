import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import type { FastifyInstance } from 'fastify';
import { hashToken } from '@storm/security';
import { Permission, ServerStatus } from '@storm/types';
import { createTestApp, deleteUser, registerUser, uniqueSuffix } from './helpers.js';
import type { RegisteredUser } from './helpers.js';

/**
 * The console socket.
 *
 * It is the one authorised surface that is not a request. Every HTTP route
 * resolves permissions again on every call — that is what makes a revoked
 * share, a denied permission or a suspended account take effect at once. A
 * socket is opened once and then left open for as long as the tab is, which
 * makes "resolved at connect time" a very different promise from the one the
 * rest of the panel makes.
 *
 * The node is never reached in these tests: there is no agent, so the upstream
 * connection fails and the panel says so. What is under test is the half in
 * front of it — who may open the socket, what they may send through it, and
 * for how long that stays true.
 */
describe('the console socket', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let baseUrl: string;
  let owner: RegisteredUser;
  let helper: RegisteredUser;
  let stranger: RegisteredUser;
  let serverId: string;
  let serverShortId: string;
  let nodeId: string;
  let agentNodeId: string;
  let agentServerShortId: string;
  const createdUsers: string[] = [];

  /** Opens a socket and collects everything it is sent. */
  async function open(
    token: string | null,
    target = serverShortId,
  ): Promise<{
    socket: WebSocket;
    events: Record<string, unknown>[];
    closed: Promise<number>;
    settle: () => Promise<void>;
  }> {
    const query = token ? `?token=${encodeURIComponent(token)}` : '';
    const socket = new WebSocket(`${baseUrl}/api/v1/servers/${target}/ws${query}`);
    const events: Record<string, unknown>[] = [];

    socket.on('message', (raw: Buffer) => {
      try {
        events.push(JSON.parse(raw.toString()) as Record<string, unknown>);
      } catch {
        /* not our problem here */
      }
    });

    const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });

    // The handler answers in its own time; a short settle beats a sleep in
    // every test that follows.
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 150));
    await settle();
    return { socket, events, closed, settle };
  }

  /** Resolves what the promise resolves to, or 'timeout' if it takes too long. */
  const within = <T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> =>
    Promise.race([
      promise,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms)),
    ]);

  const commandsLogged = () =>
    app.prisma.activityLog.count({ where: { serverId, event: 'server:console.command' } });

  /**
   * A websocket server standing in for a node agent, on its own node row.
   *
   * It accepts anything — the signature the panel sends is checked by the real
   * agent, not here. What it is for is counting: how many times the panel
   * opened a socket to it, and what happens to that count when it hangs up.
   */
  async function standInAgent(): Promise<{
    waitForConnections: (count: number) => Promise<void>;
    dropAll: () => void;
    stop: () => Promise<void>;
  }> {
    let connections = 0;
    const live = new Set<import('ws').WebSocket>();
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });

    server.on('connection', (client) => {
      connections += 1;
      live.add(client);
      client.on('close', () => live.delete(client));
    });
    await new Promise<void>((resolve) => server.on('listening', () => resolve()));

    const port = (server.address() as { port: number }).port;
    await app.prisma.node.update({ where: { id: agentNodeId }, data: { agentPort: port } });

    return {
      async waitForConnections(count) {
        // The first reconnect waits a second, so this has to outlast that.
        const deadline = Date.now() + 8000;
        while (connections < count) {
          if (Date.now() > deadline) {
            throw new Error(`the panel opened ${connections} sockets, expected ${count}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      },
      dropAll() {
        for (const client of live) client.close();
      },
      async stop() {
        for (const client of live) client.terminate();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  async function share(permissions: string[]): Promise<void> {
    await app.prisma.serverSubuser.upsert({
      where: { serverId_userId: { serverId, userId: helper.id } },
      create: { serverId, userId: helper.id, permissions },
      update: { permissions },
    });
  }

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;
    baseUrl = (await app.listen({ port: 0, host: '127.0.0.1' })).replace('http://', 'ws://');

    owner = await registerUser(app);
    helper = await registerUser(app);
    stranger = await registerUser(app);
    createdUsers.push(owner.id, helper.id, stranger.id);
    const suffix = uniqueSuffix();

    const node = await app.prisma.node.create({
      data: {
        name: `socket-node-${suffix}`,
        location: 'Test',
        hostname: '127.0.0.1',
        ip: '127.0.0.1',
        scheme: 'http',
        memoryTotal: 8192,
        diskTotal: 51200,
        status: 'ONLINE',
      },
    });
    nodeId = node.id;

    const template = await app.prisma.gameTemplate.findFirstOrThrow({
      where: { slug: 'minecraft-java' },
    });
    const server = await app.prisma.server.create({
      data: {
        name: 'Console',
        shortId: uniqueSuffix().slice(0, 8),
        ownerId: owner.id,
        nodeId,
        templateId: template.id,
        dockerImage: 'alpine',
        startupCommand: 'true',
        sftpUsername: `sock_${suffix}`,
        sftpPasswordEnc: 'not-a-real-secret',
        status: ServerStatus.OFFLINE,
        installedAt: new Date(),
      },
    });
    serverId = server.id;
    serverShortId = server.shortId;

    // A second node and server, for the tests that need a node that answers.
    // The one above deliberately has nothing behind it.
    const agentNode = await app.prisma.node.create({
      data: {
        name: `socket-agent-${suffix}`,
        location: 'Test',
        hostname: '127.0.0.1',
        ip: '127.0.0.1',
        scheme: 'http',
        memoryTotal: 8192,
        diskTotal: 51200,
        status: 'ONLINE',
      },
    });
    agentNodeId = agentNode.id;
    await app.prisma.nodeToken.create({
      data: {
        nodeId: agentNodeId,
        name: 'socket test',
        tokenId: `tok_${suffix}`,
        tokenHash: hashToken('a-shared-secret-for-the-test'),
        secretEnc: app.encrypter.encrypt('a-shared-secret-for-the-test'),
      },
    });
    agentServerShortId = (
      await app.prisma.server.create({
        data: {
          name: 'Talkative',
          shortId: uniqueSuffix().slice(0, 8),
          ownerId: owner.id,
          nodeId: agentNodeId,
          templateId: template.id,
          dockerImage: 'alpine',
          startupCommand: 'true',
          sftpUsername: `agent_${suffix}`,
          sftpPasswordEnc: 'not-a-real-secret',
          status: ServerStatus.OFFLINE,
          installedAt: new Date(),
        },
      })
    ).shortId;
  });

  after(async () => {
    await app.prisma.activityLog.deleteMany({ where: { serverId } });
    await app.prisma.serverSubuser.deleteMany({ where: { serverId } });
    await app.prisma.server.deleteMany({ where: { nodeId } });
    await app.prisma.nodeToken.deleteMany({ where: { nodeId: agentNodeId } });
    await app.prisma.server.deleteMany({ where: { nodeId: agentNodeId } });
    await app.prisma.node.delete({ where: { id: nodeId } }).catch(() => undefined);
    await app.prisma.node.delete({ where: { id: agentNodeId } }).catch(() => undefined);
    for (const id of createdUsers) await deleteUser(app, id);
    await cleanup();
  });

  beforeEach(async () => {
    await app.prisma.activityLog.deleteMany({ where: { serverId } });
    await app.prisma.serverSubuser.deleteMany({ where: { serverId } });
    await app.prisma.user.update({
      where: { id: helper.id },
      data: { deniedPermissions: [], suspendedAt: null },
    });
    await app.prisma.server.update({ where: { id: serverId }, data: { suspendedAt: null } });
  });

  /* --------------------------------------------------- getting in at all -- */

  it('turns away a socket with no credentials on it', async () => {
    const { events, closed } = await open(null);

    assert.equal(events[0]?.code, 'UNAUTHENTICATED');
    assert.equal(await closed, 4401);
  });

  it('turns away someone the server was never shared with', async () => {
    const { events, closed } = await open(stranger.accessToken);

    assert.equal(events[0]?.code, 'FORBIDDEN');
    assert.equal(await closed, 4403);
  });

  it('lets the owner in and says what the server is doing', async () => {
    const { socket, events } = await open(owner.accessToken);

    const ready = events.find((event) => event.type === 'ready');
    assert.ok(ready, JSON.stringify(events));
    assert.equal(ready.serverId, serverId);
    assert.equal(ready.status, ServerStatus.OFFLINE);
    socket.close();
  });

  /* ------------------------------------------------- what may be sent -- */

  it('refuses a command from a share that does not carry the permission', async () => {
    await share([Permission.SERVERS_CONSOLE]);
    const { socket, events, settle } = await open(helper.accessToken);

    socket.send(JSON.stringify({ type: 'command', command: 'stop' }));
    await settle();

    assert.ok(
      events.some((event) => event.code === 'FORBIDDEN'),
      JSON.stringify(events),
    );
    assert.equal(await commandsLogged(), 0);
    socket.close();
  });

  it('passes a command through when the share carries it, and writes it down', async () => {
    await share([Permission.SERVERS_CONSOLE, Permission.SERVERS_COMMAND]);
    const { socket, events, settle } = await open(helper.accessToken);

    socket.send(JSON.stringify({ type: 'command', command: 'say hello' }));
    await settle();

    assert.ok(!events.some((event) => event.code === 'FORBIDDEN'), JSON.stringify(events));
    assert.equal(await commandsLogged(), 1);
    socket.close();
  });

  /* ------------------------------------- and for how long that stays true -- */

  it('stops accepting commands the moment the share stops granting them', async () => {
    // The socket outlives the decision that opened it. An administrator taking
    // a permission away, or an owner narrowing a share, has to reach a console
    // that is already open — otherwise "revoked" means "revoked when they next
    // reload", and nobody reloads a console.
    await share([Permission.SERVERS_CONSOLE, Permission.SERVERS_COMMAND]);
    const { socket, events, settle } = await open(helper.accessToken);

    socket.send(JSON.stringify({ type: 'command', command: 'first' }));
    await settle();
    assert.equal(await commandsLogged(), 1, 'the command was refused before anything changed');

    await share([Permission.SERVERS_CONSOLE]);
    socket.send(JSON.stringify({ type: 'command', command: 'second' }));
    await settle();

    assert.equal(
      await commandsLogged(),
      1,
      'the command went through after the share was narrowed',
    );
    assert.ok(
      events.some((event) => event.code === 'FORBIDDEN'),
      JSON.stringify(events),
    );
    socket.close();
  });

  it('stops accepting commands when the account itself is denied them', async () => {
    // The same thing from the other side: the share is untouched, but the
    // account has had the permission denied panel-wide.
    await share([Permission.SERVERS_CONSOLE, Permission.SERVERS_COMMAND]);
    const { socket, settle } = await open(helper.accessToken);

    await app.prisma.user.update({
      where: { id: helper.id },
      data: { deniedPermissions: [Permission.SERVERS_COMMAND] },
    });
    socket.send(JSON.stringify({ type: 'command', command: 'still here?' }));
    await settle();

    assert.equal(await commandsLogged(), 0);
    socket.close();
  });

  it('closes a console the share no longer covers at all, at once', async () => {
    await share([Permission.SERVERS_CONSOLE, Permission.SERVERS_COMMAND]);
    const { socket, closed, settle } = await open(helper.accessToken);

    await app.prisma.serverSubuser.deleteMany({ where: { serverId, userId: helper.id } });
    socket.send(JSON.stringify({ type: 'command', command: 'anyone home' }));
    await settle();

    assert.equal(await commandsLogged(), 0);
    // On the message, not on the next heartbeat: somebody who has just been
    // removed should not keep a live console for another half minute.
    assert.equal(await within(closed, 2000), 4403);
    socket.close();
  });

  it('closes a console belonging to an account that has been suspended', async () => {
    await share([Permission.SERVERS_CONSOLE, Permission.SERVERS_COMMAND]);
    const { socket, closed, settle } = await open(helper.accessToken);

    await app.prisma.user.update({ where: { id: helper.id }, data: { suspendedAt: new Date() } });
    socket.send(JSON.stringify({ type: 'command', command: 'let me in' }));
    await settle();

    assert.equal(await commandsLogged(), 0);
    assert.equal(await closed, 4403);
    socket.close();
  });

  it('refuses a command on a suspended server', async () => {
    // Suspension is why a server stops being the customer's to drive. Every
    // HTTP route says so; the console said nothing at all.
    const { socket, events, settle } = await open(owner.accessToken);

    await app.prisma.server.update({
      where: { id: serverId },
      data: { suspendedAt: new Date() },
    });
    socket.send(JSON.stringify({ type: 'command', command: 'op me' }));
    await settle();

    assert.equal(await commandsLogged(), 0);
    assert.ok(
      events.some((event) => event.code === 'FORBIDDEN'),
      JSON.stringify(events),
    );
    socket.close();
  });

  it('closes a console whose session has been signed out elsewhere', async () => {
    // Signing out on another device, or an administrator revoking a session,
    // has to reach a console the same session left open. Nothing about the
    // socket expires on its own — the token that opened it was checked once.
    const { socket, closed, settle } = await open(owner.accessToken);

    try {
      await app.prisma.session.updateMany({
        where: { userId: owner.id },
        data: { revokedAt: new Date() },
      });
      socket.send(JSON.stringify({ type: 'command', command: 'anyone there' }));
      await settle();

      assert.equal(await commandsLogged(), 0);
      assert.equal(await closed, 4403);
    } finally {
      // Everything after this test signs in as the same person, so the
      // session goes back even when the assertion above did not hold.
      await app.prisma.session.updateMany({
        where: { userId: owner.id },
        data: { revokedAt: null },
      });
      socket.close();
    }
  });

  it('holds a socket opened with an API key to that key’s scope', async () => {
    // A key scoped to watching the console must not be able to type into it,
    // and the socket is the one place that decision was made once and kept.
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/account/api-keys',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {
        name: `socket-${uniqueSuffix().slice(0, 6)}`,
        permissions: [Permission.SERVERS_CONSOLE],
      },
    });
    assert.equal(created.statusCode, 200, created.body);
    const token = created.json<{ data: { token: string } }>().data.token;

    const { socket, events, settle } = await open(token);
    socket.send(JSON.stringify({ type: 'command', command: 'op me' }));
    await settle();

    assert.equal(await commandsLogged(), 0);
    assert.ok(
      events.some((event) => event.code === 'FORBIDDEN'),
      JSON.stringify(events),
    );
    socket.close();
    await app.prisma.apiKey.deleteMany({ where: { userId: owner.id } });
  });

  /* ------------------------------------ the half that faces the node -- */

  it('opens its own socket to the node again after the agent goes away', async () => {
    // The panel used to tell the browser "Reconnecting…" and then do nothing
    // of the kind. An agent restart — a panel update, a node reboot — left the
    // console open, silent and permanently empty, and the browser's own
    // reconnect never fired either, because from its side nothing had closed.
    const agent = await standInAgent();
    try {
      const { socket } = await open(owner.accessToken, agentServerShortId);
      await agent.waitForConnections(1);

      // The agent goes away and comes back, as one does during an update.
      agent.dropAll();
      await agent.waitForConnections(2);

      socket.close();
    } finally {
      await agent.stop();
    }
  });

  it('still answers a ping while all that is going on', async () => {
    // The control: the checks must not turn the socket into a brick.
    const { socket, events, settle } = await open(owner.accessToken);

    socket.send(JSON.stringify({ type: 'ping' }));
    await settle();

    assert.ok(
      events.some((event) => event.type === 'pong'),
      JSON.stringify(events),
    );
    socket.close();
  });
});
