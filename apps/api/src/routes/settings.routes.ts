import type { FastifyInstance } from 'fastify';
import { publicSettings } from '@storm/database';
import { ok } from '../lib/response.js';

/**
 * The settings a browser needs before it has a session.
 *
 * The login page has to render the panel's own name and colour, know whether
 * registration is open, and be able to say why it is refusing to work when
 * maintenance is on — all of which happens before anyone has signed in. Only
 * the keys marked public are returned; how the panel is *run* (default limits,
 * retention, SMTP) stays behind the admin API.
 */
export default async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/settings',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        tags: ['System'],
        summary: 'Panel branding and sign-in policy',
        description: 'Public settings. No authentication required.',
      },
    },
    async () => ok(publicSettings(await app.settings.read())),
  );
}
