import { WebSocket as WsClient } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import {
  Permission,
  REDIS_CHANNELS,
  type AgentSocketMessage,
  type ServerSocketCommand,
  type ServerSocketEvent,
} from '@storm/types';
import { signRequest } from '@storm/security';
import type { AuthenticatedUser } from '../plugins/auth.js';

const PING_INTERVAL = 25_000;

/**
 * Per-server browser socket.
 *
 * The browser never talks to a node directly — it would have to be handed node
 * credentials to do so. Instead the panel opens its own authenticated socket to
 * the agent and relays messages, filtering them against the permissions the
 * user actually holds on that server.
 */
export async function registerServerSocket(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>(
    '/servers/:id/ws',
    { websocket: true, schema: { hide: true } },
    async (socket, request) => {
      let user: AuthenticatedUser;
      try {
        user = await authenticateSocket(
          app,
          request.query as Record<string, string>,
          request.headers.cookie,
        );
      } catch {
        send(socket, {
          type: 'error',
          code: 'UNAUTHENTICATED',
          message: 'Sign in to open this console',
        });
        socket.close(4401, 'unauthenticated');
        return;
      }

      let access;
      try {
        access = await app.serverAccess.require(
          user,
          request.params.id,
          Permission.SERVERS_CONSOLE,
        );
      } catch {
        send(socket, { type: 'error', code: 'FORBIDDEN', message: 'You cannot view this console' });
        socket.close(4403, 'forbidden');
        return;
      }

      const { server } = access;

      send(socket, { type: 'ready', serverId: server.id, status: server.status });

      /* ----------------------------------------------- who they still are -- */

      /**
       * What this person may do on this server, asked again.
       *
       * Every HTTP route resolves permissions on the request that uses them,
       * which is what makes a narrowed share, a denied permission or a
       * suspended account take effect at once. This socket resolved them once
       * and then kept the answer for as long as the tab stayed open — so a
       * revoked console kept working until somebody reloaded it, and nobody
       * reloads a console. Returns null when they may no longer be here at
       * all, which closes the socket rather than refusing one message.
       */
      const currentAccess = async (): Promise<typeof access | null> => {
        try {
          const fresh = await app.refreshUser(user);
          return await app.serverAccess.require(
            fresh,
            request.params.id,
            Permission.SERVERS_CONSOLE,
          );
        } catch {
          return null;
        }
      };

      const shutOut = (): void => {
        send(socket, {
          type: 'error',
          code: 'FORBIDDEN',
          message: 'Your access to this console has been withdrawn',
        });
        socket.close(4403, 'forbidden');
      };

      /* ------------------------------------------- upstream agent socket -- */

      let upstream: WsClient | null = null;
      let closed = false;
      const connectUpstream = async (): Promise<void> => {
        try {
          const { authorization, secret } = await app.agents.credentials(server.nodeId);
          const path = `/api/v1/servers/${server.uuid}/ws`;
          const timestamp = String(Math.floor(Date.now() / 1000));
          const signature = signRequest(secret, { method: 'GET', path, timestamp, body: '' });

          upstream = new WsClient(app.agents.websocketUrl(server.node, path), {
            headers: {
              authorization,
              'x-storm-timestamp': timestamp,
              'x-storm-signature': signature,
            },
            rejectUnauthorized: !app.env.AGENT_ALLOW_SELF_SIGNED,
            handshakeTimeout: 10_000,
          });

          upstream.on('open', () => {
            upstream?.send(JSON.stringify({ type: 'logs' }));
          });

          upstream.on('message', (raw: Buffer) => {
            if (closed) return;
            let message: AgentSocketMessage;
            try {
              message = JSON.parse(raw.toString()) as AgentSocketMessage;
            } catch {
              return;
            }
            relay(socket, message, server);
          });

          upstream.on('close', () => {
            if (closed) return;
            send(socket, {
              type: 'error',
              code: 'NODE_UNREACHABLE',
              message: 'Lost the connection to the node. Reconnecting…',
            });
          });

          upstream.on('error', (error: Error) => {
            app.log.warn({ err: error, serverId: server.id }, 'agent socket error');
          });
        } catch (error) {
          app.log.warn({ err: error, serverId: server.id }, 'could not open agent socket');
          send(socket, {
            type: 'error',
            code: 'NODE_UNREACHABLE',
            message: 'The node hosting this server is not reachable right now',
          });
        }
      };

      await connectUpstream();

      /* --------------------------------------------- browser -> upstream -- */

      const refuse = (message: string): void => {
        send(socket, { type: 'error', code: 'FORBIDDEN', message });
      };

      async function handleCommand(
        command: Extract<ServerSocketCommand, { type: 'command' }>,
      ): Promise<void> {
        if (typeof command.command !== 'string' || command.command.length > 4000) return;

        const now = await currentAccess();
        if (!now) return shutOut();
        if (!now.permissions.has(Permission.SERVERS_COMMAND)) {
          return refuse('You do not have permission to send commands');
        }
        // Suspension is why a server stops being the customer's to drive, and
        // every HTTP route says so. The console said nothing at all.
        if (now.server.suspendedAt && !now.isAdmin) {
          return refuse('This server is suspended. Contact support to have it restored.');
        }

        upstream?.send(JSON.stringify({ type: 'command', command: command.command }));
        await app.audit.activity(
          null,
          {
            serverId: server.id,
            event: 'server:console.command',
            metadata: { command: command.command.slice(0, 200) },
          },
          user.id,
        );
      }

      async function handlePower(
        command: Extract<ServerSocketCommand, { type: 'power' }>,
      ): Promise<void> {
        const now = await currentAccess();
        if (!now) return shutOut();
        if (!now.permissions.has(`servers.${command.action}`)) {
          return refuse(`You do not have permission to ${command.action} this server`);
        }

        // sendPower carries the suspension and install-busy rules of its own.
        await app.servers.sendPower(server.id, command.action).catch((error: unknown) => {
          send(socket, {
            type: 'error',
            code: 'POWER_FAILED',
            message: error instanceof Error ? error.message : 'The power action failed',
          });
        });
        await app.audit.activity(
          null,
          { serverId: server.id, event: `server:power.${command.action}` },
          user.id,
        );
      }

      // Authorisation is a database round trip now, so two messages sent back
      // to back could otherwise reach the node in the other order. They are
      // handled one at a time instead: a console is typed at, not driven.
      let queue: Promise<void> = Promise.resolve();
      const enqueue = (work: () => Promise<void>): void => {
        queue = queue.then(work).catch((error: unknown) => {
          app.log.warn({ err: error, serverId: server.id }, 'console socket command failed');
        });
      };

      socket.on('message', (raw: Buffer) => {
        let command: ServerSocketCommand;
        try {
          command = JSON.parse(raw.toString()) as ServerSocketCommand;
        } catch {
          return;
        }

        switch (command.type) {
          case 'ping':
            send(socket, { type: 'pong' });
            break;

          case 'command':
            enqueue(() => handleCommand(command));
            break;

          case 'power':
            enqueue(() => handlePower(command));
            break;

          case 'logs':
            upstream?.send(JSON.stringify({ type: 'logs' }));
            break;

          default:
            break;
        }
      });

      /* ----------------------------------------------- status / lifecycle -- */

      // Status changes can also originate in the panel (suspend, install), so
      // the socket subscribes to the Redis fan-out as well as the agent.
      const subscriber = app.createRedis();
      await subscriber.subscribe(REDIS_CHANNELS.serverStatus, REDIS_CHANNELS.serverStats);
      subscriber.on('message', (channel: string, payload: string) => {
        try {
          const parsed = JSON.parse(payload) as {
            serverId: string;
            status?: string;
            stats?: unknown;
          };
          if (parsed.serverId !== server.id) return;
          if (channel === REDIS_CHANNELS.serverStatus && parsed.status) {
            send(socket, { type: 'status', status: parsed.status as never });
          }
          if (channel === REDIS_CHANNELS.serverStats && parsed.stats) {
            send(socket, { type: 'stats', stats: parsed.stats as never });
          }
        } catch {
          /* malformed payloads are ignored */
        }
      });

      // A console that only watches is still access, and watching is most of
      // what one is used for. The same question the actions ask, asked on a
      // timer, so a withdrawn permission does not wait for a keystroke that
      // may never come.
      const heartbeat = setInterval(() => {
        if (socket.readyState !== socket.OPEN) return;
        socket.ping();
        enqueue(async () => {
          if ((await currentAccess()) === null) shutOut();
        });
      }, PING_INTERVAL);

      socket.on('close', () => {
        closed = true;
        clearInterval(heartbeat);
        upstream?.close();
        void subscriber.quit().catch(() => undefined);
      });
    },
  );
}

