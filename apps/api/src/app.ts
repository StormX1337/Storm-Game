import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { randomUUID } from 'node:crypto';
import type { ApiEnv } from '@storm/config';
import { STORM_VERSION } from '@storm/config';

import envPlugin from './plugins/env.js';
import prismaPlugin from './plugins/prisma.js';
import redisPlugin from './plugins/redis.js';
import securityPlugin from './plugins/security.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import settingsPlugin from './plugins/settings.js';
import authPlugin from './plugins/auth.js';
import maintenancePlugin from './plugins/maintenance.js';
import auditPlugin from './plugins/audit.js';
import eventsPlugin from './plugins/events.js';
import queuesPlugin from './plugins/queues.js';
import agentsPlugin from './plugins/agents.js';
import storagePlugin from './services/storage.service.js';
import mailPlugin from './services/mail.service.js';
import webhookPlugin from './services/webhook.service.js';
import databaseProvisionerPlugin from './services/database-provisioner.js';

import { ServerService } from './services/server.service.js';
import { UpdateService } from './services/update.service.js';
import { ServerAccessService } from './services/server-access.service.js';
import { PluginRegistryService } from './services/plugin-registry.service.js';
import { ModpackRegistryService } from './services/modpack-registry.service.js';

import healthRoutes from './routes/health.routes.js';
import authRoutes from './routes/auth.routes.js';
import settingsRoutes from './routes/settings.routes.js';
import pluginRoutes from './routes/plugins.routes.js';
import modpackRoutes from './routes/modpacks.routes.js';
import playerRoutes from './routes/players.routes.js';
import accountRoutes from './routes/account.routes.js';
import dashboardRoutes from './routes/dashboard.routes.js';
import serverRoutes from './routes/servers.routes.js';
import fileRoutes from './routes/files.routes.js';
import backupRoutes from './routes/backups.routes.js';
import scheduleRoutes from './routes/schedules.routes.js';
import serverDatabaseRoutes from './routes/databases.routes.js';
import internalRoutes from './routes/internal.routes.js';
import installRoutes from './routes/install.routes.js';
import adminUserRoutes from './routes/admin/users.routes.js';
import adminNodeRoutes from './routes/admin/nodes.routes.js';
import adminTemplateRoutes from './routes/admin/templates.routes.js';
import adminSystemRoutes from './routes/admin/system.routes.js';
import adminServerRoutes from './routes/admin/servers.routes.js';

import { registerServerSocket } from './ws/server-socket.js';
import { registerAccountSocket } from './ws/account-socket.js';

export interface BuildOptions {
  env?: ApiEnv;
  logger?: boolean;
  /** Register the rate limiter. Tests turn it off so suites do not throttle. */
  rateLimit?: boolean;
}

/**
 * Assembles the Fastify instance. Kept separate from `main.ts` so tests can
 * build an app against a throwaway database without binding a port.
 */
