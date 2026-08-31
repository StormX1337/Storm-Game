import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Readable } from 'node:stream';
import {
  ServerStatus,
  type AgentServerSpec,
  type AgentBackupRequest,
  type AgentRestoreRequest,
} from '@storm/types';
import { normalizeDisplayPath } from '@storm/security';
import { badRequest, notFound } from '../lib/errors.js';
import { applyConfigFiles } from '../services/config-files.service.js';

const uuidParam = z.object({ uuid: z.string().uuid() });

const limitsSchema = z.object({
  cpuPercent: z.number().int().min(0).max(100000),
  memoryMb: z.number().int().min(64),
  swapMb: z.number().int().min(-1),
  diskMb: z.number().int().min(0),
  ioWeight: z.number().int().min(10).max(1000),
  pidsLimit: z.number().int().min(16).max(65535),
  oomKill: z.boolean(),
});

const specSchema = z.object({
  uuid: z.string().uuid(),
  name: z.string().min(1).max(200),
  image: z.string().min(1).max(255),
  startupCommand: z.string().min(1).max(8000),
  stopCommand: z.string().max(255).default('^C'),
  environment: z.record(z.string().max(16384)).default({}),
  limits: limitsSchema,
  ports: z
    .array(
      z.object({
        ip: z.string().min(3).max(45),
        port: z.number().int().min(1).max(65535),
        containerPort: z.number().int().min(1).max(65535),
        protocol: z.enum(['tcp', 'udp']),
      }),
    )
    .max(32)
    .default([]),
  mounts: z.array(z.unknown()).default([]),
  startupDetection: z.string().max(500).optional(),
  crashDetection: z.string().max(500).optional(),
  configFiles: z
    .array(
      z.object({
        path: z.string().min(1).max(4096),
        parser: z.enum(['properties', 'ini', 'json', 'yaml']),
        find: z.record(z.string().max(4096)).default({}),
      }),
    )
    .max(32)
    .default([]),
  labels: z.record(z.string().max(500)).default({}),
});

const installSchema = z.object({
  uuid: z.string().uuid(),
  container: z.string().min(1).max(255),
  entrypoint: z.string().min(1).max(100),
  script: z.string().max(256 * 1024),
  environment: z.record(z.string().max(16384)).default({}),
  serverImage: z.string().min(1).max(255),
  wipe: z.boolean().default(false),
});

const pathQuery = z.object({ path: z.string().min(1).max(4096) });

/**
 * The agent's control surface. Every route is behind `verifyPanel`, so these
 * are only ever reachable by the panel that holds this node's shared secret.
 */
