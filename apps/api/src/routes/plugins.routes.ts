import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { Permission, TemplateFeature } from '@storm/types';
import { sanitizeFilename } from '@storm/security';
import { body, params, query } from '../lib/validation.js';
import { ok } from '../lib/response.js';
import { badRequest, notFound } from '../lib/errors.js';
import { ServerAccessService } from '../services/server-access.service.js';
import { MAX_PLUGIN_BYTES } from '../services/plugin-registry.service.js';
import type { ServerAccess } from '../services/server-access.service.js';

const idParam = z.object({ id: z.string().min(1).max(64) });

/** Where a Paper or Spigot server loads its plugins from. */
const PLUGIN_DIRECTORY = '/plugins';

/**
 * Browsing and installing Minecraft plugins.
 *
 * Whether a server gets this at all is the template's decision, not a name
 * match: a template carrying the `plugins` feature has it, everything else
 * gets 404. That keeps an operator's own Minecraft template working and stops
 * the browser appearing on a Rust server, and it is enforced here rather than
 * only hidden in the panel — a customer calling the endpoint directly gets the
 * same answer as one who cannot see the tab.
 */
export default async function pluginRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  /** Resolves the server and refuses if plugins are not its business. */
  async function requirePluginServer(
    request: Parameters<typeof app.authenticate>[0],
    permission: string,
  ): Promise<ServerAccess> {
    const user = request.currentUser();
    const { id } = params(request, idParam);
    const access = await app.serverAccess.require(user, id, permission);

    const features = (access.server.template?.features ?? []) as string[];
    if (!features.includes(TemplateFeature.PLUGINS)) {
      // 404 rather than 403: the endpoint does not exist for this server, and
      // saying "forbidden" would imply it might for someone else.
      throw notFound('This server does not use plugins');
    }
    return access;
  }

  /* --------------------------------------------------------- browsing -- */

  app.get(
    '/:id/plugins/search',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: { tags: ['Plugins'], summary: 'Search the plugin registry' },
    },
    async (request) => {
      await requirePluginServer(request, Permission.SERVERS_FILES);
      const q = query(
        request,
        z.object({
          q: z.string().trim().max(120).default(''),
          gameVersion: z
            .string()
            .trim()
            .regex(/^[0-9][0-9.]{0,15}$/, 'Use a Minecraft version like 1.21.4')
            .optional(),
        }),
      );

      return ok(await app.plugins.search(q.q, q.gameVersion));
    },
  );

  app.get(
    '/:id/plugins/:projectId/versions',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: { tags: ['Plugins'], summary: 'Downloadable builds of a plugin' },
    },
    async (request) => {
      await requirePluginServer(request, Permission.SERVERS_FILES);
      const { projectId } = params(
        request,
        idParam.extend({ projectId: z.string().min(1).max(64) }),
      );
      const q = query(
        request,
        z.object({
          gameVersion: z
            .string()
            .trim()
            .regex(/^[0-9][0-9.]{0,15}$/)
            .optional(),
        }),
      );

      return ok(await app.plugins.versions(projectId, q.gameVersion));
    },
  );

  /* -------------------------------------------------------- installed -- */

  app.get(
    '/:id/plugins',
    { schema: { tags: ['Plugins'], summary: 'Plugins installed on this server' } },
    async (request) => {
      const access = await requirePluginServer(request, Permission.SERVERS_FILES);

      const entries = await app.agents
        .request<{ entries: { name: string; size: number; modifiedAt: string }[] }>(
          access.server.node,
          `/api/v1/servers/${access.server.uuid}/files/list`,
          { query: { path: PLUGIN_DIRECTORY } },
        )
        // No plugins directory yet is not an error — it appears on first start.
        .catch(() => ({ entries: [] }));

      return ok(
        entries.entries
          .filter((entry) => entry.name.toLowerCase().endsWith('.jar'))
          .map((entry) => ({
            filename: entry.name,
            bytes: entry.size,
            modifiedAt: entry.modifiedAt,
          })),
      );
    },
  );

  app.post(
    '/:id/plugins',
    {
      config: { rateLimit: { max: 20, timeWindow: '5 minutes' } },
      schema: { tags: ['Plugins'], summary: 'Install a plugin' },
    },
    async (request) => {
      const access = await requirePluginServer(request, Permission.SERVERS_FILES_WRITE);
      ServerAccessService.assertNotSuspended(access);
      // A plugin is a file, and a server at its disk limit does not get more.
      await app.servers.assertDiskWithinLimit(access.server);

      // The only thing the caller chooses. Where those bytes come from is
      // resolved from the registry and checked here, never sent by a browser.
      const input = body(request, z.object({ versionId: z.string().min(1).max(64) }));
      const download = await app.plugins.resolveDownload(input.versionId);

      // Two ceilings, and the lower one wins: a sanity cap on what counts as a
      // plugin at all, and what this server may still add. Only the first was
      // being applied, so a customer sitting at their disk limit could still
      // pull a quarter of a gigabyte through this door.
      const remaining = await app.servers.remainingDiskBytes(access.server);
      const budget = remaining === null ? MAX_PLUGIN_BYTES : Math.min(MAX_PLUGIN_BYTES, remaining);

      const result = await app.agents.request<{ bytes: number; sha512: string }>(
        access.server.node,
        `/api/v1/servers/${access.server.uuid}/files/fetch`,
        {
          method: 'POST',
          body: {
            url: download.url,
            path: `${PLUGIN_DIRECTORY}/${download.filename}`,
            sha512: download.sha512,
            maxBytes: budget,
          },
          timeoutMs: 15 * 60_000,
        },
      );

      await app.audit.activity(request, {
        serverId: access.server.id,
        event: 'plugin:installed',
        metadata: { filename: download.filename, versionId: input.versionId },
      });

      return ok({
        filename: download.filename,
        bytes: result.bytes,
        message: 'Installed. Restart the server for it to load.',
      });
    },
  );

  app.delete(
    '/:id/plugins/:filename',
    { schema: { tags: ['Plugins'], summary: 'Remove an installed plugin' } },
    async (request) => {
      const access = await requirePluginServer(request, Permission.SERVERS_FILES_WRITE);
      ServerAccessService.assertNotSuspended(access);

      const { filename } = params(
        request,
        idParam.extend({ filename: z.string().min(1).max(255) }),
      );
      // Sanitised rather than trusted: this becomes a path on the node, and a
      // name is not a place to put `..` in.
      const clean = sanitizeFilename(decodeURIComponent(filename));
      if (!clean.toLowerCase().endsWith('.jar')) {
        throw badRequest('Only plugin jars can be removed here');
      }

      await app.agents.request(
        access.server.node,
        `/api/v1/servers/${access.server.uuid}/files/delete`,
        { method: 'POST', body: { paths: [`${PLUGIN_DIRECTORY}/${clean}`] } },
      );

      await app.audit.activity(request, {
        serverId: access.server.id,
        event: 'plugin:removed',
        metadata: { filename: clean },
      });

      return ok({ removed: clean, message: 'Removed. Restart the server to unload it.' });
    },
  );
}
