import { Worker } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { QUEUE_NAMES } from '@storm/config';
import { NotificationType, ServerStatus, WebhookEvent, type AgentInstallSpec } from '@storm/types';
import type { InstallJobData } from '../plugins/queues.js';
import { concurrency } from './concurrency.js';

/**
 * Runs a server installation on its node: pushes the container spec, executes
 * the template's install script inside a throwaway container, then marks the
 * server installed and optionally boots it.
 */
export function createInstallWorker(app: FastifyInstance): Worker<InstallJobData> {
  return new Worker<InstallJobData>(
    QUEUE_NAMES.installs,
    async (job) => {
      const { serverId, startOnCompletion, reinstall, wipe } = job.data;
      const server = await app.servers.findWithRelations(serverId);

      await app.servers.updateStatus(
        serverId,
        reinstall ? ServerStatus.REINSTALLING : ServerStatus.INSTALLING,
      );

      try {
        const spec = await app.servers.buildAgentSpec(serverId);
        await app.agents.request(server.node, '/api/v1/servers', {
          method: 'PUT',
          body: spec,
          timeoutMs: 60_000,
        });

        const installSpec: AgentInstallSpec = {
          uuid: server.uuid,
          container: server.template?.installContainer ?? 'debian:bookworm-slim',
          entrypoint: server.template?.installEntrypoint ?? 'bash',
          script: server.template?.installScript ?? '#!/bin/bash\ntrue\n',
          environment: spec.environment,
          serverImage: server.dockerImage,
        };

        await app.agents.request(server.node, `/api/v1/servers/${server.uuid}/install`, {
          method: 'POST',
          body: { ...installSpec, wipe: Boolean(wipe) },
          // Steam-based installs routinely take longer than an hour.
          timeoutMs: 3 * 3600_000,
        });

        // The install step tears the container down so the script cannot touch a
        // live one, so the spec has to be re-applied before the server can boot.
        await app.agents.request(server.node, '/api/v1/servers', {
          method: 'PUT',
          body: spec,
          timeoutMs: 60_000,
        });

        await app.prisma.server.update({
          where: { id: serverId },
          data: { installedAt: new Date(), status: ServerStatus.OFFLINE },
        });
        await app.servers.updateStatus(serverId, ServerStatus.OFFLINE);

        await app.audit.system({
          action: reinstall ? 'server.reinstalled' : 'server.installed',
          targetType: 'server',
          targetId: serverId,
          targetLabel: server.name,
        });
        await app.notifications.push(server.ownerId, {
          type: NotificationType.SERVER_INSTALLED,
          title: 'Server ready',
          message: `${server.name} finished installing and is ready to start.`,
          level: 'SUCCESS',
          link: `/servers/${server.shortId}`,
        });
        await app.webhooks.dispatch(WebhookEvent.SERVER_INSTALLED, {
          serverId,
          uuid: server.uuid,
          name: server.name,
        });

        if (startOnCompletion) {
          await app.servers.sendPower(serverId, 'start').catch((error: unknown) => {
            app.log.warn({ err: error, serverId }, 'auto-start after install failed');
          });
        }
      } catch (error) {
        app.log.error({ err: error, serverId }, 'server installation failed');
        await app.servers.updateStatus(serverId, ServerStatus.INSTALL_FAILED);
        await app.audit.system({
          action: 'server.install_failed',
          targetType: 'server',
          targetId: serverId,
          targetLabel: server.name,
          metadata: { error: error instanceof Error ? error.message : String(error) },
        });
        await app.notifications.push(server.ownerId, {
          type: NotificationType.SERVER_CRASHED,
          title: 'Installation failed',
          message: `${server.name} could not be installed. Check the install output and try again.`,
          level: 'ERROR',
          link: `/servers/${server.shortId}`,
        });
        throw error;
      }
    },
    { connection: { url: app.env.REDIS_URL }, concurrency: concurrency(app, 4) },
  );
}