export default async function serverRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.verifyPanel);

  const ok = <T>(data: T) => ({ success: true as const, data });

  /* ------------------------------------------------------- lifecycle -- */

  app.put('/servers', async (request) => {
    const spec = specSchema.parse(request.body) as AgentServerSpec;

    app.console.registerSpec(spec.uuid, {
      startupDetection: spec.startupDetection,
      crashDetection: spec.crashDetection,
      stopCommand: spec.stopCommand,
      configFiles: spec.configFiles,
    });

    const containerId = await app.docker.createContainer(spec);
    app.log.info({ uuid: spec.uuid }, 'server specification applied');

    return ok({ uuid: spec.uuid, containerId });
  });

  app.get('/servers/:uuid', async (request) => {
    const { uuid } = uuidParam.parse(request.params);
    const info = await app.docker.inspect(uuid);
    return ok({
      uuid,
      exists: info !== null,
      containerId: info?.Id,
      status: await app.docker.status(uuid),
      installing: false,
    });
  });

  app.delete('/servers/:uuid', async (request) => {
    const { uuid } = uuidParam.parse(request.params);

    await app.console.detach(uuid);
    await app.docker.removeContainer(uuid, true);
    await app.files.remove(uuid, ['/']).catch(() => undefined);
    await app.paths.removeRoot(uuid);

    app.log.info({ uuid }, 'server removed from node');
    return ok({ deleted: true });
  });

  app.post('/servers/:uuid/power', async (request) => {
    const { uuid } = uuidParam.parse(request.params);
    const { action } = z
      .object({ action: z.enum(['start', 'stop', 'restart', 'kill']) })
      .parse(request.body);

    const stopCommand = app.console.stopCommandFor(uuid);

    // Rewritten on the way up, never on the way down: the game must not find
    // its port changing underneath a running process.
    if (action === 'start' || action === 'restart') {
      await applyConfigFiles(app.paths.root(uuid), app.console.configFilesFor(uuid), app.log);
    }

    await app.docker.power(uuid, action, stopCommand);

    // Attach as soon as the container is up so the first boot lines are not
    // lost before a browser connects.
    if (action === 'start' || action === 'restart') {
      setTimeout(() => void app.console.attach(uuid).catch(() => undefined), 500);
    }
    void app.console.emitCurrentStatus(uuid);

    return ok({ action, accepted: true });
  });

  app.post('/servers/:uuid/command', async (request) => {
    const { uuid } = uuidParam.parse(request.params);
    const { command } = z.object({ command: z.string().min(1).max(4000) }).parse(request.body);

    await app.docker.sendCommand(uuid, command);
    return ok({ sent: true });
  });

  app.get('/servers/:uuid/stats', async (request) => {
    const { uuid } = uuidParam.parse(request.params);
    const stats = await app.docker.stats(uuid);
    if (!stats) throw notFound('That server has no container on this node', 'SERVER_NOT_FOUND');

    const diskBytes = await app.files.directorySize(uuid).catch(() => 0);
    return ok({ ...stats, diskBytes });
  });

  app.get('/servers/:uuid/logs', async (request) => {
    const { uuid } = uuidParam.parse(request.params);
    const { lines } = z
      .object({ lines: z.coerce.number().int().min(1).max(5000).default(200) })
      .parse(request.query);
    return ok(await app.docker.logs(uuid, lines));
  });

  app.post('/servers/:uuid/install', async (request) => {
    const { uuid } = uuidParam.parse(request.params);
    const input = installSchema.parse(request.body);
    if (input.uuid !== uuid) throw badRequest('The install payload does not match the server');

    if (input.wipe) {
      await app.paths.wipe(uuid);
    }
    await app.paths.ensureRoot(uuid);
    await app.console.detach(uuid);
    await app.docker.removeContainer(uuid, true).catch(() => undefined);

    app.console.broadcast(uuid, '[storm] Starting installation...');
    await app.docker.runInstall(
      uuid,
      {
        container: input.container,
        entrypoint: input.entrypoint,
        script: input.script,
        environment: input.environment,
      },
      (line) => app.console.broadcast(uuid, line),
    );
    app.console.broadcast(uuid, '[storm] Installation finished.');

    return ok({ installed: true });
  });

  /* ------------------------------------------------------------ files -- */

  app.get('/servers/:uuid/files/list', async (request) => {
    const { uuid } = uuidParam.parse(request.params);
    const { path: target } = z
      .object({ path: z.string().max(4096).default('/') })
      .parse(request.query);
    return ok(await app.files.list(uuid, normalizeDisplayPath(target)));
  });

  app.get('/servers/:uuid/files/contents', async (request, reply) => {
    const { uuid } = uuidParam.parse(request.params);
    const { path: target } = pathQuery.parse(request.query);

    const content = await app.files.read(uuid, normalizeDisplayPath(target));
    return reply.header('content-type', 'text/plain; charset=utf-8').send(content);
  });

  app.get('/servers/:uuid/files/download', async (request, reply) => {
    const { uuid } = uuidParam.parse(request.params);
    const { path: target } = pathQuery.parse(request.query);

    const file = await app.files.openStream(uuid, normalizeDisplayPath(target));
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-length', String(file.size))
      .header('content-disposition', `attachment; filename="${file.name}"`)
      .send(file.stream);
  });

  app.get('/servers/:uuid/files/search', async (request) => {
    const { uuid } = uuidParam.parse(request.params);
    const input = z
      .object({ path: z.string().max(4096).default('/'), query: z.string().min(1).max(200) })
      .parse(request.query);
    return ok(await app.files.search(uuid, normalizeDisplayPath(input.path), input.query));
  });

  app.post('/servers/:uuid/files/write', async (request) => {
    const { uuid } = uuidParam.parse(request.params);
    const input = z
      .object({ path: z.string().min(1).max(4096), content: z.string().max(8 * 1024 * 1024) })
      .parse(request.body);

    await app.files.write(uuid, normalizeDisplayPath(input.path), input.content);
    return ok({ written: true });
  });

  app.post('/servers/:uuid/files/upload', async (request) => {
    const { uuid } = uuidParam.parse(request.params);
    const { path: target } = pathQuery.parse(request.query);

    // The panel streams the body straight through; nothing is buffered here.
    const bytes = await app.files.writeStream(
      uuid,
      normalizeDisplayPath(target),
      request.body as Readable,
    );
    return ok({ path: normalizeDisplayPath(target), bytes });
  });

  app.post('/servers/:uuid/files/rename', async (request) => {
    const { uuid } = uuidParam.parse(request.params);
    const input = z
      .object({ from: z.string().min(1).max(4096), to: z.string().min(1).max(4096) })
      .parse(request.body);

    await app.files.rename(uuid, normalizeDisplayPath(input.from), normalizeDisplayPath(input.to));
    return ok({ renamed: true });
  });

  app.post('/servers/:uuid/files/copy', async (request) => {
    const { uuid } = uuidParam.parse(request.params);
    const input = z
      .object({ path: z.string().min(1).max(4096), destination: z.string().max(4096).optional() })
      .parse(request.body);

    const created = await app.files.copy(
      uuid,
      normalizeDisplayPath(input.path),
      input.destination ? normalizeDisplayPath(input.destination) : undefined,
    );
    return ok({ path: created });
  });

  app.post('/servers/:uuid/files/delete', async (request) => {
    const { uuid } = uuidParam.parse(request.params);
    const input = z
      .object({ paths: z.array(z.string().min(1).max(4096)).min(1).max(500) })
      .parse(request.body);

    const removed = await app.files.remove(uuid, input.paths.map(normalizeDisplayPath));
    return ok({ deleted: removed });
  });

  app.post('/servers/:uuid/files/create-directory', async (request) => {
    const { uuid } = uuidParam.parse(request.params);
    const input = z
      .object({ path: z.string().min(1).max(4096), name: z.string().min(1).max(255) })
      .parse(request.body);

    await app.files.createDirectory(uuid, normalizeDisplayPath(input.path), input.name);
    return ok({ created: true });
  });

  app.post('/servers/:uuid/files/compress', async (request) => {
    const { uuid } = uuidParam.parse(request.params);
    const input = z
      .object({
        path: z.string().min(1).max(4096),
        files: z.array(z.string().min(1).max(255)).min(1).max(1000),
        archiveName: z.string().max(255).optional(),
      })
      .parse(request.body);

    const archive = await app.files.compress(
      uuid,
      normalizeDisplayPath(input.path),
      input.files,
      input.archiveName,
    );
    return ok({ archive });
  });

  app.post('/servers/:uuid/files/decompress', async (request) => {
    const { uuid } = uuidParam.parse(request.params);
    const input = z
      .object({ path: z.string().min(1).max(4096), file: z.string().min(1).max(255) })
      .parse(request.body);

    const extracted = await app.files.decompress(
      uuid,
      normalizeDisplayPath(input.path),
      input.file,
    );
    return ok({ extracted });
  });

  app.post('/servers/:uuid/files/chmod', async (request) => {
    const { uuid } = uuidParam.parse(request.params);
    const input = z
      .object({ path: z.string().min(1).max(4096), mode: z.string().regex(/^[0-7]{3,4}$/) })
      .parse(request.body);

    await app.files.chmod(uuid, normalizeDisplayPath(input.path), input.mode);
    return ok({ updated: true });
  });

  /* ---------------------------------------------------------- backups -- */

  app.post('/servers/:uuid/backups', async (request) => {
    const { uuid } = uuidParam.parse(request.params);
    const input = z
      .object({
        uuid: z.string().uuid(),
        backupUuid: z.string().uuid(),
        ignore: z.array(z.string().max(255)).max(200).default([]),
        upload: z
          .object({
            driver: z.enum(['LOCAL', 'S3', 'R2', 'MINIO']),
            url: z.string().url().optional(),
            headers: z.record(z.string()).optional(),
            key: z.string().max(1024),
          })
          .optional(),
      })
      .parse(request.body);

    if (input.uuid !== uuid) throw badRequest('The backup payload does not match the server');
    return ok(await app.backups.create(input as AgentBackupRequest));
  });

  app.post('/servers/:uuid/backups/:backupUuid/restore', async (request) => {
    const { uuid } = uuidParam.parse(request.params);
    const input = z
      .object({
        uuid: z.string().uuid(),
        backupUuid: z.string().uuid(),
        truncate: z.boolean().default(false),
        download: z
          .object({
            driver: z.enum(['LOCAL', 'S3', 'R2', 'MINIO']),
            url: z.string().url().optional(),
            headers: z.record(z.string()).optional(),
            key: z.string().max(1024),
          })
          .optional(),
      })
      .parse(request.body);

    if (input.uuid !== uuid) throw badRequest('The restore payload does not match the server');

    // A restore rewrites files under the container's mount; stop it first.
    await app.docker.power(uuid, 'kill', '^C').catch(() => undefined);
    await app.backups.restore(input as AgentRestoreRequest);

    return ok({ restored: true });
  });

  app.get('/servers/:uuid/backups/:backupUuid/download', async (request, reply) => {
    const params = uuidParam.extend({ backupUuid: z.string().uuid() }).parse(request.params);
    const archive = await app.backups.open(params.uuid, params.backupUuid);

    return reply
      .header('content-type', 'application/gzip')
      .header('content-length', String(archive.size))
      .send(archive.stream);
  });

  app.delete('/servers/:uuid/backups/:backupUuid', async (request) => {
    const params = uuidParam.extend({ backupUuid: z.string().uuid() }).parse(request.params);
    await app.backups.remove(params.uuid, params.backupUuid);
    return ok({ deleted: true });
  });

  /* ----------------------------------------------------------- system -- */

  app.get('/system', async () => ok(await app.system.info()));
  app.get('/system/stats', async () => ok(await app.system.stats()));

  app.get('/servers', async () => {
    const containers = await app.docker.listManaged();
    const states = await Promise.all(
      containers
        .filter((container) => container.Labels['storm.server.uuid'])
        .map(async (container) => {
          const uuid = container.Labels['storm.server.uuid'] as string;
          return {
            uuid,
            status: await app.docker.status(uuid),
            containerId: container.Id,
            installing: false,
            exists: true,
          };
        }),
    );
    return ok(states);
  });
}

export type { ServerStatus };
