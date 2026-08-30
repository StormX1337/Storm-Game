import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis;
    /** Dedicated connection for pub/sub; ioredis forbids commands on subscribers. */
    redisSubscriber: Redis;
    createRedis(): Redis;
  }
}

export default fp(async function redisPlugin(app: FastifyInstance) {
  const factory = (): Redis =>
    new Redis(app.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: false,
      retryStrategy: (times) => Math.min(times * 200, 5000),
    });

  const redis = factory();
  const subscriber = factory();

  redis.on('error', (error) => app.log.error({ err: error }, 'redis error'));
  subscriber.on('error', (error) => app.log.error({ err: error }, 'redis subscriber error'));

  await Promise.all([redis.ping(), subscriber.ping()]);

  app.decorate('redis', redis);
  app.decorate('redisSubscriber', subscriber);
  app.decorate('createRedis', factory);

  app.addHook('onClose', async () => {
    await Promise.allSettled([redis.quit(), subscriber.quit()]);
  });
}, { name: 'storm-redis' });
