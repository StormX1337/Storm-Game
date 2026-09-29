import {
  getWallet,
  toTransactionDto,
  toWalletDto,
  topUpDemoWallet,
  TRANSACTION_INCLUDE,
} from '@storm-bet/betting-engine';
import { moneyToNumber, recordAudit, withTransaction } from '@storm-bet/database';
import { transactionListQuery } from '@storm-bet/validation';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { cursorArgs, page } from '../lib/pagination';
import { parse } from '../lib/validate';
import { authenticated, requireSession } from '../plugins/auth';
import { enforceRateLimit, RATE_LIMITS } from '../plugins/rate-limit';
import { actorOf } from './request-info';

export function walletRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    app.addHook('preHandler', authenticated);

    app.get('/wallet', async (request) => getWallet(ctx.db, requireSession(request).userId));

    app.post('/wallet/top-up', async (request, reply) => {
      const session = requireSession(request);
      await enforceRateLimit(ctx.redis, RATE_LIMITS.topUp, session.userId, reply);
      const actor = actorOf(request, ctx.env.AUDIT_LOG_IP);
      const result = await withTransaction(ctx.db, async (tx) => {
        const r = await topUpDemoWallet(tx, session.userId, ctx.demoWallet, ctx.now());
        await recordAudit(tx, actor, {
          action: 'wallet.demo_top_up',
          targetType: 'wallet',
          targetId: r.wallet.id,
          metadata: { amount: moneyToNumber(r.credited) },
        });
        return r;
      });
      return { wallet: toWalletDto(result.wallet), credited: moneyToNumber(result.credited) };
    });

    app.get('/transactions', async (request) => {
      const session = requireSession(request);
      const query = parse(transactionListQuery, request.query);
      const rows = await ctx.db.transaction.findMany({
        where: { userId: session.userId, ...(query.type ? { type: query.type } : {}) },
        include: TRANSACTION_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...cursorArgs(query.cursor, query.limit),
      });
      return page(rows, query.limit, toTransactionDto);
    });
  };
}
