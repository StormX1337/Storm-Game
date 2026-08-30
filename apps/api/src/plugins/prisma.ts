import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { createPrismaClient, type PrismaClient } from '@storm/database';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

export default fp(async function prismaPlugin(app: FastifyInstance) {
  const prisma = createPrismaClient({
    databaseUrl: app.env.DATABASE_URL,
    logQueries: app.env.LOG_LEVEL === 'trace',
  });

  await prisma.$connect();
  app.decorate('prisma', prisma);
  app.addHook('onClose', async () => {
    await prisma.$disconnect();
  });
}, { name: 'storm-prisma' });
