import {
  CASINO_GAME_STATUSES,
  CASINO_ROUND_STATUSES,
  CASINO_SESSION_STATUSES,
} from '@storm-bet/types';
import { z } from 'zod';
import { paginationQuery, positiveMoneyMinor, uuid } from './common';

export const casinoGameParam = z.object({ gameId: uuid });

export const casinoGamesQuery = z.object({
  category: z.string().trim().max(40).optional(),
  search: z.string().trim().max(60).optional(),
});

const rouletteBet = z
  .object({
    type: z.enum(['straight', 'red', 'black', 'odd', 'even', 'low', 'high', 'dozen', 'column']),
    value: z.number().int().min(0).max(36).optional(),
    stake: positiveMoneyMinor,
  })
  .strict();

const baccaratBet = z
  .object({ side: z.enum(['player', 'banker', 'tie']), stake: positiveMoneyMinor })
  .strict();

/** What a client may send for a round. Outcomes are never part of a request. */
export const casinoPlaySchema = z
  .object({
    sessionId: uuid,
    idempotencyKey: uuid,
    action: z.enum(['spin', 'deal', 'hit', 'stand', 'double']),
    stake: positiveMoneyMinor.optional(),
    bets: z.array(rouletteBet).min(1).max(20).optional(),
    sides: z.array(baccaratBet).min(1).max(3).optional(),
    roundId: uuid.optional(),
    step: z.number().int().min(0).max(50).optional(),
  })
  .strict();

export const casinoHistoryQuery = paginationQuery.extend({
  gameId: uuid.optional(),
  status: z.enum(CASINO_ROUND_STATUSES).optional(),
});

// ─── admin ─────────────────────────────────────────────────────────────────

const reason = z.string().trim().min(3, 'Begründung angeben').max(300);

export const adminCasinoGameUpdateSchema = z
  .object({
    status: z.enum(CASINO_GAME_STATUSES).optional(),
    isFeatured: z.boolean().optional(),
    isNew: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(100_000).optional(),
    categories: z.array(z.string().trim().min(1).max(40)).min(1).max(6).optional(),
    minStake: positiveMoneyMinor.optional(),
    maxStake: positiveMoneyMinor.optional(),
    reason,
  })
  .strict();

export const adminCasinoCategoryUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(40).optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
    isActive: z.boolean().optional(),
    reason,
  })
  .strict();

export const adminCasinoProviderUpdateSchema = z.object({ isActive: z.boolean(), reason }).strict();

export const adminCasinoReasonSchema = z.object({ reason }).strict();

export const adminCasinoSessionsQuery = paginationQuery.extend({
  status: z.enum(CASINO_SESSION_STATUSES).optional(),
  userId: uuid.optional(),
});

export const adminCasinoRoundsQuery = paginationQuery.extend({
  status: z.enum(CASINO_ROUND_STATUSES).optional(),
  userId: uuid.optional(),
  gameId: uuid.optional(),
});

export const casinoKeyParam = z.object({ key: z.string().trim().min(1).max(40) });
