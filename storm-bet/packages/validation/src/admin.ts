import {
  BET_STATUSES,
  EVENT_STATUSES,
  MARKET_TYPES,
  SPORT_KEYS,
  USER_ROLES,
  USER_STATUSES,
  isSupportedLine,
} from '@storm-bet/types';
import { z } from 'zod';
import { decimalOdds, isoDate, moneyMinor, trimmed, uuid } from './common';
import { eventStatisticsSchema } from './statistics';
import { LIMIT_TYPES } from '@storm-bet/types';

const reason = trimmed(3, 500, 'Begründung');

export const adminUserListQuery = z.object({
  q: z.string().trim().max(120).optional(),
  role: z.enum(USER_ROLES).optional(),
  status: z.enum(USER_STATUSES).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const adminSetRoleSchema = z.object({
  role: z.enum(USER_ROLES),
  /** Role changes are step-up actions: the acting admin re-enters their password. */
  confirmPassword: z.string().min(1, 'Bitte bestätige mit deinem Passwort'),
  reason,
});

export const adminLockSchema = z.object({ reason });
export const adminUnlockSchema = z.object({ reason });

export const adminSetLimitSchema = z.object({
  type: z.enum(LIMIT_TYPES),
  amount: moneyMinor.nullable(),
  reason,
});

export const adminEventListQuery = z.object({
  q: z.string().trim().max(120).optional(),
  sport: z.enum(SPORT_KEYS).optional(),
  status: z.enum(EVENT_STATUSES).optional(),
  provider: z.string().max(40).optional(),
  awaitingSettlement: z.enum(['true', 'false']).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const line = z.number().refine(isSupportedLine, 'Linie muss ganz- oder halbzahlig sein');

export const adminMarketInput = z.object({
  type: z.enum(MARKET_TYPES),
  line: line.nullable().default(null),
  selections: z
    .array(
      z.object({
        outcome: z.string().min(1).max(20),
        odds: decimalOdds,
        playerId: uuid.optional(),
        name: z.string().trim().max(80).optional(),
      }),
    )
    .min(2)
    .max(40),
});

export const adminCreateEventSchema = z
  .object({
    sport: z.enum(SPORT_KEYS),
    leagueId: uuid,
    homeTeamId: uuid,
    awayTeamId: uuid,
    startTime: isoDate,
    markets: z.array(adminMarketInput).min(1).max(30),
  })
  .refine((v) => v.homeTeamId !== v.awayTeamId, {
    message: 'Heim- und Auswärtsteam müssen verschieden sein',
    path: ['awayTeamId'],
  });
export type AdminCreateEventInput = z.infer<typeof adminCreateEventSchema>;

export const adminUpdateEventSchema = z.object({
  startTime: isoDate.optional(),
  reason,
});

export const EVENT_ACTIONS = [
  'activate',
  'deactivate',
  'suspend',
  'resume',
  'start',
  'cancel',
  'postpone',
] as const;
export const adminEventActionSchema = z.object({
  action: z.enum(EVENT_ACTIONS),
  reason,
});

export const adminEventResultSchema = z.object({
  statistics: eventStatisticsSchema,
  reason,
});

export const MARKET_ACTIONS = ['open', 'suspend', 'close'] as const;
export const adminMarketActionSchema = z.object({
  action: z.enum(MARKET_ACTIONS),
  reason,
});

export const adminSelectionUpdateSchema = z
  .object({
    odds: decimalOdds.optional(),
    status: z.enum(['OPEN', 'SUSPENDED', 'CLOSED']).optional(),
    reason,
  })
  .refine((v) => v.odds !== undefined || v.status !== undefined, 'Nichts zu ändern');

export const adminBetListQuery = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(BET_STATUSES).optional(),
  userId: uuid.optional(),
  eventId: uuid.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const adminVoidBetSchema = z.object({ reason });

export const adminTransactionListQuery = z.object({
  userId: uuid.optional(),
  betId: uuid.optional(),
  type: z.string().max(20).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const adminAuditListQuery = z.object({
  action: z.string().trim().max(80).optional(),
  actorId: uuid.optional(),
  targetType: z.string().trim().max(40).optional(),
  targetId: z.string().trim().max(80).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
