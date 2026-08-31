import { z } from 'zod';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import {
  Permission,
  fileChmodSchema,
  fileCompressSchema,
  fileCopySchema,
  fileCreateDirectorySchema,
  fileDecompressSchema,
  fileDeleteSchema,
  fileListQuerySchema,
  fileRenameSchema,
  fileSearchSchema,
  fileWriteSchema,
  type AgentFileEntry,
} from '@storm/types';
import { normalizeDisplayPath, sanitizeFilename } from '@storm/security';
import { body, params, query } from '../lib/validation.js';
import { ok } from '../lib/response.js';
import { badRequest } from '../lib/errors.js';
import { ServerAccessService } from '../services/server-access.service.js';

const idParam = z.object({ id: z.string().min(1).max(64) });

/**
 * File manager. Every operation is proxied to the node agent, which owns the
 * filesystem and performs the authoritative path validation. The panel
 * normalises paths and enforces permissions before forwarding.
 */
export default async function fileRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  /* ------------------------------------------------------------ read -- */

  app.get(
    '/:id/files/list',
    { schema: { tags: ['Files'], summary: 'List a directory' } },
    async (request) => {
      const user = request.currentUser();
      const { id } = params(request, idParam);
      const q = query(request, fileListQuerySchema);
      const access = await app.serverAccess.require(user, id, Permission.SERVERS_FILES);

      const entries = await app.agents.request<AgentFileEntry[]>(
        access.server.node,
        `/api/v1/servers/${access.server.uuid}/files/list`,
        { query: { path: normalizeDisplayPath(q.path) } },
      );
      return ok({ path: normalizeDisplayPath(q.path), entries });
    },
  );

  app.get(
    '/:id/files/contents',
    { schema: { tags: ['Files'], summary: 'Read a text file' } },
    async (request, reply) => {
      const user = request.currentUser();
      const { id } = params(request, idParam);
      const q = query(request, z.object({ path: z.string().min(1).max(4096) }));
      const access = await app.serverAccess.require(user, id, Permission.SERVERS_FILES);

      const response = await app.agents.rawRequest(
        access.server.node,
        `/api/v1/servers/${access.server.uuid}/files/contents`,
        { query: { path: normalizeDisplayPath(q.path) }, raw: true },
      );

      if (response.statusCode >= 400) {
        const text = await response.body.text();
        return reply.status(response.statusCode).send(text || { success: false });
      }

      void reply.header('content-type', 'text/plain; charset=utf-8');
      return reply.send(response.body);
    },
  );

  app.get(
    '/:id/files/download',
    { schema: { tags: ['Files'], summary: 'Download a file' } },
    async (request, reply) => {
      const user = request.currentUser();
      const { id } = params(request, idParam);
      const q = query(request, z.object({ path: z.string().min(1).max(4096) }));
      const access = await app.serverAccess.require(user, id, Permission.SERVERS_FILES);

      const path = normalizeDisplayPath(q.path);
      const response = await app.agents.rawRequest(
        access.server.node,
        `/api/v1/servers/${access.server.uuid}/files/download`,
        { query: { path }, raw: true, timeoutMs: 0 },
      );

      if (response.statusCode >= 400) {
        const text = await response.body.text();
        return reply.status(response.statusCode).send(text || { success: false });
      }

      await app.audit.activity(request, {
        serverId: access.server.id,
        event: 'file:download',
        metadata: { path },
      });

      void reply
        .header('content-type', 'application/octet-stream')
        .header(
          'content-disposition',
          `attachment; filename="${sanitizeFilename(path.split('/').pop() ?? 'download')}"`,
        );
      if (response.headers['content-length']) {
        void reply.header('content-length', response.headers['content-length']);
      }
      return reply.send(response.body);
    },
  );

  app.get(
    '/:id/files/search',
    { schema: { tags: ['Files'], summary: 'Search for files by name' } },
    async (request) => {
      const user = request.currentUser();
      const { id } = params(request, idParam);
      const q = query(request, fileSearchSchema);
      const access = await app.serverAccess.require(user, id, Permission.SERVERS_FILES);

      const results = await app.agents.request<AgentFileEntry[]>(
        access.server.node,
        `/api/v1/servers/${access.server.uuid}/files/search`,
        { query: { path: normalizeDisplayPath(q.path), query: q.query }, timeoutMs: 30_000 },
      );
      return ok(results);
    },
  );

  /* ----------------------------------------------------------- write -- */

  app.post(
    '/:id/files/write',
    { schema: { tags: ['Files'], summary: 'Create or overwrite a text file' } },
    async (request) => {
      const user = request.currentUser();
      const { id } = params(request, idParam);
      const input = body(request, fileWriteSchema);
      const access = await app.serverAccess.require(user, id, Permission.SERVERS_FILES_WRITE);
      ServerAccessService.assertNotSuspended(access);

      await app.agents.request(
        access.server.node,
        `/api/v1/servers/${access.server.uuid}/files/write`,
        {
          method: 'POST',
          body: { path: normalizeDisplayPath(input.path), content: input.content },
          timeoutMs: 60_000,
        },
      );
      await app.audit.activity(request, {
        serverId: access.server.id,
        event: 'file:write',
        metadata: { path: input.path },
      });

      return ok({ written: true });
    },
  );

  app.post(
    '/:id/files/upload',
    { schema: { tags: ['Files'], summary: 'Upload files' } },
    async (request) => {
      const user = request.currentUser();
      const { id } = params(request, idParam);
      const access = await app.serverAccess.require(user, id, Permission.SERVERS_FILES_WRITE);
      ServerAccessService.assertNotSuspended(access);

      if (!request.isMultipart()) throw badRequest('Send the file as multipart/form-data');

      const uploaded: string[] = [];
      const directory = normalizeDisplayPath(
        typeof (request.query as { path?: string }).path === 'string'
          ? (request.query as { path: string }).path
          : '/',
      );

      for await (const part of request.parts()) {
        if (part.type !== 'file') continue;
        const filename = sanitizeFilename(part.filename);
        const target = `${directory === '/' ? '' : directory}/${filename}`;

        // Streamed straight through to the agent: the panel never buffers the
        // file, so multi-gigabyte uploads cost constant memory here.
        await app.agents.request(
          access.server.node,
          `/api/v1/servers/${access.server.uuid}/files/upload`,
          {
            method: 'POST',
            query: { path: target },
            stream: Readable.from(part.file),
            headers: { 'content-type': 'application/octet-stream' },
            timeoutMs: 0,
          },
        );
        uploaded.push(target);
      }

      if (uploaded.length === 0) throw badRequest('No files were included in the upload');

      await app.audit.activity(request, {
        serverId: access.server.id,
        event: 'file:upload',
        metadata: { files: uploaded },
      });
      return ok({ uploaded });
    },
  );

  app.post('/:id/files/rename', { schema: { tags: ['Files'] } }, async (request) => {
    const user = request.currentUser();
    const { id } = params(request, idParam);
    const input = body(request, fileRenameSchema);
    const access = await app.serverAccess.require(user, id, Permission.SERVERS_FILES_WRITE);
    ServerAccessService.assertNotSuspended(access);

    await app.agents.request(
      access.server.node,
      `/api/v1/servers/${access.server.uuid}/files/rename`,
      {
        method: 'POST',
        body: { from: normalizeDisplayPath(input.from), to: normalizeDisplayPath(input.to) },
      },
    );
    await app.audit.activity(request, {
      serverId: access.server.id,
      event: 'file:rename',
      metadata: { from: input.from, to: input.to },
    });
    return ok({ renamed: true });
  });

  app.post('/:id/files/copy', { schema: { tags: ['Files'] } }, async (request) => {
    const user = request.currentUser();
    const { id } = params(request, idParam);
    const input = body(request, fileCopySchema);
    const access = await app.serverAccess.require(user, id, Permission.SERVERS_FILES_WRITE);
    ServerAccessService.assertNotSuspended(access);

    await app.agents.request(
      access.server.node,
      `/api/v1/servers/${access.server.uuid}/files/copy`,
      {
        method: 'POST',
        body: {
          path: normalizeDisplayPath(input.path),
          destination: input.destination ? normalizeDisplayPath(input.destination) : undefined,
        },
        timeoutMs: 120_000,
      },
    );
    await app.audit.activity(request, {
      serverId: access.server.id,
      event: 'file:copy',
      metadata: { path: input.path },
    });
    return ok({ copied: true });
  });

  app.post('/:id/files/delete', { schema: { tags: ['Files'] } }, async (request) => {
    const user = request.currentUser();
    const { id } = params(request, idParam);
    const input = body(request, fileDeleteSchema);
    const access = await app.serverAccess.require(user, id, Permission.SERVERS_FILES_WRITE);
    ServerAccessService.assertNotSuspended(access);

    await app.agents.request(
      access.server.node,
      `/api/v1/servers/${access.server.uuid}/files/delete`,
      {
        method: 'POST',
        body: { paths: input.paths.map(normalizeDisplayPath) },
        timeoutMs: 120_000,
      },
    );
    await app.audit.activity(request, {
      serverId: access.server.id,
      event: 'file:delete',
      metadata: { paths: input.paths.slice(0, 20), count: input.paths.length },
    });
    return ok({ deleted: input.paths.length });
  });

  app.post('/:id/files/create-directory', { schema: { tags: ['Files'] } }, async (request) => {
    const user = request.currentUser();
    const { id } = params(request, idParam);
    const input = body(request, fileCreateDirectorySchema);
    const access = await app.serverAccess.require(user, id, Permission.SERVERS_FILES_WRITE);
    ServerAccessService.assertNotSuspended(access);

    await app.agents.request(
      access.server.node,
      `/api/v1/servers/${access.server.uuid}/files/create-directory`,
      { method: 'POST', body: { path: normalizeDisplayPath(input.path), name: input.name } },
    );
    await app.audit.activity(request, {
      serverId: access.server.id,
      event: 'file:mkdir',
      metadata: { path: input.path, name: input.name },
    });
    return ok({ created: true });
  });

  app.post(
    '/:id/files/compress',
    { schema: { tags: ['Files'], summary: 'Create a zip archive' } },
    async (request) => {
      const user = request.currentUser();
      const { id } = params(request, idParam);
      const input = body(request, fileCompressSchema);
      const access = await app.serverAccess.require(user, id, Permission.SERVERS_FILES_WRITE);
      ServerAccessService.assertNotSuspended(access);

      const result = await app.agents.request<{ archive: string }>(
        access.server.node,
        `/api/v1/servers/${access.server.uuid}/files/compress`,
        {
          method: 'POST',
          body: {
            path: normalizeDisplayPath(input.path),
            files: input.files.map((file) => sanitizeFilename(file)),
            archiveName: input.archiveName ? sanitizeFilename(input.archiveName) : undefined,
          },
          timeoutMs: 30 * 60_000,
        },
      );
      await app.audit.activity(request, {
        serverId: access.server.id,
        event: 'file:compress',
        metadata: { path: input.path, count: input.files.length },
      });
      return ok(result);
    },
  );

  app.post(
    '/:id/files/decompress',
    { schema: { tags: ['Files'], summary: 'Extract an archive' } },
    async (request) => {
      const user = request.currentUser();
      const { id } = params(request, idParam);
      const input = body(request, fileDecompressSchema);
      const access = await app.serverAccess.require(user, id, Permission.SERVERS_FILES_WRITE);
      ServerAccessService.assertNotSuspended(access);

      await app.agents.request(
        access.server.node,
        `/api/v1/servers/${access.server.uuid}/files/decompress`,
        {
          method: 'POST',
          body: { path: normalizeDisplayPath(input.path), file: sanitizeFilename(input.file) },
          timeoutMs: 30 * 60_000,
        },
      );
      await app.audit.activity(request, {
        serverId: access.server.id,
        event: 'file:decompress',
        metadata: { path: input.path, file: input.file },
      });
      return ok({ extracted: true });
    },
  );

  app.post(
    '/:id/files/chmod',
    { schema: { tags: ['Files'], summary: 'Change file permissions' } },
    async (request) => {
      const user = request.currentUser();
      const { id } = params(request, idParam);
      const input = body(request, fileChmodSchema);
      const access = await app.serverAccess.require(user, id, Permission.SERVERS_FILES_WRITE);
      ServerAccessService.assertNotSuspended(access);

      await app.agents.request(
        access.server.node,
        `/api/v1/servers/${access.server.uuid}/files/chmod`,
        {
          method: 'POST',
          body: { path: normalizeDisplayPath(input.path), mode: input.mode },
        },
      );
      await app.audit.activity(request, {
        serverId: access.server.id,
        event: 'file:chmod',
        metadata: { path: input.path, mode: input.mode },
      });
      return ok({ updated: true });
    },
  );
}
