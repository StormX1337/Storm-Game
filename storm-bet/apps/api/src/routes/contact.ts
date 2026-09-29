import { recordAudit, SYSTEM_ACTOR } from '@storm-bet/database';
import { contactSchema } from '@storm-bet/validation';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { parse } from '../lib/validate';
import { enforceRateLimit, RATE_LIMITS } from '../plugins/rate-limit';

export function contactRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    app.post('/contact', async (request, reply) => {
      await enforceRateLimit(ctx.redis, RATE_LIMITS.contact, request.ip, reply);
      const input = parse(contactSchema, request.body);
      await ctx.mailer.send({
        to: ctx.env.SUPPORT_EMAIL,
        subject: `[Kontakt] ${input.subject}`,
        text: `Von: ${input.name} <${input.email}>\n\n${input.message}`,
      });
      await recordAudit(
        ctx.db,
        {
          ...SYSTEM_ACTOR,
          id: request.session?.userId ?? null,
          role: request.session?.role ?? null,
        },
        {
          action: 'contact.submitted',
          targetType: 'contact',
          metadata: { subject: input.subject },
        },
      );
      reply.status(202);
      return { ok: true };
    });
  };
}