export async function buildApp(options: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: process.env.LOG_LEVEL ?? 'info',
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'res.headers["set-cookie"]',
                'body.password',
                'body.newPassword',
                'body.currentPassword',
                'body.token',
              ],
              censor: '[redacted]',
            },
            transport:
              process.env.NODE_ENV === 'development'
                ? { target: 'pino/file', options: { destination: 1 } }
                : undefined,
          },
    genReqId: () => randomUUID(),
    trustProxy: true,
    bodyLimit: 12 * 1024 * 1024,
    disableRequestLogging: false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });

  /**
   * Zod owns request validation (see `lib/validation.ts`), so the schemas
   * attached to routes are documentation only. Handing AJV a pass-through
   * compiler keeps one validator in charge and one error shape on the wire.
   */
  app.setValidatorCompiler(() => (data) => ({ value: data }));

  /* ------------------------------------------------------------ core -- */

  await app.register(envPlugin, options.env ? { env: options.env } : {});
  await app.register(sensible);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(settingsPlugin);
  await app.register(securityPlugin, { rateLimit: options.rateLimit !== false });
  await app.register(errorHandlerPlugin);
  await app.register(eventsPlugin);
  await app.register(auditPlugin);
  await app.register(queuesPlugin);
  await app.register(mailPlugin);
  await app.register(storagePlugin);
  await app.register(webhookPlugin);
  await app.register(databaseProvisionerPlugin);
  await app.register(agentsPlugin);
  await app.register(authPlugin);
  // After auth: the guard needs to know who is asking before it turns them away.
  await app.register(maintenancePlugin);

  await app.register(multipart, {
    limits: {
      fileSize: app.env.UPLOAD_MAX_BYTES,
      files: 25,
      fieldSize: 1024 * 1024,
    },
  });

  await app.register(websocket, {
    options: { maxPayload: 1024 * 1024, clientTracking: true },
  });

  app.decorate('servers', new ServerService(app));
  app.decorate('updates', new UpdateService(app));
  app.decorate('serverAccess', new ServerAccessService(app));
  app.decorate('plugins', new PluginRegistryService(app));
  app.decorate('modpacks', new ModpackRegistryService(app));

  /* --------------------------------------------------------- swagger -- */

  if (app.env.ENABLE_SWAGGER) {
    await app.register(swagger, {
      openapi: {
        openapi: '3.1.0',
        info: {
          title: 'Storm Panel API',
          version: STORM_VERSION,
          description:
            'REST API for the Storm Panel game server control panel.\n\n' +
            'Authenticate with a session cookie (browser) or `Authorization: Bearer storm_<keyId>.<secret>` (API key).\n\n' +
            'Every response is wrapped in `{ success, data }`; failures return `{ success: false, error: { code, message } }`.',
        },
        servers: [{ url: app.env.APP_URL }],
        components: {
          securitySchemes: {
            bearerAuth: { type: 'http', scheme: 'bearer', description: 'Personal API key' },
            cookieAuth: { type: 'apiKey', in: 'cookie', name: 'storm_access' },
          },
        },
        tags: [
          { name: 'Authentication', description: 'Sign in, sign out, password and email flows' },
          { name: 'Account', description: 'Profile, sessions, 2FA, API keys and notifications' },
          { name: 'Dashboard', description: 'Aggregated customer metrics' },
          { name: 'Servers', description: 'Server lifecycle and power control' },
          { name: 'Files', description: 'Server file manager' },
          { name: 'Backups', description: 'Backup creation, restoration and retention' },
          { name: 'Schedules', description: 'Cron-style automation' },
          { name: 'Databases', description: 'Customer database provisioning' },
          { name: 'Nodes', description: 'Node discovery for customers' },
          { name: 'Templates', description: 'Game templates' },
          { name: 'Admin', description: 'Panel administration' },
          { name: 'Admin: Users', description: 'User administration' },
          { name: 'Admin: Nodes', description: 'Node administration' },
          { name: 'Admin: Allocations', description: 'IP and port administration' },
          { name: 'Admin: Templates', description: 'Game template administration' },
          { name: 'System', description: 'Health and readiness' },
        ],
      },
    });

    await app.register(swaggerUi, {
      routePrefix: '/api/docs',
      uiConfig: { docExpansion: 'list', deepLinking: true, persistAuthorization: true },
      staticCSP: true,
    });
  }

  /* ---------------------------------------------------------- routes -- */

  await app.register(healthRoutes);

  const prefix = `${app.env.API_PREFIX}/v1`;
  await app.register(settingsRoutes, { prefix });
  await app.register(authRoutes, { prefix: `${prefix}/auth` });
  await app.register(accountRoutes, { prefix: `${prefix}/account` });
  await app.register(dashboardRoutes, { prefix });
  await app.register(serverRoutes, { prefix: `${prefix}/servers` });
  await app.register(fileRoutes, { prefix: `${prefix}/servers` });
  await app.register(backupRoutes, { prefix: `${prefix}/servers` });
  await app.register(scheduleRoutes, { prefix: `${prefix}/servers` });
  await app.register(serverDatabaseRoutes, { prefix: `${prefix}/servers` });
  await app.register(pluginRoutes, { prefix: `${prefix}/servers` });
  await app.register(modpackRoutes, { prefix: `${prefix}/servers` });
  await app.register(playerRoutes, { prefix: `${prefix}/servers` });
  await app.register(adminUserRoutes, { prefix: `${prefix}/admin/users` });
  await app.register(adminNodeRoutes, { prefix: `${prefix}/admin/nodes` });
  await app.register(adminTemplateRoutes, { prefix: `${prefix}/admin/templates` });
  await app.register(adminServerRoutes, { prefix: `${prefix}/admin/servers` });
  await app.register(adminSystemRoutes, { prefix: `${prefix}/admin` });
  await app.register(internalRoutes, { prefix: `${prefix}/internal` });

  // Served from the root, not the API prefix: a node bootstraps with
  // `curl <panel>/install/node.sh` before it knows anything about versions.
  await app.register(installRoutes);

  await app.register(
    async (scope) => {
      await registerServerSocket(scope);
      await registerAccountSocket(scope);
    },
    { prefix },
  );

  app.addHook('onSend', async (request, reply) => {
    void reply.header('x-request-id', request.id);
  });

  return app;
}
