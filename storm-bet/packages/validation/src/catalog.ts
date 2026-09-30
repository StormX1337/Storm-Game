import { SPORT_KEYS, TRANSACTION_TYPES } from '@storm-bet/types';
import { z } from 'zod';
import { uuid } from './common';

export const sportKeyParam = z.object({ sport: z.enum(SPORT_KEYS) });
export const idParam = z.object({ id: uuid });

export const eventListQuery = z.object({
  sport: z.enum(SPORT_KEYS).optional(),
  league: uuid.optional(),
  status: z.enum(['live', 'upcoming', 'all']).default('all'),
  /** Only events starting within this many hours (upcoming). */
  withinHours: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 14)
    .optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type EventListQuery = z.infer<typeof eventListQuery>;

export const transactionListQuery = z.object({
  type: z.enum(TRANSACTION_TYPES).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type TransactionListQuery = z.infer<typeof transactionListQuery>;

export const streamQuery = z.object({
  /** Comma-separated: "live", "all", "event:<uuid>" (max 50). */
  topics: z
    .string()
    .max(4_000)
    .default('live')
    .transform((v) =>
      v
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    )
    .pipe(
      z
        .array(z.union([z.enum(['live', 'all']), z.string().regex(/^event:[0-9a-f-]{36}$/i)]))
        .min(1)
        .max(50),
    ),
});

/** Shared bet slip: up to 20 selection ids, comma separated. */
export const sharedSelectionsQuery = z.object({
  ids: z
    .string()
    .max(20 * 37)
    .transform((v) => [...new Set(v.split(',').filter(Boolean))])
    .pipe(z.array(z.string().uuid('Ungültige ID')).min(1).max(20)),
});
