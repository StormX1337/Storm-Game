import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { readSettings, type PanelSettings } from '@storm/database';

declare module 'fastify' {
  interface FastifyInstance {
    settings: SettingsCache;
  }
}

export interface SettingsCache {
  /** Panel settings, from a short-lived cache. */
  read: () => Promise<PanelSettings>;
  /** Drops the cache so the next read sees a write that just happened. */
  invalidate: () => void;
}

/**
 * How long a cached copy is served. Maintenance mode is checked on every
 * authenticated request, so reading the table each time would add a query to
 * every call in the panel. Five seconds keeps that at one query per instance
 * per five seconds, and also bounds how long a second API replica can keep
 * serving a stale copy of a setting the first one changed — it has no way of
 * hearing about that write otherwise.
 */
const TTL_MS = 5_000;

export default fp(
  async function settingsPlugin(app: FastifyInstance) {
    let cached: PanelSettings | null = null;
    let cachedAt = 0;
    let inFlight: Promise<PanelSettings> | null = null;

    const cache: SettingsCache = {
      read: async () => {
        if (cached && Date.now() - cachedAt < TTL_MS) return cached;
        // Coalesce concurrent misses: a dashboard opening fires several
        // requests at once, and they should share one query rather than
        // race each other into the table.
        inFlight ??= readSettings(app.prisma)
          .then((settings) => {
            cached = settings;
            cachedAt = Date.now();
            return settings;
          })
          .finally(() => {
            inFlight = null;
          });
        return inFlight;
      },
      invalidate: () => {
        cached = null;
        cachedAt = 0;
      },
    };

    app.decorate('settings', cache);
  },
  { name: 'storm-settings', dependencies: ['storm-prisma'] },
);
