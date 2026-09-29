import { PROVIDER_INFO, isSimulatedProvider } from '@storm-bet/odds-engine';
import type { PlatformMetaDto } from '@storm-bet/types';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';

export function healthRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    app.get('/health', async () => ({ status: 'ok', time: ctx.now().toISOString() }));

    /** Public facts the UI needs for its notices: play money only, and where odds come from. */
    app.get('/meta', async (): Promise<PlatformMetaDto> => {
      const key = ctx.env.ODDS_PROVIDER;
      return {
        realMoney: false,
        odds: {
          provider: key,
          name: PROVIDER_INFO[key]?.name ?? key,
          isSimulated: isSimulatedProvider(key),
        },
      };
    });

    app.get('/health/ready', async (_request, reply) => {
      const checks = await Promise.allSettled([ctx.db.$queryRaw`SELECT 1`, ctx.redis.ping()]);
      const ok = checks.every((c) => c.status === 'fulfilled');
      reply.status(ok ? 200 : 503);
      return {
        status: ok ? 'ok' : 'unavailable',
        database: checks[0].status === 'fulfilled',
        redis: checks[1].status === 'fulfilled',
      };
    });
  };
}