function relay(socket: WebSocket, message: AgentSocketMessage, server: { status: string }): void {
  switch (message.type) {
    case 'console:line':
      send(socket, { type: 'console', line: message.line, timestamp: message.timestamp });
      break;
    case 'console:history':
      send(socket, { type: 'console:history', lines: message.lines });
      break;
    case 'status':
      send(socket, { type: 'status', status: message.status });
      break;
    case 'stats':
      send(socket, {
        type: 'stats',
        stats: {
          cpuPercent: message.stats.cpuPercent,
          cpuLimit: 0,
          memoryBytes: message.stats.memoryBytes,
          memoryLimit: message.stats.memoryLimit,
          diskBytes: message.stats.diskBytes,
          diskLimit: 0,
          networkRx: message.stats.networkRx,
          networkTx: message.stats.networkTx,
          uptime: message.stats.uptime,
          timestamp: message.stats.timestamp,
        },
      });
      break;
    case 'install:output':
      send(socket, { type: 'install', line: message.line });
      break;
    case 'error':
      send(socket, { type: 'error', code: 'AGENT_ERROR', message: message.message });
      break;
    default:
      void server;
      break;
  }
}

function send(socket: WebSocket, event: ServerSocketEvent): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(event));
  }
}

/**
 * Sockets cannot carry an Authorization header from the browser, so the access
 * token arrives either as a `token` query parameter or in the session cookie.
 */
export async function authenticateSocket(
  app: FastifyInstance,
  queryParams: Record<string, string>,
  cookieHeader: string | undefined,
): Promise<AuthenticatedUser> {
  const fromQuery = typeof queryParams.token === 'string' ? queryParams.token : null;
  if (fromQuery) return app.resolveUserFromToken(fromQuery);

  const cookies = parseCookies(cookieHeader ?? '');
  const token = cookies.storm_access;
  if (!token) throw new Error('No credentials on the socket handshake');
  return app.resolveUserFromToken(token);
}

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}
