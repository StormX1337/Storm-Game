import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { AgentClient } from '../services/agent-client.js';

export default fp(
  async function agentsPlugin(app: FastifyInstance) {
    const client = new AgentClient(app);
    app.decorate('agents', client);
    app.addHook('onClose', async () => {
      await client.close();
    });
  },
  { name: 'storm-agents', dependencies: ['storm-env', 'storm-prisma'] },
);
