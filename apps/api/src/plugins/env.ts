import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { loadApiEnv, type ApiEnv } from '@storm/config';
import { Encrypter } from '@storm/security';

declare module 'fastify' {
  interface FastifyInstance {
    env: ApiEnv;
    encrypter: Encrypter;
  }
}

export default fp(async function envPlugin(app: FastifyInstance, opts: { env?: ApiEnv }) {
  const env = opts.env ?? loadApiEnv();
  app.decorate('env', env);
  app.decorate('encrypter', new Encrypter(env.ENCRYPTION_KEY));
}, { name: 'storm-env' });
