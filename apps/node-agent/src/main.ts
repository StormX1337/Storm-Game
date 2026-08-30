import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadAgentEnv, EnvValidationError, STORM_VERSION } from '@storm/config';
import { verifySignature } from '@storm/security';
import type { ServerStatus } from '@storm/types';

import { AgentError } from './lib/errors.js';
import { ServerPaths } from './lib/paths.js';
import agentAuthPlugin from './plugins/auth.js';
import serverRoutes from './routes/servers.routes.js';
import { DockerService } from './services/docker.service.js';
import { FilesService } from './services/files.service.js';
import { BackupService } from './services/backup.service.js';
import { ConsoleService } from './services/console.service.js';
import { SystemService } from './services/system.service.js';
import { PanelClient } from './services/panel-client.js';
import { SftpService } from './services/sftp.service.js';

declare module 'fastify' {
  interface FastifyInstance {
    docker: DockerService;
    files: FilesService;
    backups: BackupService;
    console: ConsoleService;
    system: SystemService;
    panel: PanelClient;
    paths: ServerPaths & { removeRoot: (uuid: string) => Promise<void>; wipe: (uuid: string) => Promise<void> };
  }
}

async function main(): Promise<void> {
  let env;
  try {
    env = loadAgentEnv();
  } catch (error) {
    if (error instanceof EnvValidationError) {
      console.error(`\n✖ Storm Node Agent cannot start.\n\n${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  const tls =
    env.TLS_CERT_PATH && env.TLS_KEY_PATH
      ? {
          cert: await fs.readFile(env.TLS_CERT_PATH),
          key: await fs.readFile(env.TLS_KEY_PATH),
        }
      : null;

  const app: FastifyInstance = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: {
        paths: ['req.headers.authorization', 'req.headers["x-storm-signature"]'],
        censor: '[redacted]',
      },
    },
    ...(tls ? { https: tls } : {}),
    bodyLimit: 32 * 1024 * 1024,
    trustProxy: true,
  });

  await fs.mkdir(env.DATA_DIRECTORY, { recursive: true });
  await fs.mkdir(env.BACKUP_DIRECTORY, { recursive: true });

  /* ------------------------------------------------------- services -- */

  const paths = new ServerPaths(env.DATA_DIRECTORY);
  const docker = new DockerService({
    socketPath: env.DOCKER_SOCKET,
    network: env.DOCKER_NETWORK,
    dataDirectory: env.DATA_DIRECTORY,
    logger: app.log,
  });
  const files = new FilesService(paths);
  const backups = new BackupService({
    backupDirectory: env.BACKUP_DIRECTORY,
    paths,
    logger: app.log,
  });
  const consoleService = new ConsoleService(docker, env.CONSOLE_BUFFER_LINES, app.log);
  const system = new SystemService(docker, env.DATA_DIRECTORY, STORM_VERSION);
  const panel = new PanelClient({
    panelUrl: env.PANEL_URL,
    tokenId: env.AGENT_TOKEN_ID,
    token: env.AGENT_TOKEN,
    allowSelfSigned: env.PANEL_ALLOW_SELF_SIGNED,
    logger: app.log,
  });

  app.decorate('docker', docker);
  app.decorate('files', files);
  app.decorate('backups', backups);
  app.decorate('console', consoleService);
  app.decorate('system', system);
  app.decorate('panel', panel);
  app.decorate(
    'paths',
    Object.assign(paths, {
      async removeRoot(uuid: string) {
        await fs.rm(paths.root(uuid), { recursive: true, force: true });
      },
      async wipe(uuid: string) {
        const root = paths.root(uuid);
        const entries = await fs.readdir(root).catch(() => []);
        for (const entry of entries) {
          await fs.rm(path.join(root, entry), { recursive: true, force: true });
        }
      },
    }),
  );

  /* ----------------------------------------------- transport plumbing -- */

  await app.register(agentAuthPlugin, { tokenId: env.AGENT_TOKEN_ID, secret: env.AGENT_SECRET });

  // File uploads arrive as a raw stream and must stay one: buffering a
  // multi-gigabyte world upload would take the agent down.
  app.addContentTypeParser('application/octet-stream', (request, payload, done) => {
    request.rawBody = '';
    done(null, payload);
  });

  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AgentError) {
      request.log.info({ err: error, url: request.url }, 'request rejected');
      void reply.status(error.statusCode).send({
        success: false,
        error: { code: error.code, message: error.message },
      });
      return;
    }
    if ((error as { name?: string }).name === 'ZodError') {
      void reply.status(400).send({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'The request payload is invalid' },
      });
      return;
    }

    request.log.error({ err: error, url: request.url }, 'request failed');
    void reply.status(error.statusCode && error.statusCode < 500 ? error.statusCode : 500).send({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error.statusCode && error.statusCode < 500 ? error.message : 'The agent failed to handle that request',
      },
    });
  });

  /* ------------------------------------------------------------ routes -- */

  app.get('/health', async () => {
    const dockerOk = await docker
      .ping()
      .then(() => true)
      .catch(() => false);
    return {
      success: dockerOk,
      data: { status: dockerOk ? 'ok' : 'error', version: STORM_VERSION, docker: dockerOk },
    };
  });

  await app.register(serverRoutes, { prefix: '/api/v1' });
  await registerConsoleSocket(app, env.AGENT_TOKEN_ID, env.AGENT_SECRET);

  /* ------------------------------------------------- panel reporting -- */

  consoleService.on('status', (uuid: string, status: ServerStatus) => {
    void panel.reportStatus(uuid, status);
  });
  /**
   * Disk usage means walking the server directory, which is far too expensive
   * to do on every stats frame, so it is refreshed on a slower cadence and
   * attached to whatever sample is current.
   */
  const diskUsage = new Map<string, { bytes: number; at: number }>();
  const DISK_TTL = 60_000;

  consoleService.on('stats', (uuid: string, stats: Record<string, unknown>) => {
    const cached = diskUsage.get(uuid);
    if (!cached || Date.now() - cached.at > DISK_TTL) {
      void files
        .directorySize(uuid)
        .then((bytes) => diskUsage.set(uuid, { bytes, at: Date.now() }))
        .catch(() => undefined);
    }
    void panel.reportStats(uuid, { ...stats, diskBytes: cached?.bytes ?? 0 });
  });

  const heartbeat = setInterval(() => {
    void (async () => {
      try {
        const containers = await docker.listManaged();
        const servers = await Promise.all(
          containers
            .filter((container) => container.Labels['storm.server.uuid'])
            .map(async (container) => {
              const uuid = container.Labels['storm.server.uuid'] as string;
              return {
                uuid,
                status: await docker.status(uuid),
                containerId: container.Id,
                installing: false,
                exists: true,
              };
            }),
        );

        await panel.heartbeat({
          agentVersion: STORM_VERSION,
          system: await system.info(),
          stats: await system.stats(),
          servers,
        });

        // Re-attach to anything that started outside our control (a node
        // reboot, an agent restart) so consoles keep working.
        for (const server of servers) {
          if (server.status === 'ONLINE') {
            void consoleService.attach(server.uuid).catch(() => undefined);
          }
        }
      } catch (error) {
        app.log.warn({ err: error }, 'heartbeat failed');
      }
    })();
  }, env.HEARTBEAT_INTERVAL * 1000);
  heartbeat.unref();

  /* ------------------------------------------------------------- sftp -- */

  let sftp: SftpService | null = null;
  if (env.SFTP_ENABLED) {
    sftp = new SftpService({
      port: env.SFTP_PORT,
      hostKeyPath: env.SFTP_HOST_KEY_PATH,
      paths,
      panel,
      logger: app.log,
    });
    await sftp.start();
  }

  /* --------------------------------------------------------- lifecycle -- */

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    clearInterval(heartbeat);
    await consoleService.shutdown();
    await sftp?.stop();
    await panel.close();
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await docker.ping().catch((error: unknown) => {
    app.log.error({ err: error, socket: env.DOCKER_SOCKET }, 'cannot reach the Docker daemon');
  });
  await docker.ensureNetwork().catch((error: unknown) => {
    app.log.warn({ err: error }, 'could not ensure the docker network exists');
  });

  await app.listen({ host: env.AGENT_HOST, port: env.AGENT_PORT });
  app.log.info(
    { port: env.AGENT_PORT, sftp: env.SFTP_ENABLED ? env.SFTP_PORT : null, panel: env.PANEL_URL },
    'Storm Node Agent is ready',
  );
}

/**
 * Console socket. The panel authenticates with the same signed-handshake scheme
 * as the REST API — the signature covers the socket path and a timestamp, so a
 * captured upgrade request cannot be replayed later.
 */
async function registerConsoleSocket(
  app: FastifyInstance,
  tokenId: string,
  secret: string,
): Promise<void> {
  app.get<{ Params: { uuid: string } }>(
    '/api/v1/servers/:uuid/ws',
    { websocket: true },
    (socket, request) => {
      const header = request.headers.authorization;
      const timestamp = request.headers['x-storm-timestamp'];
      const signature = request.headers['x-storm-signature'];

      const authorised =
        header === `Bearer ${tokenId}` &&
        typeof timestamp === 'string' &&
        typeof signature === 'string' &&
        verifySignature(
          secret,
          { method: 'GET', path: request.url.split('?')[0] ?? request.url, timestamp, body: '' },
          signature,
        );

      if (!authorised) {
        socket.send(JSON.stringify({ type: 'error', message: 'unauthorised' }));
        socket.close(4401, 'unauthorised');
        return;
      }

      const { uuid } = request.params;
      socket.send(JSON.stringify({ type: 'auth:success', uuid }));

      const onLine = (target: string, line: string, at: string): void => {
        if (target !== uuid || socket.readyState !== socket.OPEN) return;
        socket.send(JSON.stringify({ type: 'console:line', line, timestamp: at }));
      };
      const onStatus = (target: string, status: ServerStatus): void => {
        if (target !== uuid || socket.readyState !== socket.OPEN) return;
        socket.send(JSON.stringify({ type: 'status', status }));
      };
      const onStats = (target: string, stats: unknown): void => {
        if (target !== uuid || socket.readyState !== socket.OPEN) return;
        socket.send(JSON.stringify({ type: 'stats', stats }));
      };

      app.console.on('line', onLine);
      app.console.on('status', onStatus);
      app.console.on('stats', onStats);

      void app.console.attach(uuid).catch(() => undefined);

      socket.on('message', (raw: Buffer) => {
        let message: { type?: string; command?: string; lines?: number };
        try {
          message = JSON.parse(raw.toString()) as typeof message;
        } catch {
          return;
        }

        switch (message.type) {
          case 'logs': {
            const history = app.console.history(uuid);
            if (history.length > 0) {
              socket.send(JSON.stringify({ type: 'console:history', lines: history }));
            } else {
              void app.docker.logs(uuid, message.lines ?? 200).then((lines) => {
                if (socket.readyState === socket.OPEN) {
                  socket.send(JSON.stringify({ type: 'console:history', lines }));
                }
              });
            }
            void app.console.emitCurrentStatus(uuid);
            break;
          }
          case 'command':
            if (typeof message.command === 'string') {
              void app.docker.sendCommand(uuid, message.command).catch((error: unknown) => {
                socket.send(
                  JSON.stringify({
                    type: 'error',
                    message: error instanceof Error ? error.message : 'command failed',
                  }),
                );
              });
            }
            break;
          default:
            break;
        }
      });

      socket.on('close', () => {
        app.console.off('line', onLine);
        app.console.off('status', onStatus);
        app.console.off('stats', onStats);
      });
    },
  );
}

void main();
