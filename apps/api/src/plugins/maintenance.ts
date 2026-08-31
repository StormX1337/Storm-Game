import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ErrorCode, Permission } from '@storm/types';
import { AppError } from '../lib/errors.js';
import type { AuthenticatedUser } from './auth.js';

/** Who keeps working through maintenance: whoever can reach the admin area. */
function bypassesMaintenance(user: AuthenticatedUser): boolean {
  return user.role === 'OWNER' || user.permissions.has(Permission.ADMIN_DASHBOARD);
}

export default fp(
  async function maintenancePlugin(app: FastifyInstance) {
    const api = `${app.env.API_PREFIX}/v1`;

    /**
     * Paths that keep answering while the panel is in maintenance.
     *
     * Each one is here so an administrator can still get in and turn
     * maintenance back off, and so the parts of the platform that are not "a
     * customer using the panel" keep running while they do:
     *
     * - the health probes, or an orchestrator drains the API mid-maintenance;
     * - the whole auth surface, refresh included. Locking sign-in would lock
     *   the administrator out of the switch they came to flip, and letting
     *   access tokens expire would sign everyone out instead of showing them
     *   the notice;
     * - the node callbacks, because servers keep running and their state has
     *   to keep arriving — otherwise the panel comes back with a wrong picture
     *   of the world;
     * - the public settings endpoint, which is how a browser learns that
     *   maintenance is *why* it is being turned away;
     * - the node bootstrap script, so a node being installed is not the
     *   casualty of maintenance being switched on halfway through.
     */
    const exemptPrefixes = [
      '/health',
      '/ready',
      '/api/health',
      '/install/',
      '/docs',
      `${api}/auth/`,
      `${api}/internal/`,
    ];
    const exemptExact = [`${api}/settings`];

    // Registered after the auth plugin, so `request.user` is already resolved
    // by the time this runs and the check knows who is asking.
    app.addHook('onRequest', async (request: FastifyRequest) => {
      const path = request.url.split('?')[0] ?? '';
      if (exemptExact.includes(path)) return;
      if (exemptPrefixes.some((prefix) => path === prefix || path.startsWith(prefix))) return;

      const settings = await app.settings.read();
      if (!settings.maintenanceMode) return;
      if (request.user && bypassesMaintenance(request.user)) return;

      throw new AppError(
        503,
        ErrorCode.MAINTENANCE_MODE,
        settings.maintenanceMessage || 'The panel is undergoing maintenance.',
      );
    });
  },
  { name: 'storm-maintenance', dependencies: ['storm-env', 'storm-settings', 'storm-auth'] },
);
