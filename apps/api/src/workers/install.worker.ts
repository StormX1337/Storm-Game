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
      await runInstall(app, job.data, job.attemptsMade, job.opts.attempts ?? 1);
    },
    { connection: { url: app.env.REDIS_URL }, concurrency: concurrency(app, 4) },
  );
}

/**
 * Exported so a test can drive one attempt directly; the worker is its only
 * caller.
 *
 * `attemptsMade` counts the attempts *before* this one, and `attempts` is what
 * the job was queued with. The pair decides how loudly a failure is reported:
 * a run that is going to be retried says nothing, because the customer being
 * told "installation failed" while the panel is quietly having another go is
 * both wrong and dangerous — the reinstall button unlocks on INSTALL_FAILED,
 * so the retry and the reinstall it invites end up in the same directory.
 */
export async function runInstall(
  app: FastifyInstance,
  data: InstallJobData,
  attemptsMade = 0,
  attempts = 1,
): Promise<void> {
  const { serverId, startOnCompletion, reinstall, wipe } = data;
  const server = await app.servers.findWithRelations(serverId);
  const isFinalAttempt = attemptsMade + 1 >= attempts;

  // Stamped per attempt, not per job: housekeeping uses it to tell an install
  // that is still running from one whose worker went away mid-run.
  await app.prisma.server.update({
    where: { id: serverId },
    data: { installStartedAt: new Date() },
  });
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
    const message = error instanceof Error ? error.message : String(error);
    app.log.error(
      { err: error, serverId, attempt: attemptsMade + 1 },
      'server installation failed',
    );

    // A retry is still coming: leave the status where it is so the panel keeps
    // showing "installing", and rethrow to let the queue schedule it.
    if (!isFinalAttempt) throw error;

    await app.servers.updateStatus(serverId, ServerStatus.INSTALL_FAILED);
    await app.audit.system({
      action: 'server.install_failed',
      targetType: 'server',
      targetId: serverId,
      targetLabel: server.name,
      metadata: { error: message, attempts: attemptsMade + 1 },
    });
    await app.notifications.push(server.ownerId, {
      type: NotificationType.SERVER_CRASHED,
      title: 'Installation failed',
      message: `${server.name} could not be installed. Check the install output and try again.`,
      level: 'ERROR',
      link: `/servers/${server.shortId}`,
    });
    // Operators watching a fleet find out from their own tooling rather than
    // from the customer, who is the only one the panel told before this.
    await app.webhooks.dispatch(WebhookEvent.SERVER_INSTALL_FAILED, {
      serverId,
      uuid: server.uuid,
      name: server.name,
      error: message,
    });
    throw error;
  }
}
